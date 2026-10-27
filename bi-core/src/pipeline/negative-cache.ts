// Negative cache for website-linking failures.
//
// The registry source harvests companies that have no website; `linkWebsite`
// spends an LLM call + search calls + fetches trying to find one. Most
// failures are permanent (small firms genuinely have no findable site), and
// without memory every cron run re-queries the same companies, burning
// Brave quota and LLM budget on identical failures forever.
//
// A failed link is remembered for 30 days (a site may appear later, so the
// entry expires). Disk-backed like brave-usage.json so it survives VM
// restarts. Best-effort: any fs failure degrades to "no cache".

import * as fs from "node:fs";
import * as path from "node:path";

const TTL_MS = 30 * 86_400_000;

function file(): string {
  return path.join(process.env["DATA_DIR"] || "/data", "link-cache.json");
}

interface Cache {
  entries: Record<string, { at: number }>;
}

function read(): Cache {
  try {
    const c = JSON.parse(fs.readFileSync(file(), "utf8")) as Cache;
    if (c && typeof c === "object" && c.entries && typeof c.entries === "object") return c;
  } catch {
    /* first run / corrupt file */
  }
  return { entries: {} };
}

function prune(c: Cache): void {
  for (const k of Object.keys(c.entries)) {
    if (Date.now() - c.entries[k]!.at > TTL_MS) delete c.entries[k];
  }
}

/** True when this company's website linking failed within the TTL. */
export function isLinkFailed(key: string): boolean {
  const c = read();
  const e = c.entries[key];
  if (!e) return false;
  if (Date.now() - e.at > TTL_MS) {
    delete c.entries[key];
    return false;
  }
  return true;
}

/** Remember a failed link attempt for `key` (reg number or normalized name). */
export function markLinkFailed(key: string): void {
  const c = read();
  prune(c);
  c.entries[key] = { at: Date.now() };
  try {
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    fs.writeFileSync(file(), JSON.stringify(c));
  } catch {
    /* best-effort */
  }
}

export function linkCacheSize(): number {
  const c = read();
  prune(c);
  return Object.keys(c.entries).length;
}
