/**
 * OpenHands adapter — server invocation style (Tier 1).
 *
 * OpenHands (formerly OpenDevin) ships an official Docker image serving its
 * API + UI on port 3000. Buyer workspace is checkpointed; tasks are delegated
 * through its conversation API.
 */
import type { RuntimeAdapter } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

const OPENHANDS_PORT = 3000;

export function createOpenHandsAdapter(): RuntimeAdapter {
  return {
    name: "openhands",
    invocation: "server",
    // Official image entrypoint serves the app; we only wire the port.
    command: [],
    port: OPENHANDS_PORT,
    healthPath: "/health",
    checkpointPaths: ["/opt/openhands/workspace", "/root/.openhands"],
    secretEnvMapping: {
      LLM_API_KEY: "LLM_API_KEY",
      GITHUB_TOKEN: "GITHUB_TOKEN",
      OPENAI_API_KEY: "OPENAI_API_KEY",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    },
    extraEnv: {
      // Bind to all interfaces so Fly's proxy reaches the container.
      RUNTIME_BIND: "0.0.0.0",
    },
    async delegateTask(payload) {
      const instruction =
        typeof payload.input["instruction"] === "string" ? payload.input["instruction"] : null;
      if (!instruction) {
        return { state: "running" }; // buyer drives via OpenHands UI
      }
      try {
        const res = await fetch(`http://localhost:${OPENHANDS_PORT}/api/conversations`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            initial_user_msg: instruction,
            selected_repository: payload.input["repository"] ?? undefined,
          }),
          signal: AbortSignal.timeout(600_000),
        });
        try {
          await res.body?.cancel();
        } catch {}
        return res.ok
          ? { state: "succeeded", tokensUsed: 0 }
          : { state: "failed", error: `openhands conversation ${res.status}` };
      } catch (error) {
        return { state: "failed", error: error instanceof Error ? error.message : String(error) };
      }
    },
  };
}

registerAdapter("openhands", createOpenHandsAdapter);
