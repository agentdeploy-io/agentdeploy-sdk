/**
 * useAuthFetch — Auth-aware fetch helpers
 * ──────────────────────────────────────────
 * Provides fetch functions that automatically attach the correct
 * auth mechanism based on the deployment context:
 *
 *   Subdomain (*.agentdeploy.io):
 *     Uses credentials: "include" to send the Better Auth session
 *     cookie. No Authorization header.
 *
 *   Custom Domain (agents.acme.com):
 *     Uses Authorization: Bearer <edge-jwt> header. The edge JWT
 *     is loaded from localStorage.
 *
 *   Local Dev (localhost):
 *     No auth attached.
 *
 *   WebSocket Auth:
 *     Browsers can't set custom headers on WebSocket connections.
 *     For subdomain auth, the session cookie is sent automatically
 *     (same-origin). For custom domains, the edge JWT must be passed
 *     as a query param.
 */

import {
  AUTH_DISABLED,
  isCustomDomain,
  EDGE_JWT_STORAGE_KEY,
} from "../constants/auth";

/**
 * Get the edge JWT for custom-domain auth.
 * Returns null on subdomains and local dev.
 */
function getEdgeJwt(): string | null {
  if (AUTH_DISABLED) return null;
  if (!isCustomDomain()) return null;
  try {
    return localStorage.getItem(EDGE_JWT_STORAGE_KEY);
  } catch {
    return null;
  }
}

/**
 * Options for authFetch — extends standard RequestInit.
 */
export interface AuthFetchOptions extends RequestInit {
  // Inherits method, headers, body, signal, etc. from RequestInit
}

/**
 * Auth-aware fetch for HTTP requests to agent backends and APIs.
 *
 * - Subdomain: adds credentials: "include" (cookie-based session)
 * - Custom domain: adds Authorization: Bearer <jwt>
 * - Local dev: no auth header
 *
 * The caller provides the URL and any custom headers; this function
 * only sets the auth-related parts.
 */
export async function authFetch(
  url: string,
  options: AuthFetchOptions = {},
): Promise<Response> {
  const headers = new Headers(options.headers ?? {});

  const jwt = getEdgeJwt();
  if (jwt) {
    // Custom domain: Bearer token auth
    headers.set("Authorization", `Bearer ${jwt}`);
  }

  return fetch(url, {
    ...options,
    headers,
    // Always include credentials — on subdomains this sends the session
    // cookie; on custom domains it's a no-op (no shared cookies).
    credentials: AUTH_DISABLED ? "same-origin" : "include",
  });
}

/**
 * Build a WebSocket URL with auth token if needed.
 *
 * For custom domains: appends ?token=<jwt> (browsers can't set WS headers)
 * For subdomains: returns the base URL (session cookie sent automatically)
 * For local dev: returns the base URL (no auth)
 *
 * @param baseUrl The WebSocket URL (ws:// or wss://)
 * @returns The URL with auth token appended if needed
 */
export function buildAuthedWsUrl(baseUrl: string): string {
  const jwt = getEdgeJwt();
  if (!jwt) return baseUrl;

  const separator = baseUrl.includes("?") ? "&" : "?";
  return `${baseUrl}${separator}token=${encodeURIComponent(jwt)}`;
}
