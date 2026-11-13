/// <reference types="node" />
import type Database from "better-sqlite3";

// Defense in depth for the double-send guard.
//
// The authoritative "who did we email" ledger is the sent_log table in the
// DO's SQLite. If that file is lost (reboot wiped the state dir, bad
// deploy, manual cleanup) the guard forgets and a re-crawl + re-approve
// would email the same prospect again. So every REAL send is also appended
// to an append-only JSONL journal that lives OUTSIDE the state directory.
// On engine startup, reconcileSendJournal() re-hydrates sent_log from the
// journal for anything missing — the block survives state loss.
//
// On the production Workers runtime (no filesystem) both functions are
// silent no-ops: DO storage is durable there, so the journal is redundant.

export interface JournalEntry {
  lead_key: string;
  email: string;
  subject?: string | null;
  message_id?: string | null;
  status: string;
  at: string;
  channel?: string;
}

type NodeModules = {
  fs: typeof import("node:fs");
  os: typeof import("node:os");
  path: typeof import("node:path");
};

let cached: NodeModules | null | "unavailable" = null;

async function nodeModules(): Promise<NodeModules | null> {
  if (cached !== null) return cached === "unavailable" ? null : cached;
  try {
    const [fs, os, path] = await Promise.all([
      import("node:fs"),
      import("node:os"),
      import("node:path"),
    ]);
    cached = { fs, os, path };
  } catch {
    cached = "unavailable";
  }
  return cached === "unavailable" ? null : cached;
}

function journalPath(mods: NodeModules): string {
  const envPath = (globalThis as { process?: { env?: Record<string, string> } }).process?.env
    ?.SEND_JOURNAL_PATH;
  if (envPath) return envPath;
  return mods.path.join(mods.os.homedir(), ".local", "share", "calla", "send-journal.jsonl");
}

/** Append one entry; best-effort — a journal hiccup never blocks a send. */
export async function appendSendToJournal(entry: JournalEntry): Promise<void> {
  const mods = await nodeModules();
  if (!mods) return;
  try {
    const p = journalPath(mods);
    mods.fs.mkdirSync(mods.path.dirname(p), { recursive: true });
    mods.fs.appendFileSync(p, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* no-op */
  }
}

/**
 * Re-hydrate sent_log from the journal (startup path). Returns the number
 * of entries restored. Idempotent: entries already present (by message_id
 * or by lead_key+email+at) are skipped.
 */
export async function reconcileSendJournal(db: Database.Database): Promise<number> {
  const mods = await nodeModules();
  if (!mods) return 0;
  let raw: string;
  try {
    const p = journalPath(mods);
    if (!mods.fs.existsSync(p)) return 0;
    raw = mods.fs.readFileSync(p, "utf8");
  } catch {
    return 0;
  }

  let restored = 0;
  const insert = db.prepare(
    `INSERT INTO sent_log (lead_key, email, subject, message_id, status, at, channel)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const byMessageId = db.prepare(`SELECT 1 AS hit FROM sent_log WHERE message_id = ? LIMIT 1`);
  const byLeadEmailAt = db.prepare(
    `SELECT 1 AS hit FROM sent_log WHERE lead_key = ? AND email = ? AND at = ? LIMIT 1`,
  );

  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let e: JournalEntry;
    try {
      e = JSON.parse(t) as JournalEntry;
    } catch {
      continue;
    }
    if (e.status !== "sent" || !e.lead_key || !e.email || !e.at) continue;
    try {
      if (e.message_id && byMessageId.get(e.message_id)) continue;
      if (byLeadEmailAt.get(e.lead_key, e.email, e.at)) continue;
      insert.run(e.lead_key, e.email, e.subject ?? null, e.message_id ?? null, "sent", e.at, e.channel ?? "email");
      restored++;
    } catch {
      /* skip malformed row */
    }
  }
  return restored;
}
