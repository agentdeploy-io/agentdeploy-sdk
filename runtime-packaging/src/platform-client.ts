/**
 * Platform clients — how the shim talks to deployment-service.
 * Uses only env the machine legitimately has: AD_BROKER_TOKEN,
 * DEPLOYMENT_ID (both injected at deploy time), and DIRECTUS/gateway URLs
 * are NOT needed here — the broker + telemetry endpoints are on the same
 * deployment-service host passed as CONTROL_PLANE_URL.
 */

const CONTROL_PLANE_URL = () => (process.env["CONTROL_PLANE_URL"] || "").replace(/\/$/, "");
const BROKER_TOKEN = () => process.env["AD_BROKER_TOKEN"] || "";
const DEPLOYMENT_ID = () => process.env["DEPLOYMENT_ID"] || "";

function headers(): Record<string, string> {
  return {
    "X-Deployment-Id": DEPLOYMENT_ID(),
    "X-Broker-Token": BROKER_TOKEN(),
    "Content-Type": "application/json",
  };
}

export function isPlatformConfigured(): boolean {
  return !!(CONTROL_PLANE_URL() && BROKER_TOKEN() && DEPLOYMENT_ID());
}

/** Fetch plaintext secrets from the broker. Memory-only — never written to disk. */
export async function fetchSecrets(): Promise<Record<string, string>> {
  if (!isPlatformConfigured()) return {};
  try {
    const res = await fetch(`${CONTROL_PLANE_URL()}/v1/broker/secrets`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      console.error(`[shim] broker secrets fetch failed: ${res.status}`);
      return {};
    }
    const body = (await res.json()) as { secrets?: Record<string, string> };
    return body.secrets ?? {};
  } catch (error) {
    console.error("[shim] broker secrets fetch error:", error);
    return {};
  }
}

export interface TelemetryEventBody {
  eventType: "heartbeat" | "task_transition" | "checkpoint" | "warning" | "tool_call";
  taskId?: string;
  idempotencyKey?: string;
  payload?: Record<string, unknown>;
}

/** Fire-and-forget telemetry batch (at-least-once tolerated by platform dedup). */
export function sendTelemetry(events: TelemetryEventBody[]): void {
  if (!isPlatformConfigured() || events.length === 0) return;
  void fetch(`${CONTROL_PLANE_URL()}/v1/telemetry`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      events: events.map((e) => ({
        deploymentId: DEPLOYMENT_ID(),
        ...e,
        ts: new Date().toISOString(),
      })),
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch((error) => console.error("[shim] telemetry send failed:", error));
}

export function sendHeartbeat(payload: {
  phase?: string;
  cpuPct?: number;
  memMb?: number;
  lastError?: string | null;
}): void {
  sendTelemetry([{ eventType: "heartbeat", payload }]);
}
