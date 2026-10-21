import type Database from "better-sqlite3";
import type { BlacklistEntry, BlacklistKind, BlacklistCheck } from "./types.js";

const INSERT_ENTRY = `
  INSERT INTO blacklist (id, kind, note, created_at) VALUES (@id, @kind, @note, @created_at)
`;

const DELETE_BY_ID = `DELETE FROM blacklist WHERE id = ?`;
const SELECT_ALL = `SELECT * FROM blacklist ORDER BY created_at DESC`;
const SELECT_BY_ID = `SELECT * FROM blacklist WHERE id = ?`;

export function addToBlacklist(
  db: Database.Database,
  id: string,
  kind: BlacklistKind,
  note?: string | null
): void {
  db.prepare(INSERT_ENTRY).run({
    id,
    kind,
    note: note ?? null,
    created_at: new Date().toISOString(),
  });
}

export function removeFromBlacklist(db: Database.Database, id: string): boolean {
  const result = db.prepare(DELETE_BY_ID).run(id);
  return result.changes > 0;
}

export function getBlacklistEntry(db: Database.Database, id: string): BlacklistEntry | undefined {
  return db.prepare(SELECT_BY_ID).get(id) as BlacklistEntry | undefined;
}

export function listBlacklist(db: Database.Database): BlacklistEntry[] {
  return db.prepare(SELECT_ALL).all() as BlacklistEntry[];
}

export function isBlacklisted(db: Database.Database, check: BlacklistCheck): boolean {
  if (check.email) {
    const row = db.prepare("SELECT 1 FROM blacklist WHERE id = ? AND kind = 'email'").get(check.email);
    if (row) return true;
  }

  if (check.domain) {
    const row = db.prepare("SELECT 1 FROM blacklist WHERE id = ? AND kind = 'domain'").get(check.domain);
    if (row) return true;
  }

  if (check.company) {
    const row = db.prepare("SELECT 1 FROM blacklist WHERE id = ? AND kind = 'company'").get(check.company);
    if (row) return true;
  }

  if (check.email) {
    const domain = check.email.split("@")[1];
    if (domain) {
      const row = db.prepare("SELECT 1 FROM blacklist WHERE id = ? AND kind = 'domain'").get(domain);
      if (row) return true;
    }
  }

  return false;
}
