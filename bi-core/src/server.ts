import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { mastra } from "./mastra/index.js";
import { getCrawlProgress } from "./mastra/workflows/crawl.js";
import { installFetchTimeout } from "./http.js";
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

interface TaskState {
  id: string;
  state: "queued" | "running" | "succeeded" | "failed";
  startedAt: string;
  finishedAt?: string;
  result?: unknown;
  error?: string;
}

const tasks = new Map<string, TaskState>();
let seq = 0;

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
  const task = tasks.get(taskId)!;
  task.state = "running";

  try {
    const workflow = mastra.getWorkflow(workflowName as "crawl");
    const run = await workflow.createRunAsync();
    const result = await run.start({ inputData: input as any });

    task.state = "succeeded";
    task.finishedAt = new Date().toISOString();
    task.result = result;
  } catch (err) {
    task.state = "failed";
    task.finishedAt = new Date().toISOString();
    task.error = err instanceof Error ? err.message : String(err);
  }
}

async function runAgentGenerate(taskId: string, messages: CoreMessage[]): Promise<void> {
  const task = tasks.get(taskId)!;
  task.state = "running";

  try {
    const agent = mastra.getAgent("crawler");
    const result = await agent.generate(messages);

    task.state = "succeeded";
    task.finishedAt = new Date().toISOString();
    task.result = result;
  } catch (err) {
    task.state = "failed";
    task.finishedAt = new Date().toISOString();
    task.error = err instanceof Error ? err.message : String(err);
  }
}

function createWorkflowTask(prefix: string): TaskState {
  seq += 1;
  const taskId = `${prefix}-${seq}`;
  const task: TaskState = { id: taskId, state: "queued", startedAt: new Date().toISOString() };
  tasks.set(taskId, task);
  return task;
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
    const active = [...tasks.values()].some((t) => t.state === "queued" || t.state === "running");
    return json(res, 200, {
      phase: active ? "busy" : "idle",
      progress: getCrawlProgress(),
      memMb: process.memoryUsage().rss / (1024 * 1024),
      tasks: [...tasks.values()]
        .sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))
        .slice(0, 8)
        .map((t) => ({
          id: t.id,
          state: t.state,
          startedAt: t.startedAt,
          finishedAt: t.finishedAt,
          error: t.error,
          // Final stats (totalCandidates / totalVerified / totalSynced / status)
          // so the UI can show what a finished crawl actually produced.
          result: t.state === "succeeded" ? (t.result as { result?: unknown } | undefined)?.result : undefined,
        })),
    });
  }

  // Contract used by bi-edge's crawl cron (src/cron/crawl.ts):
  //   POST /v1/handoff {countries, limit, trigger}
  // Runs the crawl workflow; candidates come back async via /inbound/sync on
  // SYNC_URL (authenticated with SYNC_SECRET).
  if (req.method === "POST" && p === "/v1/handoff") {
    let parsed: { countries?: string[]; limit?: number; trigger?: string } = {};
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
    };
    const task = createWorkflowTask("crawl");
    void runMastraWorkflow(task.id, "crawl", input);
    return json(res, 202, { taskId: task.id, state: "queued", countries, perCountryLimit });
  }

  if (req.method === "POST" && p === "/api/agents/crawler/generate") {
    const body = await readBody(req);
    let parsed: { messages?: CoreMessage[] };
    try {
      parsed = JSON.parse(body || "{}");
    } catch {
      return json(res, 400, { error: "invalid json" });
    }

    const task = createWorkflowTask("agent");
    void runAgentGenerate(task.id, parsed.messages ?? []);
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
    const task = createWorkflowTask("crawl");
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
    const task = createWorkflowTask("verify");
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
    const task = createWorkflowTask("enrich");
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

  return json(res, 404, { error: `no route: ${req.method} ${p}` });
}

const server = createServer((req, res) => {
  void handle(req, res).catch((err) => {
    console.error("[server] handler error:", err);
    json(res, 500, { error: "internal" });
  });
});

server.listen(PORT, () => {
  console.log(`[bi-core] mastra server listening on :${PORT}`);
});
