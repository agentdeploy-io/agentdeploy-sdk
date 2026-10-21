/**
 * OAuth (authorization-code) helpers for the booking providers — global fetch
 * only, every base URL overridable by env so the module is mock-testable:
 *
 *   GOOGLE_OAUTH_BASE   (default https://accounts.google.com)     authorize
 *   GOOGLE_OAUTH_TOKEN_BASE (default https://oauth2.googleapis.com) token —
 *       when GOOGLE_OAUTH_BASE is overridden and this is unset, the override
 *       is used for the token endpoint too (single-host mocks).
 *   GOOGLE_API_BASE     (default https://www.googleapis.com)      Calendar API
 *   MICROSOFT_OAUTH_BASE (default https://login.microsoftonline.com)
 *   GRAPH_API_BASE      (default https://graph.microsoft.com/v1.0)
 *   CALENDLY_API_BASE   (default https://api.calendly.com)
 *
 * Calendly needs NO OAuth for the core flow (scheduling link + signed
 * webhook); CALENDLY_ACCESS_TOKEN is optional, for API lookups/cancels.
 *
 * CSRF: buildAuthUrl callers persist a random `state` via BookingStore
 * (store cache, 10-min TTL, single-use) and the callback validates it.
 */
import { randomBytes } from "node:crypto";
import {
  BookingApiError,
  type BookingProvider,
  type ConnectionRecord,
  type FreshConnection,
  type OAuthStateRecord,
  type TokenResponse,
} from "./types.js";
import type { BookingStore } from "./store.js";

// ─── Config ──────────────────────────────────────────────────────

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function stripSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

export interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Authorize base (accounts.google.com). */
  oauthBase: string;
  /** Token endpoint base (oauth2.googleapis.com unless mocked). */
  tokenBase: string;
  /** Calendar API base (www.googleapis.com). */
  apiBase: string;
  redirectUri: string;
  scope: string;
}

export interface MicrosoftOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** login.microsoftonline.com. */
  oauthBase: string;
  /** graph.microsoft.com/v1.0. */
  graphBase: string;
  /** MICROSOFT_TENANT_ID or "common". */
  tenantId: string;
  redirectUri: string;
  scope: string;
  /** Expected Graph subscription clientState (falls back to BOOKING_WEBHOOK_SECRET). */
  clientState: string;
}

export interface CalendlyConfig {
  apiBase: string;
  webhookSecret: string;
  /** Optional personal access token (API lookups; NOT needed for webhooks). */
  accessToken: string;
}

export interface BookingConfig {
  /** Explicit BOOKING_PUBLIC_URL (used for webhook/watch registration). */
  publicUrl: string;
  /** Whether BOOKING_PUBLIC_URL was explicitly configured. */
  publicUrlExplicit: boolean;
  google: GoogleOAuthConfig;
  microsoft: MicrosoftOAuthConfig;
  calendly: CalendlyConfig;
  /** Shared booking webhook secret (Google channel token / Graph clientState default). */
  webhookSecret: string;
}

export const GOOGLE_SCOPE =
  "https://www.googleapis.com/auth/calendar.events openid email";
export const MICROSOFT_SCOPE = "Calendars.ReadWrite offline_access User.Read";

/** Pure env → config snapshot (read at request time so mocks just work). */
export function readBookingConfig(): BookingConfig {
  const env = process.env;
  const port = Number(clean(env.PORT) ?? "") || 3000;
  const explicitPublic = clean(env.BOOKING_PUBLIC_URL);
  const publicUrl = stripSlash(explicitPublic ?? `http://localhost:${port}`);

  const googleOAuthBase = stripSlash(clean(env.GOOGLE_OAUTH_BASE) ?? "https://accounts.google.com");
  const googleTokenBase = stripSlash(
    clean(env.GOOGLE_OAUTH_TOKEN_BASE) ??
      // Mock-friendly: an overridden authorize base also hosts /token.
      (clean(env.GOOGLE_OAUTH_BASE) ? googleOAuthBase : "https://oauth2.googleapis.com"),
  );
  const googleApiBase = stripSlash(clean(env.GOOGLE_API_BASE) ?? "https://www.googleapis.com");

  return {
    publicUrl,
    publicUrlExplicit: Boolean(explicitPublic),
    google: {
      clientId: clean(env.GOOGLE_OAUTH_CLIENT_ID) ?? "",
      clientSecret: clean(env.GOOGLE_OAUTH_CLIENT_SECRET) ?? "",
      oauthBase: googleOAuthBase,
      tokenBase: googleTokenBase,
      apiBase: googleApiBase,
      redirectUri:
        clean(env.GOOGLE_REDIRECT_URI) ??
        `${publicUrl}/booking/connect/google/callback`,
      scope: GOOGLE_SCOPE,
    },
    microsoft: {
      clientId: clean(env.MICROSOFT_CLIENT_ID) ?? "",
      clientSecret: clean(env.MICROSOFT_CLIENT_SECRET) ?? "",
      oauthBase: stripSlash(clean(env.MICROSOFT_OAUTH_BASE) ?? "https://login.microsoftonline.com"),
      graphBase: stripSlash(clean(env.GRAPH_API_BASE) ?? "https://graph.microsoft.com/v1.0"),
      tenantId: clean(env.MICROSOFT_TENANT_ID) ?? "common",
      redirectUri:
        clean(env.MICROSOFT_REDIRECT_URI) ??
        `${publicUrl}/booking/connect/microsoft/callback`,
      scope: MICROSOFT_SCOPE,
      clientState: clean(env.MICROSOFT_CLIENT_STATE) ?? clean(env.BOOKING_WEBHOOK_SECRET) ?? "",
    },
    calendly: {
      apiBase: stripSlash(clean(env.CALENDLY_API_BASE) ?? "https://api.calendly.com"),
      webhookSecret: clean(env.CALENDLY_WEBHOOK_SECRET) ?? "",
      accessToken: clean(env.CALENDLY_ACCESS_TOKEN) ?? "",
    },
    webhookSecret: clean(env.BOOKING_WEBHOOK_SECRET) ?? "",
  };
}

// ─── State (CSRF) ────────────────────────────────────────────────

/** Cryptographically-random OAuth state token (base64url, 192-bit). */
export function randomOAuthState(): string {
  return randomBytes(24).toString("base64url");
}

// ─── Authorize URL ───────────────────────────────────────────────

export function buildAuthUrl(
  provider: BookingProvider,
  cfg: BookingConfig,
  state: string,
): string {
  if (provider === "calendly") {
    throw new BookingApiError("calendly does not use OAuth — link the scheduling URL instead");
  }
  if (provider === "google") {
    const g = cfg.google;
    const params = new URLSearchParams({
      client_id: g.clientId,
      redirect_uri: g.redirectUri,
      response_type: "code",
      scope: g.scope,
      state,
      // Offline refresh + show the consent screen so a refresh_token is issued.
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    return `${g.oauthBase}/o/oauth2/v2/auth?${params.toString()}`;
  }
  const m = cfg.microsoft;
  const params = new URLSearchParams({
    client_id: m.clientId,
    response_type: "code",
    redirect_uri: m.redirectUri,
    response_mode: "query",
    scope: m.scope,
    state,
    // offline_access yields the refresh token; prompt=consent forces issue.
    prompt: "select_account",
  });
  return `${m.oauthBase}/${encodeURIComponent(m.tenantId)}/oauth2/v2.0/authorize?${params.toString()}`;
}

// ─── Token exchange / refresh ────────────────────────────────────

function tokenEndpoint(provider: "google" | "microsoft", cfg: BookingConfig): string {
  return provider === "google"
    ? `${cfg.google.tokenBase}/token`
    : `${cfg.microsoft.oauthBase}/${encodeURIComponent(cfg.microsoft.tenantId)}/oauth2/v2.0/token`;
}

function expiresAtFrom(expiresIn: unknown): string | undefined {
  const secs = Number(expiresIn);
  if (!Number.isFinite(secs) || secs <= 0) return undefined;
  // 60s safety margin so tokens are refreshed before they actually lapse.
  return new Date(Date.now() + Math.max(60, secs - 60) * 1000).toISOString();
}

async function postTokenForm(url: string, form: URLSearchParams): Promise<TokenResponse> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: form.toString(),
  });
  const json = (await res.json().catch(() => null)) as
    | {
        access_token?: string;
        refresh_token?: string;
        expires_in?: number;
        scope?: string;
        token_type?: string;
        error?: string;
        error_description?: string;
      }
    | null;
  if (!res.ok || !json?.access_token) {
    throw new BookingApiError(
      `token exchange failed: ${json?.error_description ?? json?.error ?? `HTTP ${res.status}`}`,
      res.status,
    );
  }
  return {
    accessToken: json.access_token,
    ...(json.refresh_token ? { refreshToken: json.refresh_token } : {}),
    ...(expiresAtFrom(json.expires_in) ? { expiresAt: expiresAtFrom(json.expires_in) } : {}),
    ...(json.scope ? { scope: json.scope } : {}),
    ...(json.token_type ? { tokenType: json.token_type } : {}),
  };
}

/** Exchange an authorization code for tokens (Google / Microsoft). */
export async function exchangeCode(
  provider: "google" | "microsoft",
  cfg: BookingConfig,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  const c = provider === "google" ? cfg.google : cfg.microsoft;
  return postTokenForm(
    tokenEndpoint(provider, cfg),
    new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
      code,
    }),
  );
}

/** Refresh an access token; keeps the previous refresh_token when not rotated. */
export async function refreshAccessToken(
  provider: "google" | "microsoft",
  cfg: BookingConfig,
  conn: ConnectionRecord,
): Promise<TokenResponse> {
  if (!conn.refreshToken) {
    throw new BookingApiError("no refresh token stored — reconnect required");
  }
  const c = provider === "google" ? cfg.google : cfg.microsoft;
  return postTokenForm(
    tokenEndpoint(provider, cfg),
    new URLSearchParams({
      client_id: c.clientId,
      client_secret: c.clientSecret,
      grant_type: "refresh_token",
      refresh_token: conn.refreshToken,
    }),
  );
}

// ─── Profile lookup (accountId resolution) ───────────────────────

export interface ProviderProfile {
  accountId: string | null;
  email: string | null;
}

/** Best-effort "who am I" lookup; never throws (nulls on failure). */
export async function fetchProfile(
  provider: "google" | "microsoft",
  cfg: BookingConfig,
  accessToken: string,
): Promise<ProviderProfile> {
  try {
    if (provider === "google") {
      const res = await fetch(`${cfg.google.apiBase}/oauth2/v3/userinfo`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => null)) as
        | { sub?: string; email?: string }
        | null;
      if (res.ok && json) {
        return { accountId: json.sub ?? json.email ?? null, email: json.email ?? null };
      }
    } else {
      const res = await fetch(`${cfg.microsoft.graphBase}/me`, {
        headers: { authorization: `Bearer ${accessToken}` },
      });
      const json = (await res.json().catch(() => null)) as
        | { id?: string; mail?: string; userPrincipalName?: string }
        | null;
      if (res.ok && json) {
        return {
          accountId: json.id ?? null,
          email: json.mail ?? json.userPrincipalName ?? null,
        };
      }
    }
  } catch {
    // fall through — callers synthesize an accountId
  }
  return { accountId: null, email: null };
}

// ─── Fresh connection resolution (auto refresh) ──────────────────

const REFRESH_SKEW_MS = 5 * 60 * 1000;

/**
 * Load a connection and refresh it when expired/near-expiry.
 *  - missing connection           → { ok:false, reason:"not-connected" }
 *  - refresh failure / no refresh → { ok:false, reason:"reconnect-required" }
 *    (routes map this to HTTP 409 so the UI can restart the OAuth flow)
 */
export async function getFreshConnection(
  bookingStore: BookingStore,
  provider: "google" | "microsoft",
  accountId: string,
): Promise<FreshConnection> {
  const cfg = readBookingConfig();
  const conn = await bookingStore.getConnection(provider, accountId);
  if (!conn) return { ok: false, reason: "not-connected" };

  const expiresAt = conn.expiresAt ? Date.parse(conn.expiresAt) : NaN;
  const needsRefresh = Number.isFinite(expiresAt) && Date.now() >= expiresAt - REFRESH_SKEW_MS;
  if (!needsRefresh) return { ok: true, conn };

  if (!conn.refreshToken) {
    return { ok: false, reason: "reconnect-required", detail: "access token expired, no refresh token" };
  }
  try {
    const tokens = await refreshAccessToken(provider, cfg, conn);
    const refreshed: ConnectionRecord = {
      ...conn,
      accessToken: tokens.accessToken,
      // Google omits refresh_token on refresh; keep the stored one.
      refreshToken: tokens.refreshToken ?? conn.refreshToken,
      ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
    };
    await bookingStore.putConnection(refreshed);
    return { ok: true, conn: refreshed };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const status = err instanceof BookingApiError ? err.status : undefined;
    return {
      ok: false,
      reason: status !== undefined && status >= 500 ? "provider-error" : "reconnect-required",
      detail,
    };
  }
}

// ─── Misc ────────────────────────────────────────────────────────

/** Build the state record cached under booking:oauth:state:<state>. */
export function makeStateRecord(
  provider: BookingProvider,
  repId: string,
  redirectUri: string,
): OAuthStateRecord {
  return { provider, repId, redirectUri, createdAt: new Date().toISOString() };
}
