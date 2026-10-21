/**
 * Postgres connection-string classifier.
 *
 * URL-classifier patterns adapted from @elizaos/plugin-sql
 * (MIT, (c) 2025 Shaw Walters and elizaOS Contributors) — their
 * `isRealPostgresDatabase()` rejects embedded/SQLite-ish strings and accepts
 * postgres:// URLs (fly.dev/fly.io, localhost, AWS RDS, Neon, Supabase, ...).
 *
 * Calla's storage selection is CONNECTION-STRING-PRESENCE driven (same as
 * ElizaOS, NOT NODE_ENV driven): a real Postgres URL in DATABASE_URL selects
 * the Postgres adapter; anything else falls back to the embedded LibSQL file.
 */

/** Host suffixes that are unambiguously managed/hosted Postgres. */
const KNOWN_POSTGRES_HOSTS = [
  "fly.dev",
  "fly.io",
  "localhost",
  "127.0.0.1",
  "aws.com", // *.rds.amazonaws.com
  "neon.tech",
  "supabase.co",
  "render.com",
  "railway.app",
  "railway.internal",
  "postgres.database.azure.com",
  "cloudsql.google.internal",
];

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * True when `url` is a real, remote-or-local Postgres connection string.
 * Rejects `:memory:`, `sqlite*`, `file:*.db` and other embedded-store URLs
 * even when they are (mis)configured as DATABASE_URL.
 */
export function isRealPostgresUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (lower.includes(":memory:")) return false;
  if (lower.includes("sqlite")) return false;
  if (lower.startsWith("file:")) return false;
  if (/\.(db|sqlite|sqlite3)(\?.*)?$/.test(lower)) return false;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }

  const proto = parsed.protocol.replace(/:$/, "");
  if (proto !== "postgres" && proto !== "postgresql") return false;

  const host = parsed.hostname.toLowerCase();
  if (!host) return false;

  if (IPV4_RE.test(host)) return true;
  if (KNOWN_POSTGRES_HOSTS.some((k) => host === k || host.endsWith(`.${k}`))) return true;

  // Any other host with a genuine pg scheme is still treated as Postgres
  // (custom domains, self-hosted clusters). Presence of the scheme is the
  // signal — mirroring ElizaOS's connection-string-presence-driven selection.
  return true;
}
