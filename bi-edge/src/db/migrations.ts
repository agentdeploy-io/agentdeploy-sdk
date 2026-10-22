import type Database from "better-sqlite3";
import { SCHEMA_V1, SCHEMA_VERSION } from "./schema.js";

interface MigrationRecord {
  version: number;
  applied_at: string;
}

const MIGRATIONS: Record<number, string> = {
  1: SCHEMA_V1,
  2: `
    CREATE TABLE IF NOT EXISTS llm_traces (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      stage TEXT,
      lead_key TEXT,
      model TEXT,
      prompt_excerpt TEXT,
      raw_response TEXT,
      latency_ms INTEGER,
      at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_llm_traces_id ON llm_traces(id);
  `,
  3: `
    CREATE TABLE IF NOT EXISTS verticals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT,
      updated_at TEXT
    );
  `,
};

export function runMigrations(db: Database.Database): number {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    )
  `);

  const applied = new Set(
    db
      .prepare("SELECT version FROM _migrations")
      .all()
      .map((row: unknown) => (row as MigrationRecord).version)
  );

  const maxVersion = Math.max(...Object.keys(MIGRATIONS).map(Number));
  let appliedCount = 0;

  const runInTransaction = db.transaction(() => {
    for (let v = 1; v <= maxVersion; v++) {
      if (applied.has(v)) continue;
      const sql = MIGRATIONS[v];
      if (!sql) continue;
      db.exec(sql);
      db.prepare("INSERT INTO _migrations (version, applied_at) VALUES (?, ?)").run(
        v,
        new Date().toISOString()
      );
      appliedCount++;
    }
  });

  runInTransaction();
  return appliedCount;
}

export function getCurrentVersion(db: Database.Database): number {
  const row = db
    .prepare("SELECT MAX(version) as v FROM _migrations")
    .get() as { v: number | null } | undefined;
  return row?.v ?? 0;
}

export function isSchemaUpToDate(db: Database.Database): boolean {
  return getCurrentVersion(db) >= SCHEMA_VERSION;
}
