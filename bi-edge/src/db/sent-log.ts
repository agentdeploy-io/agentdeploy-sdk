import type Database from "better-sqlite3";
import type { SentLogEntry } from "./types.js";

const INSERT_ENTRY = `
  INSERT INTO sent_log (lead_key, email, subject, message_id, status, at, channel)
  VALUES (@lead_key, @email, @subject, @message_id, @status, @at, @channel)
`;

const SELECT_BY_LEAD = `SELECT * FROM sent_log WHERE lead_key = ? ORDER BY id DESC`;
const SELECT_RECENT = `SELECT * FROM sent_log ORDER BY id DESC LIMIT ?`;
// Test sends (lead_key "test:…") never consume real-send quota.
const COUNT_TODAY = `SELECT COUNT(*) as cnt FROM sent_log WHERE at >= ? AND lead_key NOT LIKE 'test:%'`;
const COUNT_TODAY_CHANNEL = `SELECT COUNT(*) as cnt FROM sent_log WHERE at >= ? AND channel = ? AND lead_key NOT LIKE 'test:%'`;
const HAS_REAL_SENT_BY_LEAD = `SELECT COUNT(*) as cnt FROM sent_log WHERE lead_key = ? AND status = 'sent'`;
const HAS_REAL_SENT_BY_EMAIL = `SELECT COUNT(*) as cnt FROM sent_log WHERE email = ? AND status = 'sent'`;

export function logSentEmail(db: Database.Database, entry: Omit<SentLogEntry, "id">): number {
  const result = db.prepare(INSERT_ENTRY).run({
    lead_key: entry.lead_key,
    email: entry.email,
    subject: entry.subject ?? null,
    message_id: entry.message_id ?? null,
    status: entry.status,
    at: entry.at,
    channel: entry.channel ?? "email",
  });
  return result.lastInsertRowid as number;
}

export function getSentByLead(db: Database.Database, leadKey: string): SentLogEntry[] {
  return db.prepare(SELECT_BY_LEAD).all(leadKey) as SentLogEntry[];
}

/** Canonical RFC 5322 message-id: exactly one pair of angle brackets. */
export function canonicalMessageId(raw: string): string {
  const t = raw.trim();
  return t.startsWith("<") && t.endsWith(">") ? t : `<${t}>`;
}

/** RFC 5322 threading headers for the NEXT outbound email to this lead:
 *  In-Reply-To = the last real message we sent them, References = the full
 *  chain oldest→newest, so replies stay in the same thread as the pitch.
 *  Empty object when the lead has no real sends (a new thread starts). */
export function threadHeadersForLead(db: Database.Database, leadKey: string): Record<string, string> {
  const rows = getSentByLead(db, leadKey).filter((r) => r.status === "sent" && r.message_id);
  if (rows.length === 0) return {};
  const oldestFirst = [...rows].reverse(); // SELECT_BY_LEAD is id DESC
  const ids = oldestFirst.map((r) => canonicalMessageId(r.message_id!));
  return {
    "In-Reply-To": ids[ids.length - 1],
    References: ids.join(" "),
  };
}

export function listRecentSent(db: Database.Database, limit: number = 50): SentLogEntry[] {
  return db.prepare(SELECT_RECENT).all(limit) as SentLogEntry[];
}

/** True if this lead already has a REAL sent row (dry-run/failed rows don't count). */
export function hasRealSendByLead(db: Database.Database, leadKey: string): boolean {
  const row = db.prepare(HAS_REAL_SENT_BY_LEAD).get(leadKey) as { cnt: number };
  return row.cnt > 0;
}

/** True if this email address was already really emailed — from any lead. */
export function hasRealSendByEmail(db: Database.Database, email: string): boolean {
  const row = db.prepare(HAS_REAL_SENT_BY_EMAIL).get(email) as { cnt: number };
  return row.cnt > 0;
}

export function countSentToday(db: Database.Database, channel?: "email" | "manychat"): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = channel
    ? (db.prepare(COUNT_TODAY_CHANNEL).get(todayStart.toISOString(), channel) as { cnt: number })
    : (db.prepare(COUNT_TODAY).get(todayStart.toISOString()) as { cnt: number });
  return row.cnt;
}
