/**
 * useAuth Hook + AuthProvider
 * ─────────────────────────────
 * Marketplace-aware authentication for the Calla UI.
 *
 * Two auth paths depending on where the app is deployed:
 *
 * Path 1 — AgentDeploy Subdomain ({handle}.agentdeploy.io):
 *   The Better Auth session cookie (better-auth.session_token) is scoped
 *   to .agentdeploy.io and carries over automatically.
 *   We verify the session by calling the marketplace API:
 *     GET https://agentdeploy.io/api/edge/session
 *   with credentials: "include". If valid, we get the user + subscription.
 *
 * Path 2 — Custom Domain (agents.acme.com):
 *   Better Auth cookies DON'T carry over (different domain).
 *   We use a short-lived edge JWT obtained via token exchange:
 *     1. Check for calla_token cookie / calla_jwt localStorage
 *        (legacy edge_console_jwt is still read as a migration fallback)
 *     2. If missing/expired → redirect to agentdeploy.io/api/edge/authorize
 *     3. Marketplace validates Better Auth session, issues edge JWT
 *     4. Redirects back with ?edge_token=xxx
 *     5. We store the edge JWT and use it as Bearer token for API calls
 *
 * Path 3 — Local Dev (localhost):
 *   Auth is disabled. Synthetic "Local Developer" user is used.
 *   The CALLA_DEV_AGENTS array from constants/agents.ts is used.
 */

import React from "react";
import {
  AUTH_DISABLED,
  AUTH_MODE,
  AUTH_CHECK_INTERVAL_MS,
  MARKETPLACE_URL,
  EDGE_JWT_COOKIE,
  EDGE_JWT_REFRESH_WINDOW_MS,
  EDGE_JWT_STORAGE_KEY,
  LEGACY_EDGE_JWT_STORAGE_KEY,
  readStoredEdgeJwt,
  isCustomDomain,
  buildTokenExchangeUrl,
  buildLoginUrl,
} from "@/constants/auth";
import { getBrainUrl, type AuthMode } from "@/config";
import { redirectWithAuthTransition } from "@/lib/auth-transition";
import type { AuthState, AuthUser, EdgeJwtPayload } from "@/types/auth";

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

/** Result of a standalone login/register attempt. */
export interface AuthActionResult {
  ok: boolean;
  /** Human-readable error when ok is false. */
  error?: string;
}

interface AuthContextValue extends AuthState {
  /** Re-check the auth token */
  refresh: () => void;
  /** Log out — standalone clears the JWT; marketplace redirects to logout */
  logout: () => void;
  /** The resolved auth strategy ("disabled" | "standalone" | "marketplace"). */
  authMode: AuthMode;
  /** Standalone: sign in with email + password (brain-issued JWT). */
  login: (email: string, password: string) => Promise<AuthActionResult>;
  /** Standalone: one-shot admin bootstrap (only while uninitialized). */
  register: (email: string, password: string) => Promise<AuthActionResult>;
}

const AuthContext = React.createContext<AuthContextValue | null>(null);

/** Trim trailing slashes from the brain base URL for safe concatenation. */
function brainBase(): string {
  return getBrainUrl().replace(/\/+$/, "");
}

/** Map a brain /auth/* error response to a human-readable message. */
function authErrorMessage(data: unknown, status: number): string {
  const d = (data ?? {}) as {
    error?: string;
    details?: Array<{ message?: string }>;
    retryAfterSec?: number;
  };
  switch (d.error) {
    case "invalid_credentials":
      return "Incorrect email or password.";
    case "already_initialized":
      return "This Calla instance is already set up. Please sign in instead.";
    case "too_many_attempts":
      return `Too many failed attempts. Try again in ${d.retryAfterSec ?? 60}s.`;
    case "invalid_request": {
      const detail = Array.isArray(d.details)
        ? d.details
            .map((x) => x?.message)
            .filter(Boolean)
            .join("; ")
        : "";
      return detail || "Please enter a valid email and a password of at least 10 characters.";
    }
    case "store_unavailable":
      return "The Calla brain store is unavailable. Please try again shortly.";
    default:
      break;
  }
  if (status === 401) return "Incorrect email or password.";
  if (status >= 500) return "The Calla brain hit an error. Please try again.";
  return "Authentication failed. Please try again.";
}

// ─── Synthetic Local Dev User ────────────────────────────────────

const LOCAL_DEV_USER: AuthUser = {
  id: "local-dev",
  email: "developer@localhost",
  name: "Local Developer",
  emailVerified: true,
  role: "buyer",
  status: "active",
};

// ─── Storage helpers (new key + legacy migration) ───────────────

function storeEdgeJwt(token: string): void {
  try {
    localStorage.setItem(EDGE_JWT_STORAGE_KEY, token);
  } catch {
    // localStorage might be blocked
  }
}

function clearEdgeJwt(): void {
  try {
    localStorage.removeItem(EDGE_JWT_STORAGE_KEY);
    // Drop the legacy Edge Console key too once we've re-authed.
    localStorage.removeItem(LEGACY_EDGE_JWT_STORAGE_KEY);
  } catch {
    // ignore
  }
}

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

  /**
   * Standalone (self-hosted) auth check.
   *
   * Reads the brain-issued JWT from the SAME localStorage key the custom-domain
   * flow uses (calla_jwt) so authFetch / buildAuthedWsUrl / getEdgeJwt keep
   * working unchanged. Verifies it against the brain's /auth/me. NEVER
   * redirects and NEVER polls — the AuthGuard renders <Login/> when
   * unauthenticated, and re-checks happen on window focus only.
   */
  const checkStandalone = React.useCallback(async () => {
    const base = brainBase();
    const token = readStoredEdgeJwt();

    const unauthenticated = (prev: AuthState): AuthState =>
      prev.isAuthenticated || prev.isLoading || prev.user || prev.error
        ? {
            isAuthenticated: false,
            authDisabled: false,
            isLoading: false,
            user: null,
            token: null,
            error: null,
            isCustomDomain: false,
          }
        : prev;

    // Best-effort reachability/mode probe. Failure is non-fatal — /auth/me
    // below is the real signal.
    try {
      await fetch(`${base}/auth/status`, { headers: { Accept: "application/json" } });
    } catch {
      // brain unreachable; fall through
    }

    if (!token) {
      setState(unauthenticated);
      return;
    }

    try {
      const res = await fetch(`${base}/auth/me`, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
      });
      if (!res.ok) {
        // Invalid / expired token → drop it and show the Login page.
        clearEdgeJwt();
        setState(unauthenticated);
        return;
      }
      const claims = (await res.json()) as { sub: string; email: string; role?: string };
      const user: AuthUser = {
        id: claims.sub,
        email: claims.email,
        name: claims.email,
        emailVerified: true,
        role: "operator",
        status: "active",
      };
      setState((prev) =>
        prev.isAuthenticated && prev.token === token && prev.user?.id === user.id
          ? prev
          : {
              isAuthenticated: true,
              authDisabled: false,
              isLoading: false,
              user,
              token,
              error: null,
              isCustomDomain: false,
            },
      );
    } catch {
      // Network error verifying — keep the token (could be transient) but mark
      // unauthenticated so the Login page is shown; focus re-check retries.
      setState(unauthenticated);
    }
  }, []);

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

    // ─── Standalone Path: brain-issued JWT (self-hosted) ──────────
    if (AUTH_MODE === "standalone") {
      await checkStandalone();
      return;
    }

    // ─── Custom Domain Path: Edge JWT ──────────────────────
    if (usingCustomDomain) {
      // Check if we just received a token from the exchange redirect
      const exchangeToken = getQueryParam("edge_token");
      if (exchangeToken) {
        // Store the token from the URL
        storeEdgeJwt(exchangeToken);
        // Clean the URL (remove ?edge_token=xxx)
        removeQueryParam("edge_token");
      }

      // Read token: URL exchange → calla_token cookie → calla_jwt storage
      // (readStoredEdgeJwt also falls back to the legacy edge_console_jwt key)
      const token = exchangeToken || getCookie(EDGE_JWT_COOKIE) || readStoredEdgeJwt();

      if (!token) {
        // No token — redirect to token exchange (with overlay to avoid UI flash)
        const returnUrl = window.location.href;
        redirectWithAuthTransition(buildTokenExchangeUrl(returnUrl));
        return; // Page will redirect
      }

      // Decode and validate the edge JWT
      const payload = decodeJwtPayload(token);
      const msLeft = payload?.exp ? payload.exp * 1000 - Date.now() : 0;
      if (!payload || msLeft <= 0) {
        // Token expired — clean up and redirect to exchange
        clearEdgeJwt();
        const returnUrl = window.location.href;
        redirectWithAuthTransition(
          buildTokenExchangeUrl(returnUrl),
          "Session expired — re-authenticating…",
        );
        return;
      }

      // Proactively refresh before expiry (while the BFF session is still
      // valid) so in-flight requests never hit a 401.
      if (msLeft < EDGE_JWT_REFRESH_WINDOW_MS) {
        const returnUrl = window.location.href;
        redirectWithAuthTransition(
          buildTokenExchangeUrl(returnUrl),
          "Refreshing session…",
        );
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

      // Periodic re-checks must not re-render the app when nothing changed.
      setState((prev) =>
        prev.isAuthenticated && prev.token === token && prev.user?.id === user.id
          ? prev
          : {
              isAuthenticated: true,
              authDisabled: false,
              isLoading: false,
              user,
              token,
              error: null,
              isCustomDomain: true,
            },
      );
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
  }, [usingCustomDomain, checkStandalone]);

  // Initial auth check
  React.useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  // Periodic re-check. Skipped in standalone mode: the brain JWT is long-lived
  // (default 7 days) and verified on focus, so a 15s poll would only add load.
  React.useEffect(() => {
    if (AUTH_DISABLED) return;
    if (AUTH_MODE === "standalone") return;
    const interval = setInterval(() => {
      checkAuth();
    }, AUTH_CHECK_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [checkAuth]);

  // Re-check on window focus (also the only re-check cadence in standalone).
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

  /**
   * Standalone: POST /auth/login, persist the brain JWT, refresh auth state.
   */
  const login = React.useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      try {
        const res = await fetch(`${brainBase()}/auth/login`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.token) {
          return { ok: false, error: authErrorMessage(data, res.status) };
        }
        storeEdgeJwt(data.token as string);
        await checkStandalone();
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "Cannot reach the Calla brain. Check your connection and BRAIN_URL.",
        };
      }
    },
    [checkStandalone],
  );

  /**
   * Standalone: POST /auth/register (one-shot admin bootstrap), persist the
   * brain JWT, refresh auth state.
   */
  const register = React.useCallback(
    async (email: string, password: string): Promise<AuthActionResult> => {
      try {
        const res = await fetch(`${brainBase()}/auth/register`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ email, password }),
        });
        const data = await res.json().catch(() => null);
        if (!res.ok || !data?.token) {
          return { ok: false, error: authErrorMessage(data, res.status) };
        }
        storeEdgeJwt(data.token as string);
        await checkStandalone();
        return { ok: true };
      } catch {
        return {
          ok: false,
          error: "Cannot reach the Calla brain. Check your connection and BRAIN_URL.",
        };
      }
    },
    [checkStandalone],
  );

  const logout = React.useCallback(() => {
    // Standalone: best-effort server-side audit, clear the JWT, show <Login/>.
    // No marketplace redirect.
    if (AUTH_MODE === "standalone") {
      const token = readStoredEdgeJwt();
      const headers: Record<string, string> = { Accept: "application/json" };
      if (token) headers.Authorization = `Bearer ${token}`;
      fetch(`${brainBase()}/auth/logout`, { method: "POST", headers }).catch(() => {});
      clearEdgeJwt();
      setState({
        isAuthenticated: false,
        authDisabled: false,
        isLoading: false,
        user: null,
        token: null,
        error: null,
        isCustomDomain: false,
      });
      return;
    }

    // Clear local edge JWT if on custom domain
    if (usingCustomDomain) {
      clearEdgeJwt();
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
    () => ({ ...state, refresh, logout, authMode: AUTH_MODE, login, register }),
    [state, refresh, logout, login, register],
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
    return readStoredEdgeJwt();
  }

  // Subdomain auth: return "session" — the actual auth is via cookie.
  // Callers use credentials: "include" to send the cookie automatically.
  return "session";
}
