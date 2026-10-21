import type Database from "better-sqlite3";
import type { SentLogEntry } from "./types.js";

const INSERT_ENTRY = `
  INSERT INTO sent_log (lead_key, email, subject, message_id, status, at)
  VALUES (@lead_key, @email, @subject, @message_id, @status, @at)
`;

const SELECT_BY_LEAD = `SELECT * FROM sent_log WHERE lead_key = ? ORDER BY id DESC`;
const SELECT_RECENT = `SELECT * FROM sent_log ORDER BY id DESC LIMIT ?`;
const COUNT_TODAY = `SELECT COUNT(*) as cnt FROM sent_log WHERE at >= ?`;

export function logSentEmail(db: Database.Database, entry: Omit<SentLogEntry, "id">): number {
  const result = db.prepare(INSERT_ENTRY).run({
    lead_key: entry.lead_key,
    email: entry.email,
    subject: entry.subject ?? null,
    message_id: entry.message_id ?? null,
    status: entry.status,
    at: entry.at,
  });
  return result.lastInsertRowid as number;
}

export function getSentByLead(db: Database.Database, leadKey: string): SentLogEntry[] {
  return db.prepare(SELECT_BY_LEAD).all(leadKey) as SentLogEntry[];
}

export function listRecentSent(db: Database.Database, limit: number = 50): SentLogEntry[] {
  return db.prepare(SELECT_RECENT).all(limit) as SentLogEntry[];
}

export function countSentToday(db: Database.Database): number {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const row = db.prepare(COUNT_TODAY).get(todayStart.toISOString()) as { cnt: number };
  return row.cnt;
}
