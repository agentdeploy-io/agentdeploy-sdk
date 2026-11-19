/**
 * Supervisor Protocol v1 — task ledger and state machine for the bi-core
 * BYO runtime (docs/sellers/byo-runtime.md §2–3, conformance C1–C7).
 *
 * Pure module (no HTTP): server.ts adapts the results to status codes.
 *
 *   queued → running → awaiting_input → resumed → succeeded
 *                ↘ failed        ↘ cancelled      ↗
 *                ↘ expired (budget exhausted)
 *   queued/running → checkpointed (durable, resumable)
 *
 * Rules honored here (mirrors deployment-service/src/services/__tests__/
 * mock-runtime.ts, the platform's reference implementation):
 *   - transitions are append-only with monotonic (non-decreasing) timestamps
 *   - terminal states (succeeded|failed|cancelled|expired) never change again
 *   - checkpoints are written to ${DATA_DIR}/checkpoints/<taskId>.json with a
 *     manifest { schemaVersion, taskId, stateVector, createdAt } + snapshot
 *   - the full ledger persists to ${DATA_DIR}/supervisor-ledger.json so a
 *     VM restart can serve GET /tasks/{id} and POST /tasks/{id}/resume
 *   - budget fence: warning at 90% of budget.tokens, checkpoint+expired at 100%
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export type TaskState =
  | "queued"
  | "running"
  | "awaiting_input"
  | "checkpointed"
  | "resumed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export const TERMINAL_STATES: readonly TaskState[] = ["succeeded", "failed", "cancelled", "expired"];

export interface Transition {
  from: TaskState | null;
  to: TaskState;
  at: string; // ISO; monotonic per task
}

export interface TaskBudget {
  vmMinutes?: number;
  tokens?: number;
}

export interface SupervisorTask {
  id: string;
  taskType: string;
  payload: Record<string, unknown>;
  state: TaskState;
  transitions: Transition[];
  budget: TaskBudget;
  budgetUsed: { tokens: number };
  maxRuntimeSec?: number;
  createdAt: string;
  startedAt: string; // alias of createdAt (legacy /status shape)
  finishedAt?: string;
  result?: unknown;
  error?: string;
  checkpointCount: number;
}

export class InvalidTaskError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(reason);
    this.reason = reason;
  }
}

export class NoCheckpointError extends Error {}
export class TerminalTaskError extends Error {}

export interface CheckpointEvent {
  taskId: string;
  at: string;
}

export interface ProtocolOptions {
  /** Where checkpoints + the ledger persist (defaults to DATA_DIR). */
  /** Checkpoint/ledger root. Platform mounts a volume at /data. */
  dataDir?: string;
  /** Telemetry sink — every transition + checkpoint is emitted here. */
  emit?: (event: {
    taskId: string;
    from: TaskState | null;
    to: TaskState;
    at: string;
    kind: "task_transition" | "checkpoint";
  }) => void;
  /** Injectable clock (tests). */
  now?: () => Date;
  /** Injectable id generator (tests). */
  nextId?: () => string;
}

const CHECKPOINT_SCHEMA_VERSION = 1;
/** Never allow a checkpoint blob to exceed the 512MB platform cap. */
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024;

function isoNow(now: () => Date, floorMs?: number): string {
  const t = Math.max(now().getTime(), floorMs ?? 0);
  return new Date(t).toISOString();
}

export class SupervisorLedger {
  readonly tasks = new Map<string, SupervisorTask>();
  private readonly dataDir: string;
  private readonly checkpointsDir: string;
  private readonly ledgerPath: string;
  private readonly emit?: ProtocolOptions["emit"];
  private readonly now: () => Date;
  private readonly nextId: () => string;

  constructor(opts: ProtocolOptions = {}) {
    // Platform VMs mount a volume at /data; local dev uses DATA_DIR. If the
    // configured dir is not writable (e.g. no /data on a laptop), fall back
    // to a temp dir so the server still boots (checkpoints non-durable).
    let dir = (opts.dataDir ?? process.env["DATA_DIR"] ?? "/data").trim() || "/data";
    try {
      fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
    } catch {
      dir = path.join(os.tmpdir(), `bi-core-supervisor-${process.pid}`);
      console.error(`[supervisor] dataDir "${opts.dataDir ?? process.env["DATA_DIR"] ?? "/data"}" not writable; falling back to ${dir} (checkpoints non-durable)`);
      try {
        fs.mkdirSync(path.join(dir, "checkpoints"), { recursive: true });
      } catch {
        /* in-memory only */
      }
    }
    this.dataDir = dir;
    this.checkpointsDir = path.join(this.dataDir, "checkpoints");
    this.ledgerPath = path.join(this.dataDir, "supervisor-ledger.json");
    this.emit = opts.emit;
    this.now = opts.now ?? (() => new Date());
    this.nextId = opts.nextId ?? (() => `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  }

  // ── lifecycle ──────────────────────────────────────────────────────────

  getTask(id: string): SupervisorTask | undefined {
    return this.tasks.get(id);
  }

  listTasks(): SupervisorTask[] {
    return [...this.tasks.values()];
  }

  activeCount(): number {
    return [...this.tasks.values()].filter((t) => !TERMINAL_STATES.includes(t.state)).length;
  }

  /** Strict validation + enqueue. Throws InvalidTaskError → 400. */
  createTask(body: unknown, explicitId?: string): SupervisorTask {
    if (body === null || typeof body !== "object" || Array.isArray(body)) {
      throw new InvalidTaskError("body must be a JSON object");
    }
    const b = body as Record<string, unknown>;
    if (typeof b.taskType !== "string" || b.taskType.trim() === "") {
      throw new InvalidTaskError("taskType required");
    }
    if (b.payload !== undefined && (typeof b.payload !== "object" || b.payload === null || Array.isArray(b.payload))) {
      throw new InvalidTaskError("payload must be an object");
    }
    if (b.maxRuntimeSec !== undefined && (typeof b.maxRuntimeSec !== "number" || !Number.isFinite(b.maxRuntimeSec) || b.maxRuntimeSec <= 0)) {
      throw new InvalidTaskError("maxRuntimeSec must be a positive number");
    }
    if (b.budget !== undefined) {
      const budget = b.budget;
      if (typeof budget !== "object" || budget === null || Array.isArray(budget)) {
        throw new InvalidTaskError("budget must be an object");
      }
      const bb = budget as Record<string, unknown>;
      for (const k of ["vmMinutes", "tokens"] as const) {
        if (bb[k] !== undefined && (typeof bb[k] !== "number" || !Number.isFinite(bb[k] as number) || (bb[k] as number) < 0)) {
          throw new InvalidTaskError(`budget.${k} must be a non-negative number`);
        }
      }
    }

    const id = explicitId ?? this.nextId();
    if (this.tasks.has(id)) throw new InvalidTaskError(`duplicate task id ${id}`);
    const at = isoNow(this.now);
    const budget: TaskBudget = {};
    const bb = (b.budget ?? {}) as Record<string, unknown>;
    if (typeof bb.vmMinutes === "number") budget.vmMinutes = bb.vmMinutes;
    if (typeof bb.tokens === "number") budget.tokens = bb.tokens;

    const task: SupervisorTask = {
      id,
      taskType: b.taskType.trim(),
      payload: (b.payload ?? {}) as Record<string, unknown>,
      state: "queued",
      transitions: [{ from: null, to: "queued", at }],
      budget,
      budgetUsed: { tokens: 0 },
      maxRuntimeSec: typeof b.maxRuntimeSec === "number" ? b.maxRuntimeSec : undefined,
      createdAt: at,
      startedAt: at,
      checkpointCount: 0,
    };
    this.tasks.set(id, task);
    // The initial {from: null → queued} entry is a transition too: every
    // transition must reach the control plane (R9 telemetry).
    this.emit?.({ taskId: id, from: null, to: "queued", at, kind: "task_transition" });
    this.persist();
    return task;
  }

  /** Append-only transition with monotonic timestamps (R2). Throws on illegal moves. */
  transition(task: SupervisorTask, to: TaskState): Transition {
    if (TERMINAL_STATES.includes(task.state) && to !== task.state) {
      throw new TerminalTaskError(`illegal transition from terminal ${task.state} to ${to}`);
    }
    const last = task.transitions[task.transitions.length - 1];
    const at = isoNow(this.now, last ? Date.parse(last.at) : undefined);
    const tr: Transition = { from: task.state, to, at };
    task.transitions.push(tr);
    task.state = to;
    if (TERMINAL_STATES.includes(to)) task.finishedAt = at;
    this.emit?.({ taskId: task.id, from: tr.from, to, at, kind: "task_transition" });
    this.persist();
    return tr;
  }

  markRunning(id: string): SupervisorTask {
    const task = this.tasks.get(id);
    if (!task) throw new TerminalTaskError(`no such task ${id}`);
    if (task.state !== "queued" && task.state !== "resumed") {
      // Already running / elsewhere: no-op so double-starts are harmless.
      return task;
    }
    this.transition(task, "running");
    return task;
  }

  succeed(id: string, result: unknown): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (TERMINAL_STATES.includes(task.state)) return false; // cancelled/expired wins
    task.result = result;
    this.transition(task, "succeeded");
    return true;
  }

  fail(id: string, error: string): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;
    if (TERMINAL_STATES.includes(task.state)) return false;
    task.error = error;
    this.transition(task, "failed");
    return true;
  }

  /** C5: cancel → terminal `cancelled` (immediately; the platform allows 60s). */
  cancel(id: string): SupervisorTask {
    const task = this.tasks.get(id);
    if (!task) throw new TerminalTaskError(`no such task ${id}`);
    if (TERMINAL_STATES.includes(task.state)) return task; // already terminal — idempotent
    this.transition(task, "cancelled");
    return task;
  }

  requestAwaitingInput(id: string): SupervisorTask {
    const task = this.tasks.get(id);
    if (!task) throw new TerminalTaskError(`no such task ${id}`);
    if (task.state !== "running") return task;
    this.transition(task, "awaiting_input");
    // The platform may stop the VM while awaiting: persist a checkpoint blob
    // WITHOUT leaving the awaiting_input state (the platform watches for it).
    this.writeCheckpoint(task, { moveState: false });
    return task;
  }

  /** R4: resume requires a checkpoint (else 409 via NoCheckpointError). */
  resume(id: string): SupervisorTask {
    const task = this.tasks.get(id);
    if (!task) throw new TerminalTaskError(`no such task ${id}`);
    if (TERMINAL_STATES.includes(task.state)) return task;
    if (!this.hasCheckpoint(id)) throw new NoCheckpointError(`no checkpoint for task ${id}`);
    // Restore the last committed state vector, then resume.
    const snapshot = this.readCheckpoint(task);
    if (snapshot) {
      if (Array.isArray(snapshot.transitions) && snapshot.transitions.length >= task.transitions.length) {
        task.transitions = snapshot.transitions as Transition[];
      }
      if (snapshot.budgetUsed) task.budgetUsed = snapshot.budgetUsed as { tokens: number };
      if (typeof snapshot.payload === "object" && snapshot.payload !== null) task.payload = snapshot.payload as Record<string, unknown>;
    }
    this.transition(task, "resumed");
    return task;
  }

  // ── checkpoints (R4) ───────────────────────────────────────────────────

  hasCheckpoint(id: string): boolean {
    return fs.existsSync(this.checkpointPath(id));
  }

  checkpointPath(id: string): string {
    return path.join(this.checkpointsDir, `${id}.json`);
  }

  /**
   * Checkpoint one task. Returns the blob size, or 0 when terminal.
   * moveState=false keeps the current state (e.g. awaiting_input) and only
   * writes the durable blob + bumps checkpointCount.
   */
  writeCheckpoint(task: SupervisorTask, opts: { moveState?: boolean } = {}): number {
    if (TERMINAL_STATES.includes(task.state)) return 0;
    const moveState = opts.moveState !== false && task.state !== "awaiting_input" && task.state !== "checkpointed";
    const blob = JSON.stringify({
      schemaVersion: CHECKPOINT_SCHEMA_VERSION,
      taskId: task.id,
      stateVector: task.state,
      createdAt: this.now().toISOString(),
      task: {
        taskType: task.taskType,
        payload: task.payload,
        budget: task.budget,
        budgetUsed: task.budgetUsed,
        maxRuntimeSec: task.maxRuntimeSec,
        createdAt: task.createdAt,
        checkpointCount: task.checkpointCount,
        transitions: task.transitions,
      },
    });
    if (Buffer.byteLength(blob, "utf8") > MAX_CHECKPOINT_BYTES) {
      throw new Error(`checkpoint for ${task.id} exceeds 512MB cap`);
    }
    fs.writeFileSync(this.checkpointPath(task.id), blob, "utf8");
    task.checkpointCount += 1;
    if (moveState) this.transition(task, "checkpointed");
    this.emit?.({ taskId: task.id, from: null, to: task.state, at: this.now().toISOString(), kind: "checkpoint" });
    this.persist();
    return Buffer.byteLength(blob, "utf8");
  }

  private readCheckpoint(task: SupervisorTask): Record<string, unknown> | null {
    try {
      const raw = fs.readFileSync(this.checkpointPath(task.id), "utf8");
      const parsed = JSON.parse(raw) as { task?: Record<string, unknown> };
      return parsed.task ?? null;
    } catch {
      return null;
    }
  }

  /** POST /checkpoint — every non-terminal task. Returns the checkpointed ids. */
  checkpointAll(): string[] {
    const done: string[] = [];
    for (const task of this.tasks.values()) {
      if (TERMINAL_STATES.includes(task.state)) continue;
      this.writeCheckpoint(task);
      done.push(task.id);
    }
    return done;
  }

  // ── budget fence ───────────────────────────────────────────────────────

  /**
   * Record token usage for a task and enforce the fence:
   *   ≥90% of budget.tokens → "warn" (emits a warning),
   *   ≥100% → checkpoint + terminal `expired` → "expired".
   */
  recordUsage(id: string, tokens: number): "ok" | "warn" | "expired" {
    const task = this.tasks.get(id);
    if (!task || !Number.isFinite(tokens) || tokens <= 0) return "ok";
    if (TERMINAL_STATES.includes(task.state)) return "ok"; // terminal is final
    task.budgetUsed.tokens += Math.round(tokens);
    this.persist();
    const limit = task.budget?.tokens;
    if (!limit || limit <= 0) return "ok";
    const pct = (task.budgetUsed.tokens / limit) * 100;
    if (pct >= 100) {
      if (!TERMINAL_STATES.includes(task.state)) {
        this.writeCheckpoint(task); // must checkpoint before entering expired
        this.transition(task, "expired");
        this.emit?.({
          taskId: task.id,
          from: null,
          to: "expired",
          at: this.now().toISOString(),
          kind: "task_transition",
        });
      }
      return "expired";
    }
    if (pct >= 90) return "warn";
    return "ok";
  }

  /** Pre-step fence check (no new tokens added) — before each expensive step. */
  enforceFence(id: string): "ok" | "warn" | "expired" {
    const task = this.tasks.get(id);
    if (!task) return "ok";
    const limit = task.budget?.tokens;
    if (!limit || limit <= 0 || TERMINAL_STATES.includes(task.state)) return "ok";
    const pct = (task.budgetUsed.tokens / limit) * 100;
    if (pct >= 100) {
      this.writeCheckpoint(task); // must checkpoint before entering expired
      this.transition(task, "expired");
      return "expired";
    }
    if (pct >= 90) return "warn";
    return "ok";
  }

  // ── persistence (VM-restart survival) ──────────────────────────────────

  /** Restore the ledger after a restart. Missing file → empty ledger. */
  load(): number {
    try {
      const raw = fs.readFileSync(this.ledgerPath, "utf8");
      const parsed = JSON.parse(raw) as { tasks?: SupervisorTask[] };
      for (const t of parsed.tasks ?? []) {
        if (t && typeof t.id === "string" && Array.isArray(t.transitions)) this.tasks.set(t.id, t);
      }
      return this.tasks.size;
    } catch {
      return 0;
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.ledgerPath, JSON.stringify({ tasks: [...this.tasks.values()] }), "utf8");
    } catch (e) {
      // Persistence is best-effort; in-memory stays authoritative for this boot.
      console.error(`[supervisor] ledger persist failed: ${e instanceof Error ? e.message : e}`);
    }
  }
}
