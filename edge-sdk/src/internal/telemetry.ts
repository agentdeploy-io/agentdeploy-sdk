// ── Internal: Telemetry & Billing ───────────────────────────────────────────
// These functions are called automatically by the SDK to report usage
// to the AgentDeploy platform via the gateway.
//
// BILLING ARCHITECTURE:
// =====================
// The AgentDeploy Gateway (at AD_GATEWAY_BASE_URL) is the AUTHORITATIVE
// source for token metering and billing. It sits between the worker and
// the upstream LLM provider, so it can count tokens in the HTTP response
// body regardless of whether the client stream completes or is aborted.
//
// This means:
//   1. If a buyer closes their browser tab mid-stream, the gateway STILL
//      counts the tokens from the provider's response and bills correctly.
//   2. The reportUsage() function below is a SECONDARY signal — it sends
//      SDK-observed usage as telemetry, but does NOT affect billing.
//   3. The onAfterChat hook fires even on abort (via StreamUsageTracker in
//      chat-agent.ts), so agent developers can react to partial usage.

export interface UsageReport {
  tokensIn: number;
  tokensOut: number;
  totalTokens: number;
}

export interface TelemetryEvent {
  event: string;
  deploymentId: string;
  timestamp: string;
  data?: Record<string, unknown>;
}

/**
 * Report token usage to the AgentDeploy platform.
 *
 * This sends SDK-observed usage as a SECONDARY telemetry signal. The
 * gateway already metered tokens authoritatively when the LLM response
 * passed through it, so this does NOT double-bill.
 *
 * Called automatically by the chat agent after each completion, and
 * also on stream abort/error via the StreamUsageTracker.
 */
export function reportUsage(usage: UsageReport): void {
  // Fire-and-forget telemetry — don't block on this
  if (typeof AD_GATEWAY_BASE_URL === "string" && AD_GATEWAY_BASE_URL) {
    try {
      fetch(`${AD_GATEWAY_BASE_URL}/v1/telemetry/usage`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "X-AD-Deployment": AD_DEPLOYMENT_ID,
        },
        body: JSON.stringify({
          deploymentId: AD_DEPLOYMENT_ID,
          ...usage,
          timestamp: new Date().toISOString(),
          source: "sdk",
        }),
      }).catch(() => {
        // Silently swallow — telemetry is best-effort
      });
    } catch {
      // no-op
    }
  }
}

/**
 * Record a telemetry event.
 */
export function recordTelemetry(
  event: string,
  data?: Record<string, unknown>,
): void {
  // Similar to reportUsage — the platform can derive most telemetry
  // from gateway traffic. This exists for SDK-side lifecycle events
  // that the gateway doesn't see (agent.onStart, tool calls, etc.)
  //
  // Future: POST to `${AD_GATEWAY_BASE_URL}/v1/telemetry/events`
  const payload: TelemetryEvent = {
    event,
    deploymentId: AD_DEPLOYMENT_ID,
    timestamp: new Date().toISOString(),
    data,
  };
  // Fire-and-forget — don't block on telemetry
  if (typeof AD_GATEWAY_BASE_URL === "string" && AD_GATEWAY_BASE_URL) {
    try {
      // Use keepalive for fire-and-forget in Workers
      fetch(`${AD_GATEWAY_BASE_URL}/v1/telemetry/events`, {
        method: "POST",
        keepalive: true,
        headers: {
          "Content-Type": "application/json",
          "X-AD-Deployment": AD_DEPLOYMENT_ID,
        },
        body: JSON.stringify(payload),
      }).catch(() => {
        // Silently swallow telemetry errors
      });
    } catch {
      // no-op
    }
  }
}
