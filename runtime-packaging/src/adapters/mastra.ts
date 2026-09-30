/**
 * Mastra adapter — server invocation style (Tier 1).
 *
 * Mastra serves an HTTP API via `mastra dev` (default port 4111). Agents are
 * defined in the buyer's project code, which ships in the image or arrives on
 * the volume; tasks are delegated to a registered workflow/agent endpoint.
 */
import type { RuntimeAdapter } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

const MASTRA_PORT = 4111;

export function createMastraAdapter(): RuntimeAdapter {
  return {
    name: "mastra",
    invocation: "server",
    command: ["npx", "mastra", "dev", "--port", String(MASTRA_PORT)],
    port: MASTRA_PORT,
    healthPath: "/health",
    // Buyer project + local state live here.
    checkpointPaths: ["/workspace/.mastra", "/workspace/mastra.db"],
    secretEnvMapping: {
      OPENAI_API_KEY: "OPENAI_API_KEY",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      GROQ_API_KEY: "GROQ_API_KEY",
      MISTRAL_API_KEY: "MISTRAL_API_KEY",
    },
    extraEnv: {
      MASTRA_TELEMETRY_DISABLED: "true",
      NODE_ENV: "production",
    },
    async delegateTask(payload) {
      const agent = typeof payload.input["agent"] === "string" ? payload.input["agent"] : null;
      if (!agent) {
        return { state: "running" }; // buyer drives via Mastra's own playground
      }
      try {
        const res = await fetch(`http://localhost:${MASTRA_PORT}/api/agents/${encodeURIComponent(agent)}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messages: payload.input["messages"] ?? [] }),
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
