/**
 * DeepSeek Harness adapter — CLI invocation style (Tier 2).
 *
 * The DeepSeek harness is a Python entrypoint driven by env keys + a task
 * prompt. Buyers bring the harness code on the volume; the image supplies
 * Python + the pinned harness package.
 */
import type { RuntimeAdapter } from "../adapter-types.js";
import { registerAdapter } from "../adapter-types.js";

export function createDeepseekHarnessAdapter(): RuntimeAdapter {
  return {
    name: "deepseek-harness",
    invocation: "cli",
    command: ["python", "-m", "harness.run", "--task", "{prompt}", "--json"],
    port: 8080,
    healthPath: "/health",
    checkpointPaths: ["/workspace/.harness"],
    secretEnvMapping: {
      DEEPSEEK_API_KEY: "DEEPSEEK_API_KEY",
    },
    interpretExit(exitCode, outputTail) {
      if (exitCode === 0) return { state: "succeeded" };
      if (exitCode === 130 || exitCode === 143) return { state: "cancelled" };
      return { state: "failed", error: `harness exited ${exitCode}: ${outputTail.slice(-400)}` };
    },
  };
}

registerAdapter("deepseek-harness", createDeepseekHarnessAdapter);
