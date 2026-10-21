/**
 * Mastra adapter — server invocation style (Tier 1).
 *
 * Mastra serves an HTTP API via `mastra dev` (default port 4111). Agents are
 * defined in the buyer's project code, which ships in the image or arrives on
 * the volume; tasks are delegated to a registered workflow/agent endpoint.
 */
import type { RuntimeAdapter, TaskOutcome } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

const MASTRA_PORT = 4111;
const BASE = `http://localhost:${MASTRA_PORT}`;

const WORKFLOW_ROUTES: Record<string, string> = {
  crawl: "/api/workflows/crawl/trigger",
  verify: "/api/workflows/verify/trigger",
  enrich: "/api/workflows/enrich/trigger",
};

const POLL_INTERVAL_MS = 5_000;

async function triggerWorkflow(
  taskType: string,
  input: Record<string, unknown>,
  budget?: { vmMinutes?: number; tokens?: number },
  secrets?: Record<string, string>,
  maxRuntimeSec?: number,
): Promise<TaskOutcome> {
  const endpoint = WORKFLOW_ROUTES[taskType];

  const body: Record<string, unknown> = {
    taskType,
    payload: input,
  };
  if (budget) body.budget = budget;
  if (secrets?.["SYNC_URL"]) body.syncUrl = secrets["SYNC_URL"];
  if (secrets?.["SYNC_SECRET"]) body.syncSecret = secrets["SYNC_SECRET"];

  const triggerTimeoutMs = maxRuntimeSec ? maxRuntimeSec * 1000 : 60_000;
  const res = await fetch(`${BASE}${endpoint}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(triggerTimeoutMs),
  });

  const triggerBody = (await res.json().catch(() => null)) as {
    taskId?: string;
    state?: string;
    error?: string;
  } | null;

  if (!res.ok || !triggerBody?.taskId) {
    return { state: "failed", error: `workflow trigger ${res.status}: ${triggerBody?.error ?? "no taskId"}` };
  }

  const workflowId = triggerBody.taskId;
  const deadline = Date.now() + (maxRuntimeSec ? maxRuntimeSec * 1000 : 3_600_000);

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    try {
      const statusRes = await fetch(`${BASE}/api/workflows/${encodeURIComponent(workflowId)}/status`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!statusRes.ok) continue;

      const status = (await statusRes.json()) as {
        state?: string;
        result?: unknown;
        error?: string;
      };

      if (status.state === "succeeded") {
        return { state: "succeeded" };
      }
      if (status.state === "failed") {
        return { state: "failed", error: status.error ?? "workflow failed" };
      }
    } catch {
      continue;
    }
  }

  return { state: "expired", error: `workflow ${workflowId} timed out` };
}

export function createMastraAdapter(): RuntimeAdapter {
  return {
    name: "mastra",
    invocation: "server",
    command: ["npx", "mastra", "dev", "--port", String(MASTRA_PORT)],
    port: MASTRA_PORT,
    healthPath: "/health",
    checkpointPaths: ["/workspace/.mastra", "/workspace/mastra.db"],
    secretEnvMapping: {
      OPENAI_API_KEY: "OPENAI_API_KEY",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      GROQ_API_KEY: "GROQ_API_KEY",
      MISTRAL_API_KEY: "MISTRAL_API_KEY",
      SYNC_URL: "SYNC_URL",
      SYNC_SECRET: "SYNC_SECRET",
    },
    extraEnv: {
      MASTRA_TELEMETRY_DISABLED: "true",
      NODE_ENV: "production",
    },
    async delegateTask(payload) {
      const { taskType, input, secrets, budget, maxRuntimeSec } = payload;

      if (taskType && taskType in WORKFLOW_ROUTES) {
        try {
          return await triggerWorkflow(taskType, input, budget, secrets, maxRuntimeSec);
        } catch (error) {
          return { state: "failed", error: error instanceof Error ? error.message : String(error) };
        }
      }

      if (taskType && !(taskType in WORKFLOW_ROUTES) && taskType !== "generate") {
        const known = Object.keys(WORKFLOW_ROUTES).join(", ");
        return { state: "failed", error: `unknown taskType "${taskType}" — known workflows: ${known}` };
      }

      const agent = typeof input["agent"] === "string" ? (input["agent"] as string) : null;
      if (!agent) {
        return { state: "running" };
      }
      try {
        const res = await fetch(`${BASE}/api/agents/${encodeURIComponent(agent)}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: input["messages"] ?? [] }),
          signal: AbortSignal.timeout(300_000),
        });
        const body = (await res.json().catch(() => null)) as {
          usage?: { totalTokens?: number };
        } | null;
        try {
          await res.body?.cancel();
        } catch {}
        if (!res.ok) return { state: "failed", error: `mastra generate ${res.status}` };
        return {
          state: "succeeded",
          tokensUsed: body?.usage?.totalTokens ?? 0,
        };
      } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

registerAdapter("mastra", createMastraAdapter);
