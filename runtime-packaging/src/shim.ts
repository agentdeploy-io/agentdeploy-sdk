/**
 * AgentDeploy Supervisor Shim — Supervisor Protocol v1 (RUNTIME_CONTRACT.md).
 *
 * One generic HTTP service that makes ANY agent framework contract-compliant
 * via a RuntimeAdapter. Runs inside the runtime container on $PORT (default
 * 8080); Fly's health check + platform calls land here.
 *
 * Boot: restore checkpoints → fetch broker secrets → start server-style
 * frameworks → begin heartbeats.
 */
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { spawn, ChildProcess } from "node:child_process";
import { getAdapter } from "./adapter-types.js";
import "./adapters/index.js";
import { checkpoint, restoreAllAtBoot, enforceCheckpointCap } from "./checkpoint-engine.js";
import { fetchSecrets, sendHeartbeat, sendTelemetry, isPlatformConfigured } from "./platform-client.js";

const PORT = Number(process.env["PORT"] || 8080);
const HEARTBEAT_MS = Number(process.env["HEARTBEAT_INTERVAL_MS"] || 30_000);
const TASK_TIMEOUT_MS = Number(process.env["TASK_TIMEOUT_MS"] || 3_600_000);
const RUNTIME_NAME = process.env["RUNTIME_NAME"] || "unknown";

interface ShimTask {
  id: string;
  taskType: string;
  state: string;
  transitions: Array<{ from: string | null; to: string; at: string }>;
  budgetTokens?: number;
  tokensUsed: number;
  process?: ChildProcess;
  outputTail: string;
  startedAt?: number;
}

const tasks = new Map<string, ShimTask>();
let seq = 0;

function nowIso(): string {
  return new Date().toISOString();
}

function transition(task: ShimTask, to: ShimTask["state"]): void {
  if (["succeeded", "failed", "cancelled", "expired"].includes(task.state) && to !== task.state) return;
  task.transitions.push({ from: task.state, to, at: nowIso() });
  task.state = to;
  sendTelemetry([
    {
      eventType: "task_transition",
      taskId: task.id,
      idempotencyKey: `${task.id}:transition:${task.transitions.length}`,
      payload: { to, at: nowIso(), runtimeTaskId: task.id },
    },
  ]);
}

// ── Task execution ───────────────────────────────────────────────────────────

async function runCliTask(
  taskId: string,
  commandTemplate: string[],
  input: Record<string, unknown>,
  secrets: Record<string, string>,
  secretEnvMapping: Record<string, string>
): Promise<void> {
  const task = tasks.get(taskId)!;

  // Build env: framework config + mapped broker secrets only.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [brokerKey, envKey] of Object.entries(secretEnvMapping)) {
    if (secrets[brokerKey]) env[envKey] = secrets[brokerKey];
  }

  const prompt =
    typeof input["prompt"] === "string"
      ? (input["prompt"] as string)
      : JSON.stringify(input);

  const argv = commandTemplate.map((arg) =>
    arg === "{prompt}" ? prompt : arg
  );

  const child = spawn(argv[0]!, argv.slice(1), {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  task.process = child;
  transition(task, "running");

  const tail = (chunk: Buffer) => {
    task.outputTail = (task.outputTail + chunk.toString()).slice(-4000);
  };
  child.stdout?.on("data", tail);
  child.stderr?.on("data", tail);

  const timeout = setTimeout(() => {
    transition(task, "expired");
    child.kill("SIGTERM");
  }, TASK_TIMEOUT_MS);

  child.on("close", (code) => {
    clearTimeout(timeout);
    void enforceCheckpointCap(taskId);
    void checkpoint(taskId, []).catch(() => {});
    if (task.state === "expired") return;
    if (task.state === "cancelled") return;
    // Interpret via adapter (registered by name in the runner).
    const adapter = getAdapter(RUNTIME_NAME);
    const outcome = adapter.interpretExit?.(code ?? -1, task.outputTail) ?? {
      state: code === 0 ? "succeeded" : "failed",
    };
    if (outcome.tokensUsed) task.tokensUsed += outcome.tokensUsed;
    transition(task, outcome.state);
    if (outcome.error) task.outputTail += `\n${outcome.error}`;
  });
}

async function runServerDelegate(
  taskId: string,
  delegate: (payload: { taskId: string; taskType: string; input: Record<string, unknown>; secrets: Record<string, string> }) => Promise<{ state: string; tokensUsed?: number; error?: string }>,
  payload: { taskId: string; taskType: string; input: Record<string, unknown>; secrets: Record<string, string> }
): Promise<void> {
  const task = tasks.get(taskId)!;
  transition(task, "running");
  try {
    const outcome = await delegate(payload);
    if (outcome.tokensUsed) task.tokensUsed += outcome.tokensUsed;
    if (outcome.state !== "running") transition(task, outcome.state as ShimTask["state"]);
    if (outcome.error) task.outputTail += `\n${outcome.error}`;
  } catch (error) {
    transition(task, "failed");
    task.outputTail += `\n${error instanceof Error ? error.message : String(error)}`;
  }
}

// ── HTTP surface (Supervisor Protocol v1) ────────────────────────────────────

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(text);
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;
  const adapter = getAdapter(RUNTIME_NAME);

  // R1 health
  if (req.method === "GET" && p === "/health") {
    return json(res, 200, { status: "ok", runtime: RUNTIME_NAME });
  }

  // R1/R2 status
  if (req.method === "GET" && p === "/status") {
    return json(res, 200, {
      phase: tasks.size > 0 ? "busy" : "idle",
      cpuPct: null,
      memMb: process.memoryUsage().rss / (1024 * 1024),
      tasks: [...tasks.values()].map((t) => ({
        id: t.id,
        state: t.state,
        taskType: t.taskType,
        transitions: t.transitions,
        budgetUsed: { tokens: t.tokensUsed },
      })),
    });
  }

  // R1/R6 enqueue
  if (req.method === "POST" && p === "/tasks") {
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: { taskType?: string; payload?: Record<string, unknown>; budget?: { tokens?: number } };
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!parsed.taskType) return json(res, 400, { error: "taskType required" });

    seq += 1;
    const taskId = `${RUNTIME_NAME}-task-${seq}`;
    const task: ShimTask = {
      id: taskId,
      taskType: parsed.taskType,
      state: "queued",
      transitions: [{ from: null, to: "queued", at: nowIso() }],
      budgetTokens: parsed.budget?.tokens,
      tokensUsed: 0,
      outputTail: "",
    };
    tasks.set(taskId, task);

    const input = parsed.payload ?? {};
    const secrets = await fetchSecrets();

    if (adapter.invocation === "cli") {
      void runCliTask(taskId, adapter.command, input, secrets, adapter.secretEnvMapping);
      return json(res, 202, { taskId, state: "queued" }, );
    }

    // server style
    if (adapter.delegateTask) {
      void runServerDelegate(taskId, adapter.delegateTask.bind(adapter), {
        taskId,
        taskType: parsed.taskType,
        input,
        secrets,
      });
    } else {
      transition(task, "running"); // buyer drives via framework UI
    }
    return json(res, 202, { taskId, state: task.state });
  }

  // R1 detail
  const taskMatch = p.match(/^\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const task = tasks.get(decodeURIComponent(taskMatch[1]!));
    if (!task) return json(res, 404, { error: "not found" });
    return json(res, 200, {
      id: task.id,
      state: task.state,
      taskType: task.taskType,
      transitions: task.transitions,
      budgetUsed: { tokens: task.tokensUsed },
      outputTail: task.outputTail.slice(-1000),
    });
  }

  // R5 cancel
  const cancelMatch = p.match(/^\/tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const task = tasks.get(decodeURIComponent(cancelMatch[1]!));
    if (!task) return json(res, 404, { error: "not found" });
    transition(task, "cancelled");
    task.process?.kill("SIGTERM");
    setTimeout(() => task.process?.kill("SIGKILL"), 10_000).unref();
    return json(res, 202, { id: task.id, state: task.state });
  }

  // R4 force checkpoint
  if (req.method === "POST" && p === "/checkpoint") {
    if (adapter.checkpointPaths.length === 0) {
      return json(res, 202, { checkpointed: [] });
    }
    try {
      const saved = await checkpoint(`manual-${Date.now()}`, adapter.checkpointPaths);
      return json(res, 202, { checkpointed: saved });
    } catch (error) {
      // No volume mounted (local dev) → report degraded, not a hard failure.
      return json(res, 503, {
        error: error instanceof Error ? error.message : String(error),
        hint: "checkpoint storage unavailable — is the /data volume mounted?",
      });
    }
  }

  return json(res, 404, { error: `no route: ${req.method} ${p}` });
}

// ── Boot ─────────────────────────────────────────────────────────────────────

async function boot(): Promise<void> {
  console.log(`[shim] starting runtime "${RUNTIME_NAME}"`);
  const adapter = getAdapter(RUNTIME_NAME);

  // 1. Restore prior checkpoints (VM recreation path).
  await restoreAllAtBoot(adapter.checkpointPaths).catch((e) =>
    console.error("[shim] boot restore failed:", e)
  );

  // 2. Fetch broker secrets into memory only.
  const secrets = isPlatformConfigured()
    ? await fetchSecrets()
    : (() => {
        console.log("[shim] platform not configured — running without broker secrets (local dev)");
        return {} as Record<string, string>;
      })();

  // 3. Boot server-style frameworks with their expected env.
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [brokerKey, envKey] of Object.entries(adapter.secretEnvMapping)) {
    if (secrets[brokerKey]) env[envKey] = secrets[brokerKey];
  }
  if (adapter.extraEnv) Object.assign(env, adapter.extraEnv);

  if (adapter.invocation === "server" && adapter.command.length > 0) {
    console.log("[shim] launching framework:", adapter.command.join(" "));
    const child = spawn(adapter.command[0]!, adapter.command.slice(1), {
      env,
      stdio: "inherit",
    });
    child.on("exit", (code) => {
      console.error(`[shim] framework exited ${code} — exiting shim so Fly restarts the machine`);
      process.exit(1);
    });
  }

  // 4. Heartbeat loop.
  setInterval(() => {
    sendHeartbeat({ phase: tasks.size > 0 ? "busy" : "idle" });
  }, HEARTBEAT_MS).unref();

  const server = createServer((req, res) => {
    void handle(req, res).catch((error) => {
      console.error("[shim] handler error:", error);
      json(res, 500, { error: "internal" });
    });
  });
  server.listen(PORT, () => {
    console.log(`[shim] listening on :${PORT} (runtime=${RUNTIME_NAME})`);
  });
}

void boot().catch((error) => {
  console.error("[shim] boot failed:", error);
  process.exit(1);
});
