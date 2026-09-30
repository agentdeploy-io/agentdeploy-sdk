/**
 * Hermes adapter — CLI invocation style.
 *
 * Hermes (Nous Research's agent runtime) runs headless per task:
 *   hermes --prompt "<task input>" --output-format json
 * Sessions persist under ~/.hermes (checkpointed). Provider keys arrive via
 * the secret broker and are mapped to the env names Hermes reads.
 */
import type { RuntimeAdapter } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

const HERMES_CHECKPOINT_PATHS = ["/root/.hermes"];

export function createHermesAdapter(): RuntimeAdapter {
  return {
    name: "hermes",
    invocation: "cli",
    command: ["hermes", "--prompt", "{prompt}", "--output-format", "json"],
    port: 8080, // shim's own port; Hermes itself has no server
    healthPath: "/health",
    checkpointPaths: HERMES_CHECKPOINT_PATHS,
    // Common provider key names → what Hermes expects in env. The broker
    // delivers whatever secrets the buyer configured; only mapped ones pass.
    secretEnvMapping: {
      OPENAI_API_KEY: "OPENAI_API_KEY",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY",
      OPENROUTER_API_KEY: "OPENROUTER_API_KEY",
    },
    interpretExit(exitCode, outputTail) {
      if (exitCode === 0) {
        return { state: "succeeded", outputTail };
      }
      // 130 = SIGINT, 143 = SIGTERM — treat as cancelled by request.
      if (exitCode === 130 || exitCode === 143) {
        return { state: "cancelled" };
      }
      return { state: "failed", error: `hermes exited ${exitCode}: ${outputTail.slice(-400)}` };
    },
  };
}

registerAdapter("hermes", createHermesAdapter);
