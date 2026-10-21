/// <reference lib="dom" />
/**
 * Calla self-hosted JWT primitives.
 * ─────────────────────────────────
 * Symmetric (HS256) JSON Web Tokens shared by the brain (issues) and the edge
 * worker (verifies) so a self-hosted Calla deployment needs NO dependency on
 * agentdeploy.io / the marketplace.
 *
 * Built on `jose` — a WebCrypto-based JOSE implementation that runs unchanged
 * in Node 20+ (brain) AND Cloudflare Workers (edge). The compact JWT is signed
 * with a shared secret (CALLA_JWT_SECRET) present on both runtimes.
 *
 * Contract:
 *   alg: HS256,  typ: JWT,  iss: "calla"
 *   claims: { sub, email, role: "admin" | "operator", iat, exp, iss }
 *   default ttl: 7 days
 *
 * `verifyCallaToken` NEVER throws: expired / bad-signature / malformed tokens
 * all resolve to `null`, so callers can treat verification as a plain boolean.
 */
import { SignJWT, jwtVerify } from "jose";

/** Roles a Calla JWT can carry. `admin` is the bootstrap superuser. */
export type CallaUserRole = "admin" | "operator";

/** Verified Calla JWT payload (all fields guaranteed present after verify). */
export interface CallaJwtClaims {
  /** Subject — the calla_users.id (uuid). */
  sub: string;
  /** Account email (lower-cased at issue time). */
  email: string;
  /** Authorization role. */
  role: CallaUserRole;
  /** Issued-at (epoch seconds). */
  iat: number;
  /** Expiry (epoch seconds). */
  exp: number;
  /** Issuer — always "calla". */
  iss: string;
}

/** Payload used to mint a token (iat/exp/iss are added by signCallaToken). */
export interface SignCallaTokenInput {
  sub: string;
  email: string;
  role: CallaUserRole;
}

/** Fixed JWT metadata — kept as constants so brain + edge never drift. */
export const CALLA_JWT_ISSUER = "calla";
export const CALLA_JWT_ALG = "HS256";
/** 7 days in seconds. */
export const CALLA_JWT_DEFAULT_TTL_SECONDS = 7 * 24 * 60 * 60;

function encodeSecret(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

/**
 * Sign an HS256 Calla JWT.
 *
 * @param input       { sub, email, role }
 * @param secret      shared HMAC secret (CALLA_JWT_SECRET)
 * @param ttlSeconds  token lifetime; defaults to 7 days
 * @returns           the compact JWS string (header.payload.signature)
 */
export async function signCallaToken(
  input: SignCallaTokenInput,
  secret: string,
  ttlSeconds: number = CALLA_JWT_DEFAULT_TTL_SECONDS,
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ email: input.email, role: input.role })
    .setProtectedHeader({ alg: CALLA_JWT_ALG, typ: "JWT" })
    .setSubject(input.sub)
    .setIssuer(CALLA_JWT_ISSUER)
    .setIssuedAt(now)
    .setExpirationTime(now + Math.max(1, Math.floor(ttlSeconds)))
    .sign(encodeSecret(secret));
}

/**
 * Verify an HS256 Calla JWT against the shared secret.
 *
 * Enforces signature, expiry, issuer ("calla") and algorithm (HS256), then
 * narrows the payload to {@link CallaJwtClaims}. Returns `null` for ANY
 * failure (never throws) so it is safe to call on untrusted input.
 */
export async function verifyCallaToken(
  token: string,
  secret: string,
): Promise<CallaJwtClaims | null> {
  if (!token || !secret) return null;
  try {
    const { payload } = await jwtVerify(token, encodeSecret(secret), {
      issuer: CALLA_JWT_ISSUER,
      algorithms: [CALLA_JWT_ALG],
    });
    const { sub, email, role, iat, exp } = payload as Record<string, unknown>;
    if (typeof sub !== "string" || sub.length === 0) return null;
    if (typeof email !== "string" || email.length === 0) return null;
    if (role !== "admin" && role !== "operator") return null;
    if (typeof iat !== "number" || typeof exp !== "number") return null;
    return {
      sub,
      email,
      role,
      iat,
      exp,
      iss: typeof payload.iss === "string" ? payload.iss : CALLA_JWT_ISSUER,
    };
  } catch {
    return null;
  }
}
