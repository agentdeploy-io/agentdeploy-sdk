/**
 * Edge worker request authorization.
 * ──────────────────────────────────
 * Two independent credentials protect the worker:
 *
 *  1. USER JWT (self-hosted / standalone mode) — an HS256 Calla JWT signed by
 *     the brain with CALLA_JWT_SECRET. Required on user-facing routes
 *     (/steps, /approvals, /state, /fleet, /audit*, /events, /events/recent)
 *     whenever CALLA_JWT_SECRET is configured. Presented via
 *     `Authorization: Bearer <jwt>` or `?token=<jwt>` (WebSockets can't set
 *     headers).
 *
 *  2. SERVICE token (EVENTS_AUTH_TOKEN) — a shared secret for machine relays
 *     (jev classifier / brain) to POST /events/ingest WITHOUT a user JWT.
 *
 * If NEITHER secret is configured the worker is open (local dev). When only
 * EVENTS_AUTH_TOKEN is set (legacy), it is still accepted on user routes so
 * existing deployments keep working; the primary path is the user JWT.
 *
 * Verification uses `verifyCallaToken` from @calla/shared (jose / WebCrypto),
 * the exact same routine the brain uses — so one secret protects both.
 */
import { verifyCallaToken, type CallaJwtClaims } from "@calla/shared";
import type { Env } from "./env";

export type AuthResult =
  | { ok: true; claims?: CallaJwtClaims }
  | { ok: false; reason: string };

/**
 * Pull a credential from `Authorization: Bearer`, `x-calla-token`, or
 * `?token=` (in that order). The query form is what WebSockets use.
 */
export function extractToken(request: Request, url?: URL): string | null {
  const authz = request.headers.get("authorization");
  if (authz) {
    const space = authz.indexOf(" ");
    const scheme = space === -1 ? authz : authz.slice(0, space);
    const value = space === -1 ? "" : authz.slice(space + 1).trim();
    if (scheme.toLowerCase() === "bearer" && value) return value;
  }
  const header = request.headers.get("x-calla-token");
  if (header) return header;
  const query = (url ?? new URL(request.url)).searchParams.get("token");
  if (query) return query;
  return null;
}

/**
 * Authorize a USER-facing route.
 *
 * - CALLA_JWT_SECRET set → a valid Calla JWT is required (claims returned).
 * - else EVENTS_AUTH_TOKEN set → that service token is accepted (legacy).
 * - else → open (local dev).
 */
export async function authorizeRequest(
  request: Request,
  env: Env,
): Promise<AuthResult> {
  const jwtSecret = env.CALLA_JWT_SECRET?.trim();
  const serviceToken = env.EVENTS_AUTH_TOKEN?.trim();
  if (!jwtSecret && !serviceToken) return { ok: true };

  const token = extractToken(request);
  if (!token) return { ok: false, reason: "missing_token" };

  if (jwtSecret) {
    const claims = await verifyCallaToken(token, jwtSecret);
    if (claims) return { ok: true, claims };
  }
  if (serviceToken && token === serviceToken) return { ok: true };

  return { ok: false, reason: "invalid_token" };
}
