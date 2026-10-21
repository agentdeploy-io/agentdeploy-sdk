import type Database from "better-sqlite3";
import type { CrawlRun, CrawlState } from "./types.js";

const INSERT_RUN = `
  INSERT INTO crawl_runs (started_at, finished_at, trigger, countries, params, state, vm_minutes, tokens_used, stats)
  VALUES (@started_at, @finished_at, @trigger, @countries, @params, @state, @vm_minutes, @tokens_used, @stats)
`;

const UPDATE_RUN = `
  UPDATE crawl_runs SET
    finished_at = @finished_at,
    state = @state,
    vm_minutes = @vm_minutes,
    tokens_used = @tokens_used,
    stats = @stats
  WHERE id = @id
`;

const SELECT_BY_ID = `SELECT * FROM crawl_runs WHERE id = ?`;
const SELECT_RECENT = `SELECT * FROM crawl_runs ORDER BY id DESC LIMIT ?`;

export function createCrawlRun(db: Database.Database, run: Omit<CrawlRun, "id">): number {
  const result = db.prepare(INSERT_RUN).run({
    started_at: run.started_at,
    finished_at: run.finished_at ?? null,
    trigger: run.trigger,
    countries: run.countries,
    params: run.params ?? null,
    state: run.state,
    vm_minutes: run.vm_minutes ?? null,
    tokens_used: run.tokens_used ?? null,
    stats: run.stats ?? null,
  });
  return result.lastInsertRowid as number;
}

export function updateCrawlRun(
  db: Database.Database,
  id: number,
  updates: {
    finished_at?: string | null;
    state?: CrawlState;
    vm_minutes?: number | null;
    tokens_used?: number | null;
    stats?: string | null;
  }
): boolean {
  const existing = getCrawlRun(db, id);
  if (!existing) return false;

  const result = db.prepare(UPDATE_RUN).run({
    id,
    finished_at: updates.finished_at ?? existing.finished_at ?? null,
    state: updates.state ?? existing.state,
    vm_minutes: updates.vm_minutes ?? existing.vm_minutes ?? null,
    tokens_used: updates.tokens_used ?? existing.tokens_used ?? null,
    stats: updates.stats ?? existing.stats ?? null,
  });
  return result.changes > 0;
}

export function getCrawlRun(db: Database.Database, id: number): CrawlRun | undefined {
  return db.prepare(SELECT_BY_ID).get(id) as CrawlRun | undefined;
}

export function listCrawlRuns(db: Database.Database, limit: number = 20): CrawlRun[] {
  return db.prepare(SELECT_RECENT).all(limit) as CrawlRun[];
}
