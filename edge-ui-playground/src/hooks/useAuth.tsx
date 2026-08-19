/**
 * useAuth Hook + AuthProvider
 * ─────────────────────────────
 * Marketplace-aware authentication for the Edge Console.
 *
 * Two auth paths depending on where the console is deployed:
 *
 * Path 1 — AgentDeploy Subdomain ({handle}.agentdeploy.io):
 *   The Better Auth session cookie (better-auth.session_token) is scoped
 *   to .agentdeploy.io and carries over automatically.
 *   We verify the session by calling the marketplace API:
 *     GET https://agentdeploy.io/api/edge/session
 *   with credentials: "include". If valid, we get the user + subscription.
 *
 * Path 2 — Custom Domain (agents.acme.com, Pro/Business only):
 *   Better Auth cookies DON'T carry over (different domain).
 *   We use a short-lived edge JWT obtained via token exchange:
 *     1. Check for edge_console_token cookie / localStorage
 *     2. If missing/expired → redirect to agentdeploy.io/api/edge/authorize
 *     3. Marketplace validates Better Auth session, issues edge JWT
 *     4. Redirects back with ?edge_token=xxx
 *     5. We store the edge JWT and use it as Bearer token for API calls
 *
 * Path 3 — Local Dev (localhost):
 *   Auth is disabled. Synthetic "Local Developer" user is used.
 *   The hardcoded AGENTS array from constants/agents.ts is used.
 */

import React from "react";
import {
  AUTH_DISABLED,
  AUTH_CHECK_INTERVAL_MS,
  BETTER_AUTH_COOKIE,
  MARKETPLACE_URL,
  EDGE_JWT_COOKIE,
  EDGE_JWT_STORAGE_KEY,
  isCustomDomain,
  buildTokenExchangeUrl,
  buildLoginUrl,
} from "../constants/auth";
import type { AuthState, AuthUser, EdgeJwtPayload } from "../types/auth";

// ─── Cookie & JWT Utilities ──────────────────────────────────────

/**
 * Read a cookie value by name.
 */
function getCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const cookies = document.cookie.split(";");
  for (const cookie of cookies) {
    const [rawName, ...rawValueParts] = cookie.trim().split("=");
    if (rawName === name) {
      const rawValue = rawValueParts.join("=");
      try {
        return decodeURIComponent(rawValue);
      } catch {
        return rawValue;
      }
    }
  }
  return null;
}

/**
 * Get URL query parameter.
 */
function getQueryParam(name: string): string | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  return params.get(name);
}

/**
 * Remove a query parameter from the current URL (without reload).
 */
function removeQueryParam(name: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  window.history.replaceState({}, "", url.toString());
}

/**
 * Decode a JWT payload (the middle section) without verifying the signature.
 * Signature verification happens server-side.
 */
function decodeJwtPayload<T = EdgeJwtPayload>(token: string): T | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    let payload = parts[1];
    payload = payload.replace(/-/g, "+").replace(/_/g, "/");
    const padding = payload.length % 4;
    if (padding) {
      payload += "=".repeat(4 - padding);
    }

    const decoded = atob(payload);
    const json = decodeURIComponent(
      decoded
        .split("")
        .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
        .join(""),
    );

    return JSON.parse(json) as T;
  } catch {
    return null;
  }
}

/**
 * Check if a JWT is expired.
 */
function isJwtExpired(payload: { exp?: number }): boolean {
  if (!payload.exp) return true;
  return Date.now() >= payload.exp * 1000;
}

// ─── Session API ─────────────────────────────────────────────────

/**
 * Response from the marketplace session API.
 * GET https://agentdeploy.io/api/edge/session
 *
 * This endpoint validates the Better Auth session cookie and returns
 * the user info + subscription details. It's a server-side check
 * — the cookie is sent automatically (same-origin on *.agentdeploy.io).
 */
interface SessionApiResponse {
  user: AuthUser;
  authenticated: boolean;
}

/**
 * Verify the Better Auth session by calling the marketplace API.
 * Only works on *.agentdeploy.io subdomains (cookies are same-domain).
 */
async function verifySession(): Promise<{ user: AuthUser; token: string } | null> {
  try {
    const response = await fetch(`${MARKETPLACE_URL}/api/edge/session`, {
      method: "GET",
      credentials: "include", // send better-auth.session_token cookie
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data: SessionApiResponse = await response.json();
    if (!data.authenticated || !data.user) return null;

    // We can't read the Better Auth cookie value directly (it may be HttpOnly),
    // but we don't need the token client-side for subdomain auth —
    // all requests use credentials: "include" and the cookie is sent automatically.
    // We store a flag indicating we're session-authed.
    return { user: data.user, token: "session" };
  } catch {
    return null;
  }
}

// ─── Context ─────────────────────────────────────────────────────

interface AuthContextValue extends AuthState {
  /** Re-check the auth token */
  refresh: () => void;
  /** Log out — redirects to marketplace logout */
  logout: () => void;
  /** The buyer's subscription (loaded after auth) */
  // subscription: HostingSubscription | null;
  /** Templates the buyer has purchased (loaded after auth) */
  // templates: PurchasedTemplate[];
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

// ─── Synthetic Local Dev User ────────────────────────────────────

const LOCAL_DEV_USER: AuthUser = {
  id: "local-dev",
  email: "developer@localhost",
  name: "Local Developer",
  emailVerified: true,
  role: "buyer",
  status: "active",
};

// ─── AuthProvider ────────────────────────────────────────────────

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const usingCustomDomain = isCustomDomain();

  const [state, setState] = React.useState<AuthState>({
    isAuthenticated: AUTH_DISABLED,
    authDisabled: AUTH_DISABLED,
    isLoading: !AUTH_DISABLED,
    user: AUTH_DISABLED ? LOCAL_DEV_USER : null,
    token: null,
    error: null,
    isCustomDomain: usingCustomDomain,
  });

  // ─── Check Auth ────────────────────────────────────────────

  const checkAuth = React.useCallback(async () => {
    // Local dev — always authenticated
    if (AUTH_DISABLED) {
      setState({
        isAuthenticated: true,
        authDisabled: true,
        isLoading: false,
        user: LOCAL_DEV_USER,
        token: null,
        error: null,
        isCustomDomain: false,
      });
      return;
    }

    // ─── Custom Domain Path: Edge JWT ──────────────────────
    if (usingCustomDomain) {
      // Check if we just received a token from the exchange redirect
      const exchangeToken = getQueryParam("edge_token");
      if (exchangeToken) {
        // Store the token from the URL
        try {
          localStorage.setItem(EDGE_JWT_STORAGE_KEY, exchangeToken);
        } catch {
          // localStorage might be blocked
        }
        // Clean the URL (remove ?edge_token=xxx)
        removeQueryParam("edge_token");
      }

      // Read token from storage
      const token =
        exchangeToken ||
        getCookie(EDGE_JWT_COOKIE) ||
        (localStorage.getItem(EDGE_JWT_STORAGE_KEY) as string | null);

      if (!token) {
        // No token — redirect to token exchange
        const returnUrl = window.location.href;
        window.location.href = buildTokenExchangeUrl(returnUrl);
        return; // Page will redirect
      }

      // Decode and validate the edge JWT
      const payload = decodeJwtPayload(token);
      if (!payload || isJwtExpired(payload)) {
        // Token expired — clean up and redirect to exchange
        try {
          localStorage.removeItem(EDGE_JWT_STORAGE_KEY);
        } catch {
          // ignore
        }
        const returnUrl = window.location.href;
        window.location.href = buildTokenExchangeUrl(returnUrl);
        return;
      }

      // Token is valid
      const user: AuthUser = {
        id: payload.sub,
        email: payload.email,
        name: payload.name,
        emailVerified: true,
        role: payload.role as AuthUser["role"],
        status: "active",
      };

      setState({
        isAuthenticated: true,
        authDisabled: false,
        isLoading: false,
        user,
        token,
        error: null,
        isCustomDomain: true,
      });
      return;
    }

    // ─── Subdomain Path: Better Auth Session ────────────────
    // Verify the Better Auth session via the marketplace API.
    // The cookie is sent automatically (same parent domain).
    const session = await verifySession();

    if (!session) {
      setState({
        isAuthenticated: false,
        authDisabled: false,
        isLoading: false,
        user: null,
        token: null,
        error: "Your session has expired or you are not logged in.",
        isCustomDomain: false,
      });
      return;
    }

    setState({
      isAuthenticated: true,
      authDisabled: false,
      isLoading: false,
      user: session.user,
      token: session.token,
      error: null,
      isCustomDomain: false,
    });
  }, [usingCustomDomain]);

  // Initial auth check
  React.useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Periodic re-check
  React.useEffect(() => {
    if (AUTH_DISABLED) return;
    const interval = setInterval(() => checkAuth(), AUTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkAuth]);

  // Re-check on window focus
  React.useEffect(() => {
    if (AUTH_DISABLED) return;
    const handleFocus = () => checkAuth();
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [checkAuth]);

  // ─── Actions ───────────────────────────────────────────────

  const refresh = React.useCallback(() => {
    checkAuth();
  }, [checkAuth]);

  const logout = React.useCallback(() => {
    // Clear local edge JWT if on custom domain
    if (usingCustomDomain) {
      try {
        localStorage.removeItem(EDGE_JWT_STORAGE_KEY);
      } catch {
        // ignore
      }
    }

    setState({
      isAuthenticated: false,
      authDisabled: AUTH_DISABLED,
      isLoading: false,
      user: null,
      token: null,
      error: null,
      isCustomDomain: usingCustomDomain,
    });

    // Redirect to marketplace logout
    if (!AUTH_DISABLED) {
      const returnUrl = window.location.href;
      window.location.href = buildLoginUrl(returnUrl);
    }
  }, [usingCustomDomain]);

  const contextValue = React.useMemo<AuthContextValue>(
    () => ({ ...state, refresh, logout }),
    [state, refresh, logout],
  );

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};

// ─── useAuth Hook ────────────────────────────────────────────────

export function useAuth(): AuthContextValue {
  const context = React.useContext(AuthContext);
  if (!context) {
    throw new Error("useAuth must be used within an <AuthProvider>");
  }
  return context;
}

/**
 * Get the current auth token without using the hook (for use in non-component contexts).
 *
 * For subdomain auth: returns "session" (credentials are sent via cookie).
 * For custom domain auth: returns the edge JWT from localStorage.
 * For local dev: returns null (auth disabled).
 */
export function getAuthToken(): string | null {
  if (AUTH_DISABLED) return null;

  if (isCustomDomain()) {
    try {
      return localStorage.getItem(EDGE_JWT_STORAGE_KEY);
    } catch {
      return null;
    }
  }

  // Subdomain auth: return "session" — the actual auth is via cookie.
  // Callers use credentials: "include" to send the cookie automatically.
  return "session";
}
