/**
 * API Client Constants
 * ────────────────────
 * Central configuration for all HTTP API calls to agent backends.
 *
 * 12factor.net: Base URLs and timeouts are config, not hardcoded.
 *
 * The Vite dev proxy handles routing:
 *   /health         → edge worker (:8787)
 *   /agents/{name}  → edge worker (:8787)
 *   /d/{id}         → per-deployment console proxy (edge worker)
 *
 * In production, the edge worker serves these same-origin.
 */

// ─── API Configuration ───────────────────────────────────────────

export const API_CONFIG = {
  /** Base URL for all API calls (same-origin via edge worker/proxy) */
  baseUrl: "",
  /** Health check endpoint pattern (port interpolated; port 0 → edge default) */
  healthPath: (port: number) => (port > 0 ? `/health/${port}` : "/health"),
  /** Agent info endpoint pattern — /health already includes agents + deployment info */
  infoPath: (port: number) => (port > 0 ? `/health/${port}` : "/health"),
  /** Request timeout in milliseconds */
  timeoutMs: 5000,
  /** Polling interval for health checks (ms) */
  pollIntervalMs: 30000,
} as const;

// ─── Response Types ──────────────────────────────────────────────

export interface HealthResponse {
  status: string;
  deploymentId: string;
  templateId: string;
  model: string;
  agents: string[];
  version: string;
}

export interface InfoAgent {
  name: string;
  url: string;
}

export interface InfoResponse {
  deploymentId: string;
  templateId: string;
  model: string;
  region: string;
  agents: InfoAgent[];
}
