/**
 * Password hashing for the self-hosted (standalone) auth mode.
 * ────────────────────────────────────────────────────────────
 * node:crypto `scrypt` (memory-hard KDF) with a per-password random salt.
 *
 * Stored format:  "scrypt:<saltB64>:<hashB64>"
 * Fixed params (baked into the format so verify needs no extra columns):
 *   N = 16384 (2^14), r = 8, p = 1, keyLen = 64 bytes, salt = 16 random bytes.
 *   Memory cost = 128 * N * r = 16 MiB per derivation (under node's 32 MiB
 *   default maxmem), ~tens of ms on commodity hardware — fine for login.
 *
 * Verification is constant-time (timingSafeEqual) and NEVER throws: a
 * malformed stored hash or any crypto error resolves to `false`.
 */
import { randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";

const SCRYPT_PREFIX = "scrypt";
const SALT_BYTES = 16;
const KEY_LEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

/** Promisified scrypt (avoids blocking the event loop during login bursts). */
function scryptAsync(
  password: string | Buffer,
  salt: Buffer,
  keyLen: number,
  params: { N: number; r: number; p: number; maxmem: number },
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    _scrypt(password, salt, keyLen, params, (err, derived) => {
      if (err) reject(err);
      else resolve(derived);
    });
  });
}

/**
 * Hash a plaintext password into the stored "scrypt:<saltB64>:<hashB64>" form.
 */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const derived = await scryptAsync(password, salt, KEY_LEN, SCRYPT_PARAMS);
  return `${SCRYPT_PREFIX}:${salt.toString("base64")}:${derived.toString("base64")}`;
}

/**
 * Constant-time verify a plaintext password against a stored hash.
 * Returns false for any malformed input — never throws.
 */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    if (typeof stored !== "string") return false;
    const parts = stored.split(":");
    if (parts.length !== 3 || parts[0] !== SCRYPT_PREFIX) return false;
    const salt = Buffer.from(parts[1], "base64");
    const expected = Buffer.from(parts[2], "base64");
    if (salt.length === 0 || expected.length === 0) return false;
    const derived = await scryptAsync(password, salt, expected.length, SCRYPT_PARAMS);
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
