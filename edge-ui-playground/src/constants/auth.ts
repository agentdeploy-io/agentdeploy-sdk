/**
 * Authentication Constants & Configuration
 * ─────────────────────────────────────────
 * Marketplace-aware auth configuration for the AgentDeploy Edge Console.
 *
 * Auth Architecture (Marketplace Reality):
 *   The main marketplace at agentdeploy.io uses **Better Auth** for identity.
 *   Better Auth issues a `better-auth.session_token` cookie scoped to
 *   `*.agentdeploy.io` via crossSubDomainCookies.
 *
 *   When a buyer purchases agent templates, they get an Edge Console:
 *     - Sandbox/Starter tiers → auto-generated subdomain: `{handle}.agentdeploy.io`
 *     - Pro/Business tiers   → custom domain: `agents.acme.com`
 *
 *   For `*.agentdeploy.io` subdomains, the Better Auth session cookie
 *   carries over automatically (same parent domain).
 *
 *   For custom domains (not on agentdeploy.io), the console uses a
 *   **token exchange**: redirect to agentdeploy.io/api/edge/authorize,
 *   which validates the Better Auth session and issues a short-lived
 *   edge JWT that gets set as a cookie on the custom domain.
 *
 * Multi-Template Support:
 *   A buyer may purchase multiple agent templates from different sellers.
 *   The console dynamically loads their purchased templates from the
 *   deployment-service API, not a hardcoded AGENTS array.
 *
 * Local Dev:
 *   Auth is disabled on localhost. The playground uses the hardcoded
 *   AGENTS array from constants/agents.ts for development.
 *
 * 12factor.net: All URLs and config are environment-driven.
 */

// ─── Auth Mode ───────────────────────────────────────────────────

/**
 * Whether auth is required for the current deployment.
 *
 * Auth is DISABLED when:
 *   - Running on localhost / 127.0.0.1 (local dev)
 *   - VITE_AUTH_DISABLED env var is "true"
 *
 * Auth is ENABLED when:
 *   - Deployed to a production subdomain or custom domain
 */
function computeAuthDisabled(): boolean {
  const envOverride = import.meta.env.VITE_AUTH_DISABLED;
  if (envOverride === "true") return true;
  if (envOverride === "false") return false;

  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.");

  return isLocalhost;
}

export const AUTH_DISABLED = computeAuthDisabled();

// ─── Better Auth Configuration ───────────────────────────────────

/**
 * Better Auth session cookie name.
 * This cookie is set by the main marketplace at agentdeploy.io.
 * The crossSubDomainCookies config scopes it to .agentdeploy.io
 * so it carries over to {handle}.agentdeploy.io subdomains.
 */
export const BETTER_AUTH_COOKIE = "better-auth.session_token";

/**
 * The main marketplace URL where users log in / create accounts.
 * Edge Console subdomains redirect here when auth is needed.
 */
export const MARKETPLACE_URL =
  import.meta.env.VITE_MARKETPLACE_URL ?? "https://agentdeploy.io";

/**
 * The deployment-service API base URL.
 * This is where the Edge Console fetches the buyer's purchased templates,
 * subscription tier, and deployment metadata.
 *
 * In production: https://api.agentdeploy.io
 * In local dev: http://localhost:8787 (or whichever agent port)
 */
export const DEPLOYMENT_API_URL =
  import.meta.env.VITE_DEPLOYMENT_API_URL ?? "";

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
 *   6. Console stores edge JWT as cookie on the custom domain
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
 * After login, the user is redirected back to the Edge Console.
 */
export function buildLoginUrl(returnUrl?: string): string {
  const url = new URL("/login", MARKETPLACE_URL);
  if (returnUrl) {
    url.searchParams.set("callbackURL", returnUrl);
  }
  return url.toString();
}

// ─── Hosting Tier Configuration ──────────────────────────────────

/**
 * The hosting tier determines what domain the buyer gets:
 *
 *   sandbox  → Auto-generated subdomain: {handle}.edge.agentdeploy.io
 *              1 agent max, 10K tokens
 *
 *   starter  → Auto-generated subdomain: {handle}.agentdeploy.io
 *              4 agents max, 100K tokens
 *
 *   pro      → Custom domain OR subdomain: agents.acme.com
 *              12 agents max, 500K tokens
 *
 *   business → Custom domain OR subdomain: agents.acme.com
 *              35 agents max, 2M tokens
 */
export type HostingTier = "sandbox" | "starter" | "pro" | "business";

export const TIER_CONFIG: Record<
  HostingTier,
  {
    label: string;
    allowsCustomDomain: boolean;
    defaultSubdomainPattern: string;
    agentLimit: number;
    tokenAllowance: number;
  }
> = {
  sandbox: {
    label: "Sandbox",
    allowsCustomDomain: false,
    defaultSubdomainPattern: "{handle}.edge.agentdeploy.io",
    agentLimit: 1,
    tokenAllowance: 10_000,
  },
  starter: {
    label: "Starter",
    allowsCustomDomain: false,
    defaultSubdomainPattern: "{handle}.agentdeploy.io",
    agentLimit: 4,
    tokenAllowance: 100_000,
  },
  pro: {
    label: "Pro",
    allowsCustomDomain: true,
    defaultSubdomainPattern: "{handle}.agentdeploy.io",
    agentLimit: 12,
    tokenAllowance: 500_000,
  },
  business: {
    label: "Business",
    allowsCustomDomain: true,
    defaultSubdomainPattern: "{handle}.agentdeploy.io",
    agentLimit: 35,
    tokenAllowance: 2_000_000,
  },
};

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
 * This is a short-lived token issued by the token exchange endpoint.
 * It's NOT the Better Auth session — it's a separate, scoped token.
 */
export const EDGE_JWT_COOKIE = "edge_console_token";
export const EDGE_JWT_STORAGE_KEY = "edge_console_jwt";

/**
 * Edge JWT lifetime (5 minutes). The client periodically refreshes
 * by re-exchanging with the marketplace (silent redirect if on
 * an agentdeploy.io subdomain, or token refresh API if custom domain).
 */
export const EDGE_JWT_TTL_MS = 5 * 60 * 1000;

// ─── Session Check Interval ──────────────────────────────────────

export const AUTH_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

// ─── Auth Error Codes ────────────────────────────────────────────

export const AUTH_ERRORS = {
  NO_SESSION: "AUTH_NO_SESSION",
  TOKEN_EXPIRED: "AUTH_TOKEN_EXPIRED",
  TOKEN_INVALID: "AUTH_TOKEN_INVALID",
  WS_AUTH_FAILED: "AUTH_WS_AUTH_FAILED",
  ACCESS_DENIED: "AUTH_ACCESS_DENIED",
  TIER_LIMIT_REACHED: "AUTH_TIER_LIMIT_REACHED",
} as const;

export const AUTH_ERROR_MESSAGES: Record<string, string> = {
  AUTH_NO_SESSION: "Your session has expired. Please log in again.",
  AUTH_TOKEN_EXPIRED: "Your authentication token has expired. Please log in again.",
  AUTH_TOKEN_INVALID: "Your authentication token is invalid. Please log in again.",
  AUTH_WS_AUTH_FAILED: "The agent rejected your credentials. Please re-authenticate.",
  AUTH_ACCESS_DENIED: "You do not have access to this agent. Contact your administrator.",
  AUTH_TIER_LIMIT_REACHED: "You've reached your plan's agent limit. Upgrade to deploy more agents.",
};
