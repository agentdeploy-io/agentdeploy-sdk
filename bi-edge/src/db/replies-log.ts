import type Database from "better-sqlite3";
import type { RepliesLogEntry, ReplyIntent, DraftStatus } from "./types.js";

const INSERT_ENTRY = `
  INSERT INTO replies_log (lead_key, reply_from, reply_subject, reply_body, intent, draft, draft_status, at)
  VALUES (@lead_key, @reply_from, @reply_subject, @reply_body, @intent, @draft, @draft_status, @at)
`;

const UPDATE_DRAFT = `
  UPDATE replies_log SET draft = @draft, draft_status = @draft_status WHERE id = @id
`;

const SELECT_BY_LEAD = `SELECT * FROM replies_log WHERE lead_key = ? ORDER BY id DESC`;
const SELECT_RECENT = `SELECT * FROM replies_log ORDER BY id DESC LIMIT ?`;
const SELECT_PENDING_DRAFTS = `SELECT * FROM replies_log WHERE draft_status = 'pending' ORDER BY id DESC`;

export function logReply(db: Database.Database, entry: Omit<RepliesLogEntry, "id">): number {
  const result = db.prepare(INSERT_ENTRY).run({
    lead_key: entry.lead_key,
    reply_from: entry.reply_from,
    reply_subject: entry.reply_subject ?? null,
    reply_body: entry.reply_body ?? null,
    intent: entry.intent ?? null,
    draft: entry.draft ?? null,
    draft_status: entry.draft_status ?? null,
    at: entry.at,
  });
  return result.lastInsertRowid as number;
}

export function updateReplyDraft(
  db: Database.Database,
  id: number,
  draft: string,
  draftStatus: DraftStatus
): boolean {
  const result = db.prepare(UPDATE_DRAFT).run({ id, draft, draft_status: draftStatus });
  return result.changes > 0;
}

export function getRepliesByLead(db: Database.Database, leadKey: string): RepliesLogEntry[] {
  return db.prepare(SELECT_BY_LEAD).all(leadKey) as RepliesLogEntry[];
}

export function listRecentReplies(db: Database.Database, limit: number = 50): RepliesLogEntry[] {
  return db.prepare(SELECT_RECENT).all(limit) as RepliesLogEntry[];
}

export function getPendingDrafts(db: Database.Database): RepliesLogEntry[] {
  return db.prepare(SELECT_PENDING_DRAFTS).all() as RepliesLogEntry[];
}
