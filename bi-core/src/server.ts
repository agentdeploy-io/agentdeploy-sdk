import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mastra } from "./mastra/index.js";
import { getCrawlProgress } from "./mastra/workflows/crawl.js";
import { installFetchTimeout } from "./http.js";
import { closeBrowser } from "./pipeline/renderer.js";
import {
  discoverCommonCrawl,
  discoverDefiLlama,
  discoverGithub,
  discoverRegistry,
  discoverUrlScan,
  hitsToCandidates,
} from "./pipeline/sources.js";
import { discoverDorks } from "./pipeline/behaviors.js";
import { pipelineSearch } from "./pipeline/search.js";
import { normalizePack } from "./pipeline/run.js";
import { emptyDrops, emptyStats, type Candidate } from "./pipeline/types.js";
import { loadCustomSources, getCustomSource, isCustomSource } from "./pipeline/custom-sources.js";
import { generateScraper, testScraper, registerScraper, removeScraper, listScrapers } from "./scraper/service.js";
import { startInboxPoller } from "./inbox/imap-poller.js";
import { SupervisorLedger, InvalidTaskError, NoCheckpointError, type SupervisorTask } from "./supervisor/protocol.js";
import { controlPlaneFromEnv } from "./supervisor/control-plane.js";
import type { CoreMessage } from "ai";

// Dev convenience: load packages/bi-core/.env when present. Variables already
// set in the environment always win.
try {
  const envPath = new URL("../.env", import.meta.url);
  if (existsSync(envPath)) {
    for (const line of readFileSync(envPath, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1] && !(m[1] in process.env)) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  }
} catch {
  /* no .env — fine */
}

// Must run after .env is loaded so HTTP_TIMEOUT_MS is honored.
installFetchTimeout(Number(process.env["HTTP_TIMEOUT_MS"] || 30_000));

const PORT = Number(process.env["PORT"] || 4111);

// ── Supervisor Protocol v1 (docs/sellers/byo-runtime.md) ─────────────────
// Control-plane client: broker secrets + telemetry + 30s heartbeats.
// No-op when AD_CONTROL_PLANE_URL is unset (local dev default).
const adControlPlane = controlPlaneFromEnv(process.env, (m) => console.log(`[bi-core:ad] ${m}`));
const adDeploymentId = (process.env["DEPLOYMENT_ID"] ?? "").trim();

// The platform's task ledger is the single source of truth for all tasks —
// console-triggered workflow runs and platform-enqueued protocol tasks alike.
const supervisor = new SupervisorLedger({
  dataDir: process.env["DATA_DIR"] || "/data",
  emit: (e) =>
    adControlPlane.emit({
      deploymentId: adDeploymentId,
      taskId: e.taskId,
      eventType: e.kind === "checkpoint" ? "checkpoint" : "task_transition",
      idempotencyKey: `${e.taskId}:${e.to}:${e.at}`,
      payload: { from: e.from, to: e.to },
    }),
});

const tasks = supervisor.tasks; // Map<string, SupervisorTask>
let seq = 0;
let tokensTotal = 0; // cumulative token meter (feeds heartbeat tokensInPeriod)
let lastTaskError: string | null = null;

function extractTokens(result: unknown): number {
  const r = result as {
    usage?: { totalTokens?: unknown; total_tokens?: unknown; tokens?: unknown };
    totalUsage?: { totalTokens?: unknown };
    result?: { usage?: { totalTokens?: unknown } };
  } | null;
  const cands = [
    r?.usage?.totalTokens,
    r?.usage?.total_tokens,
    r?.usage?.tokens,
    r?.totalUsage?.totalTokens,
    r?.result?.usage?.totalTokens,
  ];
  for (const c of cands) {
    if (typeof c === "number" && Number.isFinite(c) && c > 0) return c;
  }
  return 0;
}

// Source smoke tests: run one discovery source for a vertical WITHOUT the
// verify/enrich/sync stages, so the operator can preview what a source will
// feed the pipeline before a full crawl.
interface SourceTest {
  id: string;
  source: string;
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  candidates?: Candidate[];
  error?: string;
}
const sourceTests = new Map<string, SourceTest>();

// AI Scraper Builder tasks: LLM code generation + sandboxed smoke tests,
// both run async so the Workers-side proxy never hits its 30s cap.
interface ScraperTask {
  id: string;
  kind: "generate" | "test";
  state: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: { id: string; description: string; code: string } | { ok: boolean; hits?: unknown[]; error?: string };
  error?: string;
}
const scraperTasks = new Map<string, ScraperTask>();

function newScraperTask(kind: ScraperTask["kind"]): ScraperTask {
  seq += 1;
  const t: ScraperTask = { id: `scraper-${seq}`, kind, state: "running", startedAt: new Date().toISOString() };
  scraperTasks.set(t.id, t);
  if (scraperTasks.size > 20) {
    const oldest = [...scraperTasks.keys()][0];
    if (oldest) scraperTasks.delete(oldest);
  }
  return t;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body;
}

async function runMastraWorkflow(taskId: string, workflowName: string, input: Record<string, unknown>): Promise<void> {
  supervisor.markRunning(taskId);
  const task = tasks.get(taskId)!;

  // Budget fence before the expensive run (defense-in-depth; the platform
  // also enforces a hard stop independently).
  const fence = supervisor.enforceFence(taskId);
  if (fence === "expired") return;

  try {
    const workflow = mastra.getWorkflow(workflowName as "crawl");
    const run = await workflow.createRunAsync();
    const result = await run.start({ inputData: input as any });

    const tokens = extractTokens(result);
    if (tokens > 0) tokensTotal += tokens;
    const post = supervisor.recordUsage(taskId, tokens);
    if (post === "warn") {
      adControlPlane.emit({
        deploymentId: adDeploymentId,
        taskId,
        eventType: "warning",
        payload: { kind: "budget_fence_90pct", budgetUsed: task.budgetUsed, budget: task.budget },
      });
    }
    if (post === "expired") return; // fence won: checkpointed + expired
    supervisor.succeed(taskId, result); // no-op if the task was cancelled mid-run
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lastTaskError = msg;
    supervisor.fail(taskId, msg); // no-op if the task was cancelled mid-run
  }
}

async function runAgentGenerate(taskId: string, messages: CoreMessage[]): Promise<void> {
  supervisor.markRunning(taskId);

  try {
    const agent = mastra.getAgent("crawler");
    const result = await agent.generate(messages);
    const tokens = extractTokens(result);
    if (tokens > 0) tokensTotal += tokens;
    supervisor.recordUsage(taskId, tokens);
    supervisor.succeed(taskId, result);
  } catch (err) {
    lastTaskError = err instanceof Error ? err.message : String(err);
    supervisor.fail(taskId, lastTaskError);
  }
}

function createWorkflowTask(prefix: string, payload: Record<string, unknown> = {}): SupervisorTask {
  seq += 1;
  const taskId = `${prefix}-${seq}`;
  return supervisor.createTask({ taskType: prefix, payload }, taskId);
}

// Protocol taskType → Mastra workflow mapping. Unknown types are simulated
// (succeed with an echo) so conformance enqueues never fail; the payload is
// opaque to the platform by contract.
const WORKFLOW_BY_TYPE: Record<string, string> = {
  crawl: "crawl",
  crawl_run: "crawl",
  verify: "verify",
  verify_run: "verify",
  enrich: "enrich",
  enrich_run: "enrich",
};

function workflowInputFromTask(task: SupervisorTask): Record<string, unknown> {
  const input: Record<string, unknown> = { ...task.payload };
  if (task.budget.vmMinutes != null) input["vmMinutesLimit"] = task.budget.vmMinutes;
  if (task.budget.tokens != null) input["tokensLimit"] = task.budget.tokens;
  if (task.maxRuntimeSec != null) input["maxRuntimeSec"] = task.maxRuntimeSec;
  return input;
}

/** Dispatch a platform-enqueued protocol task to an executor. */
function dispatchProtocolTask(task: SupervisorTask): void {
  if (task.payload["hitl"] === true) {
    // Human-in-the-loop gate: hold at awaiting_input (checkpointed for VM
    // stops); POST /tasks/{id}/resume releases it into execution.
    supervisor.markRunning(task.id);
    supervisor.requestAwaitingInput(task.id);
    return;
  }
  const workflowName = WORKFLOW_BY_TYPE[task.taskType];
  if (workflowName) {
    void runMastraWorkflow(task.id, workflowName, workflowInputFromTask(task));
    return;
  }
  supervisor.markRunning(task.id);
  void (async () => {
    await new Promise((r) => setTimeout(r, 150));
    supervisor.succeed(task.id, {
      ok: true,
      note: `taskType "${task.taskType}" is not a bi-core workflow; simulated for conformance`,
      echo: task.payload,
    });
  })();
}

/**
 * Continue execution after a platform resume. The caller has already moved
 * the task to `resumed`; we defer past the first await so the HTTP response
 * is serialized with state "resumed" (the contract's expected shape) before
 * the task moves on to `running`.
 */
async function resumeProtocolTask(task: SupervisorTask): Promise<void> {
  if (task.state !== "resumed") return;
  await Promise.resolve();
  const workflowName = WORKFLOW_BY_TYPE[task.taskType];
  if (workflowName) {
    void runMastraWorkflow(task.id, workflowName, workflowInputFromTask(task));
    return;
  }
  supervisor.markRunning(task.id);
  await new Promise((r) => setTimeout(r, 150));
  supervisor.succeed(task.id, { ok: true, resumed: true, echo: task.payload });
}

interface WorkflowTriggerBody {
  taskType?: string;
  payload?: Record<string, unknown>;
  budget?: { vmMinutes?: number; tokens?: number };
  syncUrl?: string;
  syncSecret?: string;
}

function parseWorkflowInput(body: WorkflowTriggerBody): Record<string, unknown> {
  const input = body.payload ?? {};
  if (body.budget) {
    if (body.budget.vmMinutes != null) input["vmMinutesLimit"] = body.budget.vmMinutes;
    if (body.budget.tokens != null) input["tokensLimit"] = body.budget.tokens;
  }
  if (body.syncUrl) input["syncUrl"] = body.syncUrl;
  if (body.syncSecret) input["syncSecret"] = body.syncSecret;
  return input;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const p = url.pathname;

  if (req.method === "GET" && p === "/health") {
    return json(res, 200, { status: "ok", runtime: "bi-core", port: PORT });
  }

  if (req.method === "GET" && p === "/status") {
    const active = [...tasks.values()].some((t) => !["succeeded", "failed", "cancelled", "expired"].includes(t.state));
    return json(res, 200, {
      phase: active ? "busy" : "idle",
      cpuPct: Math.round(adControlPlane.cpuPct() * 10) / 10,
      memMb: Math.round(process.memoryUsage().rss / (1024 * 1024)),
      progress: getCrawlProgress(),
      tokensTotal,
      tasks: [...tasks.values()]
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, 8)
        .map((t) => ({
          id: t.id,
          state: t.state,
          taskType: t.taskType,
          transitions: t.transitions,
          budget: t.budget,
          budgetUsed: t.budgetUsed,
          checkpointCount: t.checkpointCount,
          startedAt: t.startedAt,
          finishedAt: t.finishedAt,
          error: t.error,
          // Final stats (totalCandidates / totalVerified / totalSynced / status)
          // so the UI can show what a finished crawl actually produced.
          result: t.state === "succeeded" ? (t.result as { result?: unknown } | undefined)?.result : undefined,
        })),
    });
  }

  // ── Source smoke tests (UI "Test source") ────────────────────────────────
  //   POST /v1/sources/test {vertical, source} → 202 {taskId}
  //   GET  /v1/sources/test/:id → {state, candidates?, error?}
  if (req.method === "GET" && p.startsWith("/v1/sources/test/")) {
    const id = p.slice("/v1/sources/test/".length);
    const t = sourceTests.get(id);
    if (!t) return json(res, 404, { error: "not found" });
    return json(res, 200, t);
  }

  if (req.method === "POST" && p === "/v1/sources/test") {
    let body: { vertical?: Record<string, unknown>; source?: string } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!body.vertical || typeof body.vertical !== "object" || typeof body.source !== "string") {
      return json(res, 400, { error: "vertical and source required" });
    }
    const source = body.source;
    const vertical = body.vertical;
    seq += 1;
    const test: SourceTest = { id: `srctest-${seq}`, source, state: "running", startedAt: new Date().toISOString() };
    sourceTests.set(test.id, test);
    if (sourceTests.size > 20) {
      const oldest = [...sourceTests.keys()][0];
      if (oldest) sourceTests.delete(oldest);
    }
    void (async () => {
      try {
        const pack = normalizePack(vertical as Parameters<typeof normalizePack>[0]);
        const country = pack.countries[0] ?? "uk";
        const env = { ...process.env } as Record<string, string>;
        const search = (query: string) => pipelineSearch(query, pack, env);
        const ctx = { pack, country, env, search, limit: pack.perCountryLimit, drops: emptyDrops() };
        let candidates: Candidate[] = [];
        if (source === "dorks") {
          candidates = await discoverDorks({ pack, country, env, search, limit: pack.perCountryLimit, drops: ctx.drops }, emptyStats());
        } else if (source === "registry") {
          candidates = await discoverRegistry(ctx);
        } else if (source === "commoncrawl") {
          candidates = hitsToCandidates(country, await discoverCommonCrawl(ctx), source);
        } else if (source === "github") {
          candidates = hitsToCandidates(country, await discoverGithub(ctx), source);
        } else if (source === "urlscan") {
          candidates = hitsToCandidates(country, await discoverUrlScan(ctx), source);
        } else if (source === "defillama") {
          candidates = hitsToCandidates(country, await discoverDefiLlama(ctx), source);
        } else if (isCustomSource(source)) {
          candidates = hitsToCandidates(country, await getCustomSource(source)!.discover(ctx), source);
        } else {
          test.state = "failed";
          test.error = `unknown source: ${source}`;
          return;
        }
        test.candidates = candidates.slice(0, 25);
        test.state = "done";
      } catch (e) {
        test.state = "failed";
        test.error = e instanceof Error ? e.message : String(e);
      } finally {
        test.finishedAt = new Date().toISOString();
      }
    })();
    return json(res, 202, { taskId: test.id });
  }

  // ── AI Scraper Builder ─────────────────────────────────────────────────────
  //   POST /v1/scrapers/generate {prompt} → 202 {taskId}   (LLM writes a module)
  //   GET  /v1/scrapers/generate/:id → {state, result?: {id, description, code}}
  //   POST /v1/scrapers/test {code, vertical?} → 202 {taskId}  (sandboxed run)
  //   GET  /v1/scrapers/test/:id → {state, result?: {ok, hits?|error?}}
  //   POST /v1/scrapers {id, description, code} → 201 (validated + persisted)
  //   GET  /v1/scrapers → [{id, description, createdAt}]
  //   DELETE /v1/scrapers/:id → 200 | 404
  if (req.method === "GET" && p.startsWith("/v1/scrapers/generate/")) {
    const t = scraperTasks.get(p.slice("/v1/scrapers/generate/".length));
    if (!t) return json(res, 404, { error: "not found" });
    return json(res, 200, t);
  }

  if (req.method === "GET" && p.startsWith("/v1/scrapers/test/")) {
    const t = scraperTasks.get(p.slice("/v1/scrapers/test/".length));
    if (!t) return json(res, 404, { error: "not found" });
    return json(res, 200, t);
  }

  if (req.method === "POST" && p === "/v1/scrapers/generate") {
    let body: { prompt?: string } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!body.prompt || !body.prompt.trim()) return json(res, 400, { error: "prompt required" });
    const task = newScraperTask("generate");
    const prompt = body.prompt.trim();
    void (async () => {
      try {
        task.result = await generateScraper(prompt, { ...process.env } as Record<string, string>);
        task.state = "done";
      } catch (e) {
        task.state = "failed";
        task.error = e instanceof Error ? e.message : String(e);
      } finally {
        task.finishedAt = new Date().toISOString();
      }
    })();
    return json(res, 202, { taskId: task.id });
  }

  if (req.method === "POST" && p === "/v1/scrapers/test") {
    let body: { code?: string; vertical?: Record<string, unknown> } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!body.code) return json(res, 400, { error: "code required" });
    const code = body.code;
    const pack = body.vertical ? normalizePack(body.vertical as Parameters<typeof normalizePack>[0]) : normalizePack({ id: "smoketest", name: "Smoke Test", countries: ["uk"], dorks: [], perCountryLimit: 15 });
    const task = newScraperTask("test");
    void (async () => {
      try {
        task.result = (await testScraper(code, pack, { ...process.env } as Record<string, string>)) as ScraperTask["result"];
        task.state = "done";
      } catch (e) {
        task.state = "failed";
        task.error = e instanceof Error ? e.message : String(e);
      } finally {
        task.finishedAt = new Date().toISOString();
      }
    })();
    return json(res, 202, { taskId: task.id });
  }

  if (req.method === "POST" && p === "/v1/scrapers") {
    let body: { id?: string; description?: string; code?: string } = {};
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    if (!body.id || !body.code) return json(res, 400, { error: "id and code required" });
    const out = registerScraper(process.env["DATA_DIR"] || "/data", body.id, body.description ?? "", body.code);
    if (!out.ok) return json(res, 400, { error: out.error });
    return json(res, 201, { id: out.source.id, description: out.source.description });
  }

  if (req.method === "GET" && p === "/v1/scrapers") {
    return json(res, 200, { scrapers: listScrapers() });
  }

  if (req.method === "DELETE" && p.startsWith("/v1/scrapers/")) {
    const id = p.slice("/v1/scrapers/".length);
    if (!removeScraper(process.env["DATA_DIR"] || "/data", id)) return json(res, 404, { error: "not found" });
    return json(res, 200, { removed: id });
  }

  // Contract used by bi-edge's crawl cron (src/cron/crawl.ts):
  //   POST /v1/handoff {countries, limit, trigger}
  // Runs the crawl workflow; candidates come back async via /inbound/sync on
  // SYNC_URL (authenticated with SYNC_SECRET).
  if (req.method === "POST" && p === "/v1/handoff") {
    let parsed: { countries?: string[]; limit?: number; trigger?: string; edgeRunId?: number; vertical?: Record<string, unknown> } = {};
    const raw = await readBody(req);
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: "invalid json" });
      }
    }
    const countries = (parsed.countries ?? ["fr", "uk", "ie", "ee", "pt"])
      .map((c) => String(c).trim().toLowerCase())
      .filter(Boolean);
    const limit = Number(parsed.limit ?? 50);
    const perCountryLimit = Math.max(1, Math.ceil(limit / Math.max(1, countries.length)));

    const input: Record<string, unknown> = {
      countries,
      perCountryLimit,
      braveApiKey: process.env["BRAVE_API_KEY"] ?? "",
      companiesHouseKey: process.env["COMPANIES_HOUSE_KEY"] || undefined,
      syncUrl: process.env["SYNC_URL"] ?? "",
      syncSecret: process.env["SYNC_SECRET"] ?? "",
      runId: `edge-${Date.now()}`,
      // The engine's crawl_runs row id — the run-complete report keys on it.
      edgeRunId: Number.isInteger(Number(parsed.edgeRunId)) ? Number(parsed.edgeRunId) : undefined,
    };
    // A vertical pack switches the run to the behavior-driven pipeline.
    if (parsed.vertical && typeof parsed.vertical === "object") {
      input["vertical"] = parsed.vertical;
    }
    const task = createWorkflowTask("crawl");
    void runMastraWorkflow(task.id, "crawl", input);
    return json(res, 202, {
      taskId: task.id,
      state: "queued",
      countries,
      perCountryLimit,
      vertical: parsed.vertical ? (parsed.vertical["name"] ?? parsed.vertical["id"]) : null,
    });
  }

  if (req.method === "POST" && p === "/api/agents/crawler/generate") {
    const body = await readBody(req);
    let parsed: { messages?: CoreMessage[] };
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }

    const messages = parsed.messages ?? [];
    const task = createWorkflowTask("agent", { messageCount: messages.length });
    void runAgentGenerate(task.id, messages);
    return json(res, 202, { taskId: task.id, state: "queued" });
  }

  if (req.method === "POST" && p === "/api/workflows/crawl/trigger") {
    const raw = await readBody(req);
    let parsed: WorkflowTriggerBody;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }

    const input = parseWorkflowInput(parsed);
    const task = createWorkflowTask("crawl", input);
    void runMastraWorkflow(task.id, "crawl", input);
    return json(res, 202, { taskId: task.id, state: "queued" });
  }

  if (req.method === "POST" && p === "/api/workflows/verify/trigger") {
    const raw = await readBody(req);
    let parsed: WorkflowTriggerBody;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }

    const input = parseWorkflowInput(parsed);
    const task = createWorkflowTask("verify", input);
    void runMastraWorkflow(task.id, "verify", input);
    return json(res, 202, { taskId: task.id, state: "queued" });
  }

  if (req.method === "POST" && p === "/api/workflows/enrich/trigger") {
    const raw = await readBody(req);
    let parsed: WorkflowTriggerBody;
    try {
      parsed = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }

    const input = parseWorkflowInput(parsed);
    const task = createWorkflowTask("enrich", input);
    void runMastraWorkflow(task.id, "enrich", input);
    return json(res, 202, { taskId: task.id, state: "queued" });
  }

  const workflowStatusMatch = p.match(/^\/api\/workflows\/([^/]+)\/status$/);
  if (req.method === "GET" && workflowStatusMatch) {
    const task = tasks.get(decodeURIComponent(workflowStatusMatch[1]!));
    if (!task) return json(res, 404, { error: "not found" });
    return json(res, 200, {
      id: task.id,
      state: task.state,
      startedAt: task.startedAt,
      finishedAt: task.finishedAt,
      result: task.result,
      error: task.error,
    });
  }

  const taskMatch = p.match(/^\/tasks\/([^/]+)$/);
  if (req.method === "GET" && taskMatch) {
    const task = tasks.get(decodeURIComponent(taskMatch[1]!));
    if (!task) return json(res, 404, { error: "not found" });
    return json(res, 200, task);
  }

  // ── Supervisor Protocol v1 (conformance C1–C8) ─────────────────────────
  // POST /tasks — valid → 202 {taskId, state}; invalid/empty → 400 (never 500)
  if (req.method === "POST" && p === "/tasks") {
    const raw = await readBody(req);
    let body: unknown;
    try {
      body = raw.trim() === "" ? {} : JSON.parse(raw);
    } catch {
      return json(res, 400, { error: "invalid json" });
    }
    let task: SupervisorTask;
    try {
      task = supervisor.createTask(body);
    } catch (e) {
      if (e instanceof InvalidTaskError) return json(res, 400, { error: e.reason });
      throw e;
    }
    void dispatchProtocolTask(task);
    return json(res, 202, { taskId: task.id, state: task.state });
  }

  // POST /tasks/{id}/cancel → 202; terminal `cancelled` (immediate; ≤60s rule)
  const cancelMatch = p.match(/^\/tasks\/([^/]+)\/cancel$/);
  if (req.method === "POST" && cancelMatch) {
    const id = decodeURIComponent(cancelMatch[1]!);
    if (!tasks.has(id)) return json(res, 404, { error: "not found" });
    const task = supervisor.cancel(id);
    return json(res, 202, { id: task.id, state: task.state });
  }

  // POST /tasks/{id}/resume → 200 {state:"resumed"}; 409 without checkpoint
  const resumeMatch = p.match(/^\/tasks\/([^/]+)\/resume$/);
  if (req.method === "POST" && resumeMatch) {
    const id = decodeURIComponent(resumeMatch[1]!);
    if (!tasks.has(id)) return json(res, 404, { error: "not found" });
    try {
      const task = supervisor.resume(id);
      void resumeProtocolTask(task);
      return json(res, 200, { id: task.id, state: task.state });
    } catch (e) {
      if (e instanceof NoCheckpointError) return json(res, 409, { error: e.message });
      throw e;
    }
  }

  // POST /checkpoint → 202 {checkpointed: [...]} (all non-terminal tasks)
  if (req.method === "POST" && p === "/checkpoint") {
    const checkpointed = supervisor.checkpointAll();
    return json(res, 202, { checkpointed });
  }

  // Conformance test hooks (mirror the platform's mock runtime; used by the
  // GA-gate live-image run of runtime-contract.test.ts).
  const testSucceedMatch = p.match(/^\/__test__\/tasks\/([^/]+)\/succeed$/);
  if (req.method === "POST" && testSucceedMatch) {
    const id = decodeURIComponent(testSucceedMatch[1]!);
    const task = tasks.get(id);
    if (!task) return json(res, 404, { error: "not found" });
    supervisor.succeed(id, { simulated: true });
    return json(res, 200, { id: task.id, state: task.state });
  }
  const testExpireMatch = p.match(/^\/__test__\/tasks\/([^/]+)\/expire$/);
  if (req.method === "POST" && testExpireMatch) {
    const id = decodeURIComponent(testExpireMatch[1]!);
    const task = tasks.get(id);
    if (!task) return json(res, 404, { error: "not found" });
    supervisor.writeCheckpoint(task, { moveState: true });
    supervisor.transition(task, "expired");
    return json(res, 200, { id: task.id, state: task.state });
  }

  return json(res, 404, { error: `no route: ${req.method} ${p}` });
}

// Load operator-approved custom scrapers (DATA_DIR/custom-sources/*.js) so
// they're available as vertical sources immediately after a restart.
const loadedScrapers = loadCustomSources(process.env["DATA_DIR"] || "/data");
if (loadedScrapers.length) console.log(`[bi-core] loaded custom scrapers: ${loadedScrapers.join(", ")}`);

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error("[server] handler error:", err);
    json(res, 500, { error: "internal" });
  });
});

/**
 * Boot-time control-plane wiring (platform deployments only — no-ops locally):
 *   1. fetch this deployment's broker secrets → in-memory only. They are
 *      materialized into process.env AFTER boot solely so the existing
 *      env-reading modules work unchanged; the platform's machine env (which
 *      is audited) contains no buyer secrets (R7/S1), and values are never
 *      logged anywhere.
 *   2. start telemetry flush + 30s heartbeats (3 missed = degraded, 10 =
 *      unresponsive on the platform side).
 */
async function bootstrapControlPlane(): Promise<void> {
  const fetched = await adControlPlane.fetchSecrets();
  if (fetched.ok) {
    for (const name of adControlPlane.secretNames) {
      const value = adControlPlane.getSecret(name);
      if (value && !(name in process.env)) process.env[name] = value;
    }
    console.log(`[bi-core:ad] broker secrets loaded: ${fetched.count} key(s), in memory only`);
  } else {
    console.log(`[bi-core:ad] broker secrets unavailable: ${fetched.error}`);
  }
  adControlPlane.start(() => ({
    phase: supervisor.activeCount() > 0 ? "busy" : "idle",
    tokensInPeriod: tokensTotal,
    lastError: lastTaskError,
  }));
}

const restored = supervisor.load();
if (restored > 0) console.log(`[bi-core] restored ${restored} task(s) from supervisor ledger`);

server.listen(PORT, () => {
  console.log(`[bi-core] mastra server listening on :${PORT}`);
  // Inbox poller (no-op unless INBOX_IMAP_* / PROTON_IMAP_* credentials are set).
  startInboxPoller(process.env as Record<string, string>);
  void bootstrapControlPlane().catch((err) => console.error("[bi-core:ad] bootstrap failed:", err));
});

// Don't orphan the headless chromium when the server is restarted/killed.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    void closeBrowser().finally(() => process.exit(0));
  });
}
