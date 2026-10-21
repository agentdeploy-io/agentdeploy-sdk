/**
 * Self-hosted (standalone) auth routes for the Calla brain.
 * ─────────────────────────────────────────────────────────
 * A Hono sub-app mounted at /auth (see server.ts). It issues the SAME HS256
 * JWTs the edge worker verifies (@calla/shared), so a self-hosted deployment
 * needs no agentdeploy.io / marketplace dependency.
 *
 *   GET  /auth/status            → { mode: "standalone", initialized }
 *   POST /auth/register          → one-shot admin bootstrap (only when empty)
 *   POST /auth/login             → scrypt verify + rate limit → { token, user }
 *   GET  /auth/me      (Bearer)  → verified claims | 401
 *   POST /auth/logout  (Bearer)  → best-effort audit row → { ok: true }
 *
 * Signing secret: process.env.CALLA_JWT_SECRET. When unset we generate an
 * ephemeral secret once and WARN loudly — tokens then invalidate on restart.
 * Lifetime: process.env.CALLA_AUTH_TTL_DAYS (default 7 days).
 */
import { createHash, randomBytes } from "node:crypto";
import { Hono } from "hono";
import { z } from "zod";
import {
  CALLA_JWT_DEFAULT_TTL_SECONDS,
  signCallaToken,
  verifyCallaToken,
} from "@calla/shared";
import type { CallaStore } from "../store/index.js";
import { hashPassword, verifyPassword } from "./password.js";

// ─── Secret / TTL resolution ─────────────────────────────────────

let ephemeralSecret: string | null = null;

function resolveSecret(): string {
  const env = process.env.CALLA_JWT_SECRET?.trim();
  if (env) return env;
  if (!ephemeralSecret) {
    ephemeralSecret = randomBytes(32).toString("hex");
    console.warn(
      "[calla-brain] WARNING: CALLA_JWT_SECRET is not set — generated an EPHEMERAL " +
        "signing secret. Standalone sessions will be INVALIDATED on every brain restart. " +
        "Set CALLA_JWT_SECRET (e.g. `openssl rand -hex 32`) for persistent logins.",
    );
  }
  return ephemeralSecret;
}

function resolveTtlSeconds(): number {
  const days = Number(process.env.CALLA_AUTH_TTL_DAYS);
  if (Number.isFinite(days) && days > 0) return Math.floor(days * 86_400);
  return CALLA_JWT_DEFAULT_TTL_SECONDS;
}

// ─── In-memory login rate limit (per email + IP) ─────────────────

interface RateBucket {
  fails: number;
  lockedUntil: number;
  updatedAt: number;
}

const rateBuckets = new Map<string, RateBucket>();
const RATE_MAX_FAILS = 5;
const RATE_LOCK_MS = 60_000;
const RATE_SWEEP_MS = 60_000;

function rateKey(email: string, ip: string): string {
  return `${email}|${ip}`;
}

/** Remaining lock duration in ms (0 when not locked). */
function lockedMs(key: string): number {
  const b = rateBuckets.get(key);
  if (!b) return 0;
  const now = Date.now();
  return b.lockedUntil > now ? b.lockedUntil - now : 0;
}

function recordFailure(key: string): void {
  const now = Date.now();
  const b = rateBuckets.get(key) ?? { fails: 0, lockedUntil: 0, updatedAt: now };
  b.fails += 1;
  b.updatedAt = now;
  if (b.fails >= RATE_MAX_FAILS) {
    b.lockedUntil = now + RATE_LOCK_MS;
    b.fails = 0;
  }
  rateBuckets.set(key, b);
}

function recordSuccess(key: string): void {
  rateBuckets.delete(key);
}

function sweep(): void {
  const now = Date.now();
  for (const [k, b] of rateBuckets) {
    if (b.lockedUntil <= now && now - b.updatedAt > RATE_LOCK_MS) rateBuckets.delete(k);
  }
}

// Prune stale buckets so the Map can't grow unbounded. unref() keeps this
// timer from holding the process open.
const sweeper = setInterval(sweep, RATE_SWEEP_MS);
sweeper.unref?.();

// ─── Request helpers ─────────────────────────────────────────────

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const registerSchema = z.object({
  email: z
    .string()
    .trim()
    .refine((v) => EMAIL_RE.test(v), { message: "invalid email address" }),
  password: z.string().min(10, "password must be at least 10 characters"),
});

const loginSchema = z.object({
  email: z.string().trim().min(1),
  password: z.string().min(1),
});

type Ctx = { req: { header(name: string): string | undefined; query(name: string): string | undefined } };

function clientIp(c: Ctx): string {
  const xff = c.req.header("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return c.req.header("x-real-ip") ?? "local";
}

/** Truncated SHA-256 of the client IP — audit-friendly, not reversible. */
function hashIp(ip: string): string {
  return createHash("sha256").update(ip).digest("hex").slice(0, 16);
}

function bearerToken(c: Ctx): string | null {
  const header = c.req.header("Authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme?.toLowerCase() === "bearer" && value) return value.trim();
  return c.req.query("token") ?? null;
}

/** Best-effort hash-chained audit append — never breaks the auth response. */
async function audit(
  store: CallaStore,
  kind: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await store.appendAudit({ agentId: null, kind, entry });
  } catch (err) {
    console.error(`[calla-brain] auth audit (${kind}) failed:`, err);
  }
}

// ─── App factory ─────────────────────────────────────────────────

export interface AuthAppDeps {
  store: CallaStore;
}

export function createAuthApp(deps: AuthAppDeps): Hono {
  const { store } = deps;
  const app = new Hono();

  // GET /auth/status — is the standalone instance initialized (any users)?
  app.get("/status", async (c) => {
    let initialized = false;
    try {
      initialized = (await store.countUsers()) > 0;
    } catch (err) {
      console.error("[calla-brain] /auth/status countUsers failed:", err);
    }
    return c.json({ mode: "standalone", initialized });
  });

  // POST /auth/register — one-shot admin bootstrap while there are no users.
  app.post("/register", async (c) => {
    let count: number;
    try {
      count = await store.countUsers();
    } catch (err) {
      console.error("[calla-brain] /auth/register countUsers failed:", err);
      return c.json({ error: "store_unavailable" }, 503);
    }
    if (count > 0) return c.json({ error: "already_initialized" }, 403);

    const body = await c.req.json().catch(() => null);
    const parsed = registerSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
    }

    const email = parsed.data.email.toLowerCase();
    let passwordHash: string;
    try {
      passwordHash = await hashPassword(parsed.data.password);
    } catch (err) {
      console.error("[calla-brain] /auth/register hashPassword failed:", err);
      return c.json({ error: "hash_failed" }, 500);
    }

    let user;
    try {
      user = await store.createUser({ email, passwordHash, role: "admin" });
    } catch (err) {
      // Most likely a UNIQUE(email) race — treat as already initialized.
      console.error("[calla-brain] /auth/register createUser failed:", err);
      return c.json({ error: "already_initialized" }, 403);
    }

    const token = await signCallaToken(
      { sub: user.id, email: user.email, role: user.role },
      resolveSecret(),
      resolveTtlSeconds(),
    );
    await audit(store, "auth.register", {
      email: user.email,
      userId: user.id,
      ip: hashIp(clientIp(c)),
    });
    return c.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  // POST /auth/login — verify scrypt hash, rate-limit failures, mint a JWT.
  app.post("/login", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "invalid_request", details: parsed.error.issues }, 400);
    }

    const email = parsed.data.email.toLowerCase();
    const ip = clientIp(c);
    const key = rateKey(email, ip);

    const lockFor = lockedMs(key);
    if (lockFor > 0) {
      return c.json(
        { error: "too_many_attempts", retryAfterSec: Math.ceil(lockFor / 1000) },
        429,
      );
    }

    let user;
    try {
      user = await store.findUserByEmail(email);
    } catch (err) {
      console.error("[calla-brain] /auth/login findUserByEmail failed:", err);
      return c.json({ error: "store_unavailable" }, 503);
    }

    const ok = user ? await verifyPassword(parsed.data.password, user.passwordHash) : false;
    if (!ok || !user) {
      recordFailure(key);
      await audit(store, "auth.login_failed", { email, ip: hashIp(ip) });
      return c.json({ error: "invalid_credentials" }, 401);
    }

    recordSuccess(key);
    try {
      await store.touchUserLogin(user.id);
    } catch (err) {
      console.error("[calla-brain] /auth/login touchUserLogin failed:", err);
    }

    const token = await signCallaToken(
      { sub: user.id, email: user.email, role: user.role },
      resolveSecret(),
      resolveTtlSeconds(),
    );
    await audit(store, "auth.login", {
      email: user.email,
      userId: user.id,
      ip: hashIp(ip),
    });
    return c.json({ token, user: { id: user.id, email: user.email, role: user.role } });
  });

  // GET /auth/me — return the verified claims for a Bearer token.
  app.get("/me", async (c) => {
    const token = bearerToken(c);
    if (!token) return c.json({ error: "unauthorized" }, 401);
    const claims = await verifyCallaToken(token, resolveSecret());
    if (!claims) return c.json({ error: "unauthorized" }, 401);
    return c.json(claims);
  });

  // POST /auth/logout — stateless JWTs; just record a best-effort audit row.
  app.post("/logout", async (c) => {
    const token = bearerToken(c);
    const claims = token ? await verifyCallaToken(token, resolveSecret()) : null;
    await audit(store, "auth.logout", {
      email: claims?.email ?? null,
      userId: claims?.sub ?? null,
      ip: hashIp(clientIp(c)),
    });
    return c.json({ ok: true });
  });

  return app;
}
