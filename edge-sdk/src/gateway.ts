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
// The gateway authenticates with the per-deployment key bound as the
// AD_GATEWAY_API_KEY secret (Authorization: Bearer). X-AD-Deployment is
// routing/observability metadata only.
//
// Uses @ai-sdk/openai-compatible (spec version v2) instead of @ai-sdk/openai
// (spec version v1) for compatibility with AI SDK 5+/6+.

import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/**
 * Creates an AI SDK model instance that routes through the AgentDeploy gateway.
 *
 * All LLM calls go through `${AD_GATEWAY_BASE_URL}/v1/chat/completions`,
 * which handles:
 *   - Token metering and billing
 *   - Provider routing (OpenRouter, etc.)
 *   - Rate limiting
 *   - Deployment authentication (per-deployment API key)
 *
 * The gateway authenticates via the per-deployment AD_GATEWAY_API_KEY secret
 * (injected by the platform at provision time). The platform also injects the
 * other AD_* constants at deploy time.
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
export function useGateway(
  modelName?: string,
  env?: Record<string, unknown>,
): LanguageModel {
  // Runtime override from environment (dev only, takes precedence)
  const runtimeModel = env?.AD_MODEL as string | undefined;
  const runtimeBaseUrl = env?.AD_GATEWAY_BASE_URL as string | undefined;

  const apiKey = resolveGatewayApiKey(env);

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
export function gatewayUrl(env?: Record<string, unknown>): string {
  const runtimeBaseUrl = env?.AD_GATEWAY_BASE_URL as string | undefined;
  const bare = typeof AD_GATEWAY_BASE_URL !== "undefined" ? AD_GATEWAY_BASE_URL : "";
  return (runtimeBaseUrl || bare) as string;
}

/**
 * The real gateway credential when the platform has bound one. The
 * placeholder fallback exists so the AI SDK provider instance is always
 * constructible in dev; the gateway rejects it with 401 (by design) until a
 * per-deployment key is bound as the AD_GATEWAY_API_KEY secret.
 */
const GATEWAY_API_KEY_PLACEHOLDER = "ad-deployment-managed";

function resolveGatewayApiKey(envOverride?: Record<string, unknown>): string {
  const runtimeApiKey = envOverride?.AD_GATEWAY_API_KEY as string | undefined;
  return (
    runtimeApiKey ||
    (typeof AD_GATEWAY_API_KEY === "string" && AD_GATEWAY_API_KEY) ||
    GATEWAY_API_KEY_PLACEHOLDER
  );
}

function hasRealGatewayApiKey(envOverride?: Record<string, unknown>): boolean {
  return resolveGatewayApiKey(envOverride) !== GATEWAY_API_KEY_PLACEHOLDER;
}

/**
 * Returns deployment headers for manual gateway calls. Sends the real
 * Authorization bearer when a per-deployment key is bound; X-AD-Deployment
 * stays for routing/observability (it is NOT an authenticator).
 */
export function gatewayHeaders(env?: Record<string, unknown>): Record<string, string> {
  // AD_DEPLOYMENT_ID is a bare global injected by the platform renderer in
  // prod; in local `wrangler dev` it is undefined, so access it safely and
  // fall back to the runtime env (from .dev.vars).
  const deploymentId =
    (typeof AD_DEPLOYMENT_ID !== "undefined" ? AD_DEPLOYMENT_ID : undefined) ??
    (env?.AD_DEPLOYMENT_ID as string | undefined) ??
    "";
  const headers: Record<string, string> = {
    "X-AD-Deployment": deploymentId,
    "Content-Type": "application/json",
  };
  if (hasRealGatewayApiKey(env)) {
    headers.Authorization = `Bearer ${resolveGatewayApiKey(env)}`;
  }
  return headers;
}

/**
 * Fetch against the gateway with transient-failure handling:
 *   - 429: backpressure. The gateway returns Retry-After; short waits get a
 *     polite retry, long waits surface the 429 to the caller.
 *   - 408/502/503/504/524: transient infrastructure failures. Notably 524 is
 *     Cloudflare's "origin did not answer within 100s" — the gateway is
 *     usually still computing the LLM call when the tunnel leg times out.
 *     One retry re-issues the call and frequently succeeds.
 *
 * @example
 * ```ts
 * const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
 *   method: "POST",
 *   body: JSON.stringify({ messages, stream: false }),
 * });
 * ```
 */
const TRANSIENT_GATEWAY_STATUSES = new Set([408, 502, 503, 504, 524]);

export async function gatewayFetchWithBackoff(
  path: string,
  init: RequestInit,
  options?: { maxRetries?: number; maxWaitSeconds?: number; env?: Record<string, unknown> }
): Promise<Response> {
  const maxRetries = options?.maxRetries ?? 1;
  const maxWaitSeconds = options?.maxWaitSeconds ?? 15;
  const url = `${gatewayUrl(options?.env)}${path}`;
  const headers = {
    ...gatewayHeaders(options?.env),
    ...(init.headers as Record<string, string> | undefined),
  };

  let attempt = 0;
  for (;;) {
    attempt++;
    const response = await fetch(url, { ...init, headers });
    const retryable = response.status === 429 || TRANSIENT_GATEWAY_STATUSES.has(response.status);
    if (!retryable || attempt > maxRetries) return response;

    let delaySeconds: number;
    if (response.status === 429) {
      delaySeconds = Number(response.headers.get("Retry-After")) || 2;
      if (!(delaySeconds > 0) || delaySeconds > maxWaitSeconds) return response;
    } else {
      // Transient infrastructure failure — short fixed pause, then retry.
      delaySeconds = 2;
    }

    await response.body?.cancel().catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
  }
}

/**
 * Normalize an LLM chat-completion response into a parsed JSON value.
 *
 * Accepts either the full response body (gateway `{ data: {...} }` envelope or
 * raw OpenAI shape) or an already-extracted message object. Handles the
 * real-world shapes in one pass:
 *   1. Unwraps the gateway's `{ data: {...} }` envelope (raw bodies pass
 *      through untouched).
 *   2. Thinking models may leave `content` empty and answer in
 *      `reasoning_content` — falls back to it.
 *   3. Models frequently wrap "ONLY JSON" output in a ```json ... ```
 *      markdown fence — strips the fence before parsing.
 *
 * Returns the parsed value on success, or `{ response: <raw text> }` when the
 * text is not valid JSON so callers always get an object back.
 */
export function parseLlmJson(body: unknown): Record<string, unknown> {
  let text = "";
  if (body && typeof body === "object") {
    const obj = body as Record<string, unknown>;
    if (typeof obj.content === "string" || typeof obj.reasoning_content === "string") {
      text = String(obj.content || obj.reasoning_content || "");
    } else {
      const gw = ("data" in obj ? obj.data : obj) as
        | { choices?: Array<{ message?: { content?: string; reasoning_content?: string } }> }
        | null;
      const message = gw?.choices?.[0]?.message;
      text = String(message?.content || message?.reasoning_content || "");
    }
  }
  let s = text.trim();
  if (s.startsWith("```")) {
    const nl = s.indexOf("\n");
    if (nl > -1) s = s.slice(nl + 1);
    if (s.endsWith("```")) s = s.slice(0, -3);
    s = s.trim();
  }
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return { response: text };
  }
}
