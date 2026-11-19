import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  SupervisorLedger,
  InvalidTaskError,
  NoCheckpointError,
  TerminalTaskError,
  TERMINAL_STATES,
  type SupervisorTask,
  type ProtocolOptions,
} from "../supervisor/protocol.js";
import { ControlPlane, controlPlaneFromEnv } from "../supervisor/control-plane.js";

/**
 * Supervisor Protocol v1 conformance (docs/sellers/byo-runtime.md §3 C1–C7)
 * + the platform's runtime-contract assertions (deployment-service
 * src/services/__tests__/runtime-contract.test.ts), exercised against the
 * pure ledger module with a temp DATA_DIR (same pattern as
 * integration/crash-resume.test.ts).
 */
describe("Supervisor Protocol v1 — ledger", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bi-core-supervisor-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) process.env.DATA_DIR = originalDataDir;
    else delete process.env.DATA_DIR;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function ledger(opts?: Omit<ProtocolOptions, "dataDir">) {
    return new SupervisorLedger({ dataDir: tempDir, ...(opts ?? {}) });
  }

  describe("C2: valid task enqueue", () => {
    it("accepts a valid task, returns queued with a non-empty id and an initial transition", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "research_run", payload: { q: "x" } });
      expect(task.id).toBeTruthy();
      expect(task.state).toBe("queued");
      expect(task.transitions).toHaveLength(1);
      expect(task.transitions[0]).toEqual({ from: null, to: "queued", at: expect.any(String) });
      expect(s.getTask(task.id)).toBe(task);
    });

    it("accepts maxRuntimeSec and budget", () => {
      const s = ledger();
      const task = s.createTask({
        taskType: "crawl_run",
        payload: {},
        maxRuntimeSec: 3600,
        budget: { vmMinutes: 60, tokens: 200_000 },
      });
      expect(task.maxRuntimeSec).toBe(3600);
      expect(task.budget).toEqual({ vmMinutes: 60, tokens: 200_000 });
      expect(task.budgetUsed).toEqual({ tokens: 0 });
    });
  });

  describe("C3: invalid task rejected (400, never 500)", () => {
    it.each([
      ["empty object", {}],
      ["null", null],
      ["array", [1, 2]],
      ["string", "taskType"],
      ["number taskType", { taskType: 42 }],
      ["missing taskType", { payload: { a: 1 } }],
      ["empty-string taskType", { taskType: "  " }],
      ["non-object payload", { taskType: "t", payload: "nope" }],
      ["array payload", { taskType: "t", payload: [1] }],
      ["bad maxRuntimeSec", { taskType: "t", maxRuntimeSec: -5 }],
      ["bad budget shape", { taskType: "t", budget: "high" }],
      ["negative budget tokens", { taskType: "t", budget: { tokens: -1 } }],
    ])("rejects %s", (_name, body) => {
      const s = ledger();
      expect(() => s.createTask(body)).toThrowError(InvalidTaskError);
      expect(s.tasks.size).toBe(0);
    });

    it("rejects duplicate explicit ids", () => {
      const s = ledger();
      s.createTask({ taskType: "t" }, "same-id");
      expect(() => s.createTask({ taskType: "t" }, "same-id")).toThrowError(InvalidTaskError);
    });
  });

  describe("C4: transitions are append-only, monotonic, terminal-final", () => {
    it("queued → running → succeeded with ordered timestamps", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t" });
      s.markRunning(task.id);
      expect(s.succeed(task.id, { ok: true })).toBe(true);

      const transitions = s.getTask(task.id)!.transitions;
      expect(transitions.length).toBeGreaterThanOrEqual(2);
      expect(transitions[0]!.to).toBe("queued");
      expect(transitions[transitions.length - 1]!.to).toBe("succeeded");
      for (let i = 1; i < transitions.length; i += 1) {
        expect(Date.parse(transitions[i]!.at)).toBeGreaterThanOrEqual(Date.parse(transitions[i - 1]!.at));
      }
      expect(task.state).toBe("succeeded");
      expect(task.finishedAt).toBeTruthy();
    });

    it("terminal states are final — no transitions out", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t" });
      s.cancel(task.id);
      expect(TERMINAL_STATES).toContain(task.state);
      expect(() => s.markRunning(task.id)).not.toThrow(); // guarded no-op via state check
      expect(() => s.transition(task, "running")).toThrowError(TerminalTaskError);
      expect(task.state).toBe("cancelled");
      expect(s.succeed(task.id, {})).toBe(false);
      expect(s.fail(task.id, "x")).toBe(false);
      expect(task.state).toBe("cancelled");
    });

    it("cancelling a running task wins over a late success", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t" });
      s.markRunning(task.id);
      s.cancel(task.id);
      expect(s.succeed(task.id, { ok: true })).toBe(false);
      expect(s.getTask(task.id)!.state).toBe("cancelled");
    });
  });

  describe("C5: cancellation", () => {
    it("cancel from queued and from running both reach terminal cancelled", () => {
      const s = ledger();
      const a = s.createTask({ taskType: "a" });
      s.cancel(a.id);
      expect(a.state).toBe("cancelled");
      expect(a.finishedAt).toBeTruthy();

      const b = s.createTask({ taskType: "b" });
      s.markRunning(b.id);
      const cancelled = s.cancel(b.id);
      expect(cancelled.state).toBe("cancelled");
      // idempotent
      s.cancel(b.id);
      expect(s.getTask(b.id)!.state).toBe("cancelled");
    });

    it("unknown id throws (route maps to 404)", () => {
      const s = ledger();
      expect(() => s.cancel("nope")).toThrowError();
    });
  });

  describe("C6: checkpoints", () => {
    it("checkpointAll writes manifest blobs and returns the ids", () => {
      const s = ledger();
      const a = s.createTask({ taskType: "a" });
      s.markRunning(a.id);
      const b = s.createTask({ taskType: "b" }); // still queued — also checkpointable

      const done = s.checkpointAll();
      expect(done).toEqual(expect.arrayContaining([a.id, b.id]));

      const blobPath = s.checkpointPath(a.id);
      expect(fs.existsSync(blobPath)).toBe(true);
      const blob = JSON.parse(fs.readFileSync(blobPath, "utf8"));
      expect(blob.schemaVersion).toBe(1);
      expect(blob.taskId).toBe(a.id);
      expect(typeof blob.stateVector).toBe("string");
      expect(blob.createdAt).toBeTruthy();
      expect(blob.task.transitions.length).toBeGreaterThanOrEqual(2);
      expect(s.getTask(a.id)!.state).toBe("checkpointed");
    });

    it("skips terminal tasks", () => {
      const s = ledger();
      const a = s.createTask({ taskType: "a" });
      s.cancel(a.id);
      expect(s.checkpointAll()).toEqual([]);
      expect(s.hasCheckpoint(a.id)).toBe(false);
    });
  });

  describe("R4: resume", () => {
    it("checkpoint then resume → resumed", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "long" });
      s.checkpointAll();
      const resumed = s.resume(task.id);
      expect(resumed.state).toBe("resumed");
    });

    it("resume without checkpoint throws NoCheckpointError (route maps to 409)", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t" });
      expect(() => s.resume(task.id)).toThrowError(NoCheckpointError);
    });

    it("restores the last committed state vector on resume", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t", payload: { step: 1 } });
      s.markRunning(task.id);
      s.checkpointAll();
      // Simulate progress that was lost in a crash (in-memory only).
      task.payload = { step: 2 };
      task.transitions = [];
      const s2 = new SupervisorLedger({ dataDir: tempDir });
      s2.load();
      const restored = s2.getTask(task.id)!;
      s2.resume(task.id);
      // transitions come back from the checkpoint snapshot
      expect(restored.transitions.length).toBeGreaterThanOrEqual(1);
      expect(restored.state).toBe("resumed");
    });
  });

  describe("HITL: awaiting_input", () => {
    it("running → awaiting_input persists a checkpoint without leaving the state", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "review" });
      s.markRunning(task.id);
      s.requestAwaitingInput(task.id);
      expect(task.state).toBe("awaiting_input");
      expect(s.hasCheckpoint(task.id)).toBe(true);
      const blob = JSON.parse(fs.readFileSync(s.checkpointPath(task.id), "utf8"));
      expect(blob.stateVector).toBe("awaiting_input");
      // resume releases it
      s.resume(task.id);
      expect(task.state).toBe("resumed");
    });
  });

  describe("budget fence", () => {
    it("warns at ≥90% of budget.tokens", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t", budget: { tokens: 100 } });
      expect(s.recordUsage(task.id, 89)).toBe("ok");
      expect(s.recordUsage(task.id, 6)).toBe("warn"); // 95/100
      expect(task.state).toBe("queued"); // fence does not change state
    });

    it("checkpoints and expires at 100%", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t", budget: { tokens: 100 } });
      s.markRunning(task.id);
      expect(s.recordUsage(task.id, 100)).toBe("expired");
      expect(task.state).toBe("expired");
      expect(s.hasCheckpoint(task.id)).toBe(true); // checkpointed before expired
      expect(TERMINAL_STATES).toContain(task.state);
      // further usage is a no-op
      expect(s.recordUsage(task.id, 500)).toBe("ok");
      expect(task.state).toBe("expired");
    });

    it("enforceFence expires a resumed task whose restored budget is already exhausted", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t", budget: { tokens: 100 } });
      s.markRunning(task.id);
      s.checkpointAll();
      s.resume(task.id); // resumed (restores the checkpointed state vector)
      // Simulate usage restored by the crash-resume with the expiry
      // transition lost: the pre-step fence must catch it.
      task.budgetUsed.tokens = 120;
      expect(s.enforceFence(task.id)).toBe("expired");
      expect(task.state).toBe("expired");
      expect(s.hasCheckpoint(task.id)).toBe(true);
    });

    it("no budget → fence is advisory (always ok)", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "t" });
      expect(s.recordUsage(task.id, 10_000_000)).toBe("ok");
      expect(s.enforceFence(task.id)).toBe("ok");
    });
  });

  describe("persistence across restart", () => {
    it("a new ledger on the same DATA_DIR restores tasks and serves resume", () => {
      const s = ledger();
      const task = s.createTask({ taskType: "long", payload: { step: 3 } });
      s.markRunning(task.id);
      s.checkpointAll();

      const s2 = new SupervisorLedger({ dataDir: tempDir });
      expect(s2.load()).toBe(1);
      const restored: SupervisorTask = s2.getTask(task.id)!;
      expect(restored.taskType).toBe("long");
      expect(restored.payload).toEqual({ step: 3 });
      expect(restored.transitions.length).toBeGreaterThanOrEqual(2);
      expect(restored.state).toBe("checkpointed");

      // platform recreates the VM and calls resume
      s2.resume(task.id);
      expect(restored.state).toBe("resumed");
    });
  });

  describe("telemetry emission", () => {
    it("emits a task_transition event per transition with idempotency material (taskId:to:at)", () => {
      const events: Array<Record<string, unknown>> = [];
      const s = new SupervisorLedger({
        dataDir: tempDir,
        emit: (e) => events.push(e),
      });
      const task = s.createTask({ taskType: "t" });
      s.markRunning(task.id);
      s.cancel(task.id);
      const kinds = events.map((e) => e.kind);
      expect(kinds).toEqual(["task_transition", "task_transition", "task_transition"]);
      for (const e of events) {
        expect(e.taskId).toBe(task.id);
        expect(typeof e.at).toBe("string");
      }
      expect(events[0]).toMatchObject({ from: null, to: "queued" });
      expect(events[2]).toMatchObject({ to: "cancelled" });
    });

    it("emits a checkpoint event for checkpoints", () => {
      const events: Array<Record<string, unknown>> = [];
      const s = new SupervisorLedger({ dataDir: tempDir, emit: (e) => events.push(e) });
      const task = s.createTask({ taskType: "t" });
      s.checkpointAll();
      expect(events.some((e) => e.kind === "checkpoint" && e.taskId === task.id)).toBe(true);
    });
  });
});

describe("ControlPlane — broker secrets + telemetry", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockFetch(handler: (url: string, init?: RequestInit) => { status: number; body?: unknown }) {
    return (async (url: string, init?: RequestInit) => {
      const out = handler(String(url), init);
      return {
        ok: out.status >= 200 && out.status < 300,
        status: out.status,
        json: async () => out.body ?? {},
      } as unknown as Response;
    }) as unknown as typeof fetch;
  }

  it("fetches broker secrets with the X-Deployment-Id / X-Broker-Token headers", async () => {
    const calls: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = mockFetch((url, init) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return { status: 200, body: { secrets: { BREVO_API_KEY: "live-key-123", IMAP_PW: "s3cret" } } };
    });
    const logs: string[] = [];
    const cp = new ControlPlane({
      baseUrl: "http://ad.test",
      deploymentId: "dep-1",
      brokerToken: "tok-1",
      fetchImpl,
      log: (m) => logs.push(m),
    });
    const res = await cp.fetchSecrets();
    expect(res).toEqual({ ok: true, count: 2 });
    expect(cp.getSecret("BREVO_API_KEY")).toBe("live-key-123");
    expect(cp.secretNames.sort()).toEqual(["BREVO_API_KEY", "IMAP_PW"]);
    expect(calls[0].url).toBe("http://ad.test/v1/broker/secrets");
    expect(calls[0].headers["X-Deployment-Id"]).toBe("dep-1");
    expect(calls[0].headers["X-Broker-Token"]).toBe("tok-1");
    // hard rule: secret VALUES are never logged
    expect(logs.join("\n")).not.toContain("live-key-123");
    expect(logs.join("\n")).not.toContain("s3cret");
  });

  it("is a no-op when unconfigured (local dev)", async () => {
    const cp = controlPlaneFromEnv({});
    expect(cp.enabled).toBe(false);
    const res = await cp.fetchSecrets();
    expect(res.ok).toBe(false);
    cp.emit({ deploymentId: "x", eventType: "heartbeat", payload: {} });
    await expect(cp.flush()).resolves.toBeUndefined();
  });

  it("controlPlaneFromEnv wires AD_CONTROL_PLANE_URL + DEPLOYMENT_ID + AD_BROKER_TOKEN", () => {
    const cp = controlPlaneFromEnv({
      AD_CONTROL_PLANE_URL: "http://ad.test",
      DEPLOYMENT_ID: "dep-9",
      AD_BROKER_TOKEN: "tok-9",
    });
    expect(cp.enabled).toBe(true);
  });

  it("posts batched telemetry with idempotency keys; failed flush re-queues", async () => {
    const posted: Array<{ url: string; events: Array<Record<string, unknown>> }> = [];
    let failNext = true;
    const fetchImpl = mockFetch((url, init) => {
      if (failNext) {
        failNext = false;
        return { status: 500, body: { error: "boom" } };
      }
      posted.push({ url, events: (JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> }).events });
      return { status: 202, body: {} };
    });
    const cp = new ControlPlane({
      baseUrl: "http://ad.test",
      deploymentId: "dep-1",
      brokerToken: "tok-1",
      fetchImpl,
    });
    cp.emit({ deploymentId: "dep-1", taskId: "t1", eventType: "task_transition", idempotencyKey: "t1:running:ts1", payload: {} });
    await cp.flush(); // 500 → re-queued
    expect(posted.length).toBe(0);
    await cp.flush(); // success
    expect(posted.length).toBe(1);
    expect(posted[0].url).toBe("http://ad.test/v1/telemetry");
    expect(posted[0].events[0]).toMatchObject({ taskId: "t1", idempotencyKey: "t1:running:ts1", eventType: "task_transition" });
  });

  it("heartbeat computes the token delta over the period", async () => {
    const posted: Array<{ events: Array<Record<string, unknown>> }> = [];
    const fetchImpl = mockFetch((url, init) => {
      if (url.includes("/v1/telemetry")) {
        posted.push({ events: (JSON.parse(String(init?.body)) as { events: Array<Record<string, unknown>> }).events });
      }
      return { status: 200, body: {} };
    });
    const cp = new ControlPlane({
      baseUrl: "http://ad.test",
      deploymentId: "dep-1",
      brokerToken: "tok-1",
      fetchImpl,
    });
    cp.heartbeat({ phase: "idle", tokensInPeriod: 100, lastError: null });
    cp.heartbeat({ phase: "busy", tokensInPeriod: 140, lastError: null });
    await cp.flush();
    const hbs = posted.flatMap((p) => p.events).filter((e) => e.eventType === "heartbeat");
    expect(hbs.length).toBe(2);
    expect((hbs[0]!.payload as { tokensInPeriod: number }).tokensInPeriod).toBe(100);
    expect((hbs[1]!.payload as { tokensInPeriod: number }).tokensInPeriod).toBe(40);
    expect((hbs[1]!.payload as { phase: string }).phase).toBe("busy");
    expect((hbs[1]!.payload as { memMb: number }).memMb).toBeGreaterThan(0);
    expect(typeof (hbs[1]!.payload as { cpuPct: number }).cpuPct).toBe("number");
  });
});
