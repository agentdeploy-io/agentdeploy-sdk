/**
 * Authentication Constants & Configuration
 * ─────────────────────────────────────────
 * Marketplace-aware auth configuration for the Calla UI.
 *
 * Auth Architecture (3 paths — unchanged from the Edge Console):
 *
 *   Path 1 — AgentDeploy subdomain ({handle}.agentdeploy.io):
 *     The Better Auth session cookie (better-auth.session_token) is scoped
 *     to .agentdeploy.io and carries over automatically. Verified via
 *     GET {MARKETPLACE_URL}/api/edge/session with credentials: "include".
 *
 *   Path 2 — Custom domain (agents.acme.com):
 *     Better Auth cookies do NOT carry over. A short-lived edge JWT is
 *     obtained via token exchange at {MARKETPLACE_URL}/api/edge/authorize.
 *
 *   Path 3 — Localhost / LAN dev:
 *     AUTH_DISABLED — synthetic local developer identity, no network auth.
 *
 * Runtime config resolution (see src/config.ts):
 *   window.__CALLA_CONFIG__ → window.__EDGE_CONSOLE_CONFIG__ (back-compat)
 *   → import.meta.env.VITE_* → defaults.
 *
 * 12factor.net: All URLs and config are environment-driven.
 */

import { getCallaConfig, getAuthMode, type AuthMode } from "@/config";

// ─── Auth Mode ───────────────────────────────────────────────────

/**
 * The resolved auth strategy for this deployment:
 *   "disabled"    → localhost/LAN dev (synthetic local user, no network auth)
 *   "standalone"  → self-hosted: the brain issues its own JWTs and the UI
 *                   shows a real Login page (no agentdeploy.io dependency)
 *   "marketplace" → agentdeploy.io subdomain cookie / custom-domain exchange
 *
 * Precedence (see getAuthMode() in @/config): explicit AUTH_MODE override →
 * VITE_AUTH_DISABLED → localhost → MARKETPLACE_URL.
 */
export const AUTH_MODE: AuthMode = getAuthMode();

/**
 * Whether auth is required for the current deployment.
 *
 * Auth is DISABLED only in "disabled" mode (localhost / LAN dev, or
 * VITE_AUTH_DISABLED=true / AUTH_MODE="disabled"). Derived from AUTH_MODE so
 * the four modes never disagree.
 */
export const AUTH_DISABLED: boolean = AUTH_MODE === "disabled";

/** True when the self-hosted (brain-issued JWT) flow is active. */
export function isStandaloneAuth(): boolean {
  return AUTH_MODE === "standalone";
}

/** True when the agentdeploy.io marketplace flows are active. */
export function isMarketplaceAuth(): boolean {
  return AUTH_MODE === "marketplace";
}

// ─── Better Auth Configuration ───────────────────────────────────

/**
 * Better Auth session cookie name.
 * Set by the main marketplace at agentdeploy.io and scoped to
 * .agentdeploy.io so it carries over to {handle}.agentdeploy.io.
 */
export const BETTER_AUTH_COOKIE = "better-auth.session_token";

// ─── Runtime Config (via src/config.ts) ─────────────────────────

const config = getCallaConfig();

/**
 * The main marketplace URL where users log in / create accounts.
 * Calla subdomains redirect here when auth is needed.
 */
export const MARKETPLACE_URL: string = config.MARKETPLACE_URL;

/**
 * The deployment-service (platform) API base URL.
 * "" means same-origin — the edge worker proxies /v1/* and /api/edge/*.
 */
export const DEPLOYMENT_API_URL: string = config.DEPLOYMENT_API_URL;

/**
 * Mastra brain base URL. "" or "none" disables brain-backed features
 * (see lib/mastra-client.ts graceful degradation).
 */
export const BRAIN_URL: string = config.BRAIN_URL ?? "/brain";

/**
 * The edge token exchange endpoint on the main marketplace.
 * Used for custom-domain auth bridging.
 *
 * Flow:
 *   1. User visits agents.acme.com (custom domain, not agentdeploy.io)
 *   2. No session cookie (different domain)
 *   3. Redirect to agentdeploy.io/api/edge/authorize?return_url=agents.acme.com
 *   4. Marketplace validates Better Auth session
 *   5. Issues short-lived edge JWT, redirects back with ?edge_token=xxx
 *   6. UI stores edge JWT as cookie/localStorage on the custom domain
 */
export const EDGE_TOKEN_EXCHANGE_PATH = "/api/edge/authorize";

/**
 * Build the token exchange URL for custom-domain auth.
 */
export function buildTokenExchangeUrl(returnUrl?: string): string {
  const url = new URL(EDGE_TOKEN_EXCHANGE_PATH, MARKETPLACE_URL);
  if (returnUrl) {
    url.searchParams.set("return_url", returnUrl);
  }
  return url.toString();
}

/**
 * Build the marketplace login URL.
 * After login, the user is redirected back to the Calla UI.
 */
export function buildLoginUrl(returnUrl?: string): string {
  const url = new URL("/login", MARKETPLACE_URL);
  if (returnUrl) {
    url.searchParams.set("callbackURL", returnUrl);
  }
  return url.toString();
}

// ─── Domain Detection ────────────────────────────────────────────

/** Hosting tier (metadata only — Calla does no tier gating client-side). */
export type HostingTier = "sandbox" | "starter" | "pro" | "business";

/**
 * Check if the current hostname is a *.agentdeploy.io subdomain.
 * On these subdomains, Better Auth cookies carry over automatically.
 */
export function isAgentDeploySubdomain(): boolean {
  if (typeof window === "undefined") return false;
  return window.location.hostname.endsWith(".agentdeploy.io");
}

/**
 * Check if the current hostname is a custom domain
 * (not localhost, not agentdeploy.io).
 * Custom domains need the token exchange flow.
 */
export function isCustomDomain(): boolean {
  if (typeof window === "undefined") return false;
  if (AUTH_DISABLED) return false;
  if (isAgentDeploySubdomain()) return false;
  return true;
}

// ─── Edge JWT (for custom domains) ───────────────────────────────

/**
 * Cookie name for the edge JWT on custom domains.
 * Short-lived token issued by the token exchange endpoint —
 * NOT the Better Auth session, a separate scoped token.
 */
export const EDGE_JWT_COOKIE = "calla_token";
export const EDGE_JWT_STORAGE_KEY = "calla_jwt";

/**
 * Legacy Edge Console storage key. Still READ as a migration fallback
 * so existing custom-domain sessions survive the rebrand; never written.
 */
export const LEGACY_EDGE_JWT_STORAGE_KEY = "edge_console_jwt";

/**
 * Read the stored edge JWT — new key first, legacy key as fallback.
 * Returns null when auth is disabled or storage is blocked.
 */
export function readStoredEdgeJwt(): string | null {
  try {
    return (
      localStorage.getItem(EDGE_JWT_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_EDGE_JWT_STORAGE_KEY)
    );
  } catch {
    return null;
  }
}

/**
 * Edge JWT lifetime (5 minutes). The client periodically refreshes
 * by re-exchanging with the marketplace.
 */
export const EDGE_JWT_TTL_MS = 5 * 60 * 1000;

// ─── Session Check Interval ──────────────────────────────────────

// checkAuth is a local (synchronous) JWT decode — cheap enough to run
// frequently. A short interval ensures the proactive refresh window below is
// always hit before the token actually expires.
export const AUTH_CHECK_INTERVAL_MS = 15 * 1000; // 15 seconds
/**
 * Re-run the token exchange while this much validity remains on the edge JWT.
 * The UI then effectively stays authenticated as long as the BFF session
 * does (the exchange only succeeds while the Better Auth session is valid).
 */
export const EDGE_JWT_REFRESH_WINDOW_MS = 60 * 1000; // 60 seconds

// ─── Auth Error Codes ────────────────────────────────────────────

export const AUTH_ERRORS = {
  NO_SESSION: "AUTH_NO_SESSION",
  TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  WS_AUTH_FAILED: "AUTH_WS_AUTH_FAILED",
  ACCESS_DENIED: "AUTH_ACCESS_DENIED",
} as const;

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  AUTH_NO_SESSION: "Your session has expired. Please log in again.",
  AUTH_TOKEN_EXPIRED: "Your authentication token has expired. Please log in again.",
  AUTH_TOKEN_INVALID: "Your authentication token is invalid. Please log in again.",
  AUTH_WS_AUTH_FAILED: "The agent rejected your credentials. Please re-authenticate.",
  AUTH_ACCESS_DENIED: "You do not have access to this agent. Contact your administrator.",
};
