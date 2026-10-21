import { Agent } from "@mastra/core/agent";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { loadBuiltinOrchestratorInstructions } from "../skills/loader.js";
import { dispatchEdgeTask } from "../tools/dispatch-edge-task.js";
import { sendExternalEmail } from "../tools/send-email.js";
import { listFleet } from "../tools/list-fleet.js";

/**
 * LLM resolution — OpenAI-compatible base URL + token first, Anthropic second.
 *
 * 1. OpenAI-compatible gateway/relay (the standard AgentDeploy pattern):
 *      LLM_BASE_URL   e.g. http://localhost:8794/v1 or https://gateway.example.com/v1
 *      LLM_API_KEY    bearer token (some relays accept any value; "relay-key" is sent when unset)
 *      LLM_MODEL      model id served by the gateway (default: gpt-4o-mini)
 *    Aliases honored: OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_MODEL.
 * 2. ANTHROPIC_API_KEY (+ CALLA_MODEL, default claude-sonnet-4-5).
 *
 * A per-agent `model` override (calla_agent_configs.model) is passed as
 * modelId: "anthropic/<model>" forces the Anthropic provider; any other
 * string selects the model on the configured provider chain above.
 *
 * LAZY: the provider is only constructed on first LLM call, so the server
 * boots without any key and non-LLM endpoints (health, suspended-runs, ...)
 * keep working; LLM calls fail with a clear, actionable error.
 */

const OPENAI_COMPAT_DEFAULT_MODEL = "gpt-4o-mini";
const ANTHROPIC_DEFAULT_MODEL = "claude-sonnet-4-5";

function openAiCompatBaseUrl(): string | undefined {
  return process.env.LLM_BASE_URL || process.env.OPENAI_BASE_URL || undefined;
}

/** Human-readable LLM config for /health. */
export function describeLlmConfig(): string {
  const baseUrl = openAiCompatBaseUrl();
  if (baseUrl) {
    const model =
      process.env.LLM_MODEL || process.env.OPENAI_MODEL || OPENAI_COMPAT_DEFAULT_MODEL;
    return `openai-compatible:${model}@${baseUrl}`;
  }
  if (process.env.ANTHROPIC_API_KEY) {
    return `anthropic:${process.env.CALLA_MODEL ?? ANTHROPIC_DEFAULT_MODEL}`;
  }
  return "not-configured";
}

const NO_LLM_ERROR =
  "[calla-brain] No LLM configured. Set LLM_BASE_URL (+ LLM_API_KEY, LLM_MODEL) for any " +
  "OpenAI-compatible gateway/relay, or ANTHROPIC_API_KEY for Anthropic. " +
  "Non-LLM endpoints (/health, /, suspended-runs) remain available without a key.";

/**
 * Resolve a language model: `modelId` (per-agent-config override, optional)
 * through the same openai-compatible/anthropic provider chain used by the
 * brain default. Shared by the static orchestrator and the dynamic agent
 * factory (../dynamic-agents.ts).
 */
export function resolveModel(modelId?: string | null) {
  const explicit = (modelId ?? "").trim();

  if (explicit.startsWith("anthropic/")) {
    const anthropicKey = process.env.ANTHROPIC_API_KEY;
    if (!anthropicKey) {
      throw new Error(
        `[calla-brain] model "${explicit}" requires ANTHROPIC_API_KEY to be set.`,
      );
    }
    return createAnthropic({ apiKey: anthropicKey })(explicit.slice("anthropic/".length));
  }

  const baseUrl = openAiCompatBaseUrl();
  if (baseUrl) {
    const apiKey =
      process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || "relay-key";
    const model =
      explicit || process.env.LLM_MODEL || process.env.OPENAI_MODEL || OPENAI_COMPAT_DEFAULT_MODEL;
    return createOpenAICompatible({
      name: "calla-llm-gateway",
      baseURL: baseUrl,
      apiKey,
    })(model);
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    return createAnthropic({ apiKey: anthropicKey })(
      explicit || process.env.CALLA_MODEL || ANTHROPIC_DEFAULT_MODEL,
    );
  }

  throw new Error(NO_LLM_ERROR);
}

/** Brain-default model (no per-agent override) — kept for existing callers. */
export function resolveOrchestratorModel() {
  return resolveModel();
}

export const orchestratorAgent = new Agent({
  id: "calla-orchestrator",
  name: "calla-orchestrator",
  description:
    "Calla brain orchestrator — coordinates the Cloudflare edge fleet, dispatches step tasks, and enforces human-in-the-loop approval gates.",
  // Single source of truth: builtin/orchestrator-instructions.md (also the
  // seeded "orchestrator" agent-config instructions — see ../skills/seed.ts).
  instructions: loadBuiltinOrchestratorInstructions(),
  model: () => resolveOrchestratorModel(),
  tools: { dispatchEdgeTask, sendExternalEmail, listFleet },
});
