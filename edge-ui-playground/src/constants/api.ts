/**
 * API Client Constants
 * ────────────────────
 * Central configuration for all HTTP API calls to agent backends.
 *
 * 12factor.net: Base URLs and timeouts are config, not hardcoded.
 *
 * The Vite dev proxy handles routing:
 *   /health/{port}  → http://localhost:{port}/health
 *   /agents/{name}  → http://localhost:{port}/agents/{name}
 *
 * In production, these would be replaced with a control plane API.
 */

// ─── API Configuration ───────────────────────────────────────────

export const API_CONFIG = {
  /** Base URL for all API calls (same-origin in dev via Vite proxy) */
  baseUrl: "",
  /** Health check endpoint pattern (port interpolated) */
  healthPath: (port: number) => `/health/${port}`,
  /** Agent info endpoint pattern (port interpolated) */
  infoPath: (port: number) => {
    // /info isn't proxied with port, so we use the agent path
    // The /health/{port} proxy rewrites to /health on the backend.
    // For /info, we need to add proxy routes or use the health data.
    // Since /health already includes agents + deployment info, we use that.
    return `/health/${port}`;
  },
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
