/**
 * n8n adapter — server invocation style (Tier 1: near-trivial).
 *
 * Official image (n8nio/n8n) already serves HTTP on 5678 with /healthz.
 * State = the .n8n directory (workflows, credentials, SQLite) — checkpointed.
 * Tasks are delegated via n8n's REST API when a workflow id is provided;
 * otherwise buyers interact through n8n's own editor proxied by the console.
 */
import type { RuntimeAdapter } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

const N8N_PORT = 5678;

export function createN8nAdapter(): RuntimeAdapter {
  return {
    name: "n8n",
    invocation: "server",
    // Official image entrypoint; port wired to the shim's contract port map.
    command: ["n8n", "start", `--port=${N8N_PORT}`],
    port: N8N_PORT,
    healthPath: "/healthz",
    checkpointPaths: ["/home/node/.n8n"],
    secretEnvMapping: {
      N8N_ENCRYPTION_KEY: "N8N_ENCRYPTION_KEY",
      OPENAI_API_KEY: "OPENAI_API_KEY",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      SLACK_WEBHOOK_URL: "SLACK_WEBHOOK_URL",
      SMTP_PASSWORD: "SMTP_PASSWORD",
    },
    extraEnv: {
      // Keep n8n headless-safe inside the VM.
      N8N_DIAGNOSTICS_ENABLED: "false",
      N8N_PERSONALIZATION_ENABLED: "false",
      GENERIC_TIMEZONE: "utc",
    },
    async delegateTask(payload) {
      // Optional workflow execution: buyer payload may carry { workflowId, input }.
      const workflowId = payload.input["workflowId"];
      if (typeof workflowId !== "string" || workflowId.length === 0) {
        return { state: "running" }; // no target — buyer drives via editor UI
      }
      try {
        const res = await fetch(`http://localhost:${N8N_PORT}/api/v1/workflows/${encodeURIComponent(workflowId)}/run`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload.input),
          signal: AbortSignal.timeout(120_000),
        });
        const ok = res.ok;
        try {
          await res.body?.cancel();
        } catch {}
        return ok
          ? { state: "succeeded", tokensUsed: 0 }
          : { state: "failed", error: `n8n run returned ${res.status}` };
      } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

registerAdapter("n8n", createN8nAdapter);
