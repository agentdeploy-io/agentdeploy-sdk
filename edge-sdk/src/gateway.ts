// ── Gateway Integration ─────────────────────────────────────────────────────
// Provides an AI SDK v2-compatible model that routes through the AgentDeploy
// gateway for billing, token metering, and provider routing.
//
// The gateway is the AUTHORITATIVE billing source. It intercepts every
// upstream LLM HTTP response and counts tokens from the provider's
// response body — this works even when the client aborts the downstream
// stream (e.g., buyer closes browser tab), because the gateway already
// received and metered the upstream response.
//
// The X-AD-Deployment header authenticates the call — no API key needed.
//
// Uses @ai-sdk/openai-compatible (spec version v2) instead of @ai-sdk/openai
// (spec version v1) for compatibility with AI SDK 5+/6+.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";

/**
 * Creates an AI SDK model instance that routes through the AgentDeploy gateway.
 *
 * All LLM calls go through `${AD_GATEWAY_BASE_URL}/v1/chat/completions`,
 * which handles:
 *   - Token metering and billing
 *   - Provider routing (OpenRouter, etc.)
 *   - Rate limiting
 *   - Deployment authentication (via X-AD-Deployment header)
 *
 * The gateway authenticates by deployment ID — no API key needed in the
 * worker code. The platform injects AD_* constants at deploy time.
 *
 * @example
 * ```ts
 * import { useGateway } from "@agentdeploy-io/edge-sdk";
 * import { streamText } from "ai";
 *
 * const model = useGateway();
 * const result = streamText({ model, prompt: "Hello" });
 * ```
 *
 * @param modelName - Optional model override. Defaults to the deployment's
 *   configured model (AD_MODEL). The platform may override this.
 * @param env - Optional environment object for runtime model selection.
 *   Supports AD_MODEL, AD_GATEWAY_BASE_URL, AD_GATEWAY_API_KEY overrides.
 *   Useful for development (.dev.vars) and dynamic model switching.
 */
export function useGateway(modelName?: string, env?: Record<string, unknown>) {
  // Runtime override from environment (dev only, takes precedence)
  const runtimeModel = env?.AD_MODEL as string | undefined;
  const runtimeBaseUrl = env?.AD_GATEWAY_BASE_URL as string | undefined;
  const runtimeApiKey = env?.AD_GATEWAY_API_KEY as string | undefined;

  const apiKey = runtimeApiKey ||
    (typeof AD_GATEWAY_API_KEY === "string" && AD_GATEWAY_API_KEY) ||
    "ad-deployment-managed";

  const baseURL = runtimeBaseUrl || AD_GATEWAY_BASE_URL;
  const model = modelName || runtimeModel || AD_MODEL;

  const provider = createOpenAICompatible({
    baseURL: `${baseURL}/v1`,
    apiKey,
    name: "agentdeploy",
    headers: {
      "X-AD-Deployment": AD_DEPLOYMENT_ID,
    },
  });

  return provider(model);
}

/**
 * Returns the raw gateway base URL for custom fetch calls.
 *
 * @example
 * ```ts
 * const url = `${gatewayUrl()}/v1/chat/completions`;
 * const res = await fetch(url, { ... });
 * ```
 */
export function gatewayUrl(): string {
  return AD_GATEWAY_BASE_URL;
}

/**
 * Returns deployment headers for manual gateway calls.
 */
export function gatewayHeaders(): Record<string, string> {
  return {
    "X-AD-Deployment": AD_DEPLOYMENT_ID,
    "Content-Type": "application/json",
  };
}
