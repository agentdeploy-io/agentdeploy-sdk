import type Database from "better-sqlite3";

// A vertical pack is crawl configuration, not code: ICP + countries + dorks +
// behavior toggles. The core runs it; the engine stores it; the UI edits it.
export interface VerticalConfig {
  icp: string;
  countries: string[];
  dorks: string[];
  cities?: string[];
  sicInclude?: string[];
  sicExclude?: string[];
  requireWebsite: boolean;
  useRegistry: boolean;
  llmEnrich: boolean;
  mxGuess: boolean;
  minScore: number;
  perCountryLimit: number;
}

export interface Vertical extends VerticalConfig {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt?: string;
  updatedAt?: string;
}

interface Row {
  id: string;
  name: string;
  config: string;
  is_default: number;
  created_at: string | null;
  updated_at: string | null;
}

const SELECT_ALL = `SELECT * FROM verticals ORDER BY created_at ASC, id ASC`;

function toVertical(row: Row): Vertical {
  let cfg: Partial<VerticalConfig>;
  try {
    cfg = JSON.parse(row.config) as Partial<VerticalConfig>;
  } catch {
    cfg = {};
  }
  return {
    id: row.id,
    name: row.name,
    icp: cfg.icp ?? "",
    countries: cfg.countries ?? [],
    dorks: cfg.dorks ?? [],
    cities: cfg.cities,
    sicInclude: cfg.sicInclude,
    sicExclude: cfg.sicExclude,
    requireWebsite: cfg.requireWebsite ?? true,
    useRegistry: cfg.useRegistry ?? true,
    llmEnrich: cfg.llmEnrich ?? true,
    mxGuess: cfg.mxGuess ?? true,
    minScore: cfg.minScore ?? 50,
    perCountryLimit: cfg.perCountryLimit ?? 20,
    isDefault: row.is_default === 1,
    createdAt: row.created_at ?? undefined,
    updatedAt: row.updated_at ?? undefined,
  };
}

function configJson(v: Vertical): string {
  const { icp, countries, dorks, cities, sicInclude, sicExclude, requireWebsite, useRegistry, llmEnrich, mxGuess, minScore, perCountryLimit } = v;
  return JSON.stringify({ icp, countries, dorks, cities, sicInclude, sicExclude, requireWebsite, useRegistry, llmEnrich, mxGuess, minScore, perCountryLimit });
}

export function listVerticals(db: Database.Database): Vertical[] {
  return (db.prepare(SELECT_ALL).all() as Row[]).map(toVertical);
}

export function getVertical(db: Database.Database, id: string): Vertical | null {
  const row = db.prepare(`SELECT * FROM verticals WHERE id = ?`).get(id) as Row | undefined;
  return row ? toVertical(row) : null;
}

export function getDefaultVertical(db: Database.Database): Vertical | null {
  const row = db.prepare(`SELECT * FROM verticals WHERE is_default = 1 ORDER BY updated_at DESC LIMIT 1`).get() as Row | undefined;
  return row ? toVertical(row) : null;
}

export function upsertVertical(db: Database.Database, v: Vertical): Vertical {
  const now = new Date().toISOString();
  const isDefault = v.isDefault ? 1 : 0;
  if (isDefault === 1) {
    db.prepare(`UPDATE verticals SET is_default = 0`).run();
  }
  const exists = db.prepare(`SELECT id FROM verticals WHERE id = ?`).get(v.id);
  if (exists) {
    db.prepare(
      `UPDATE verticals SET name = ?, config = ?, is_default = ?, updated_at = ? WHERE id = ?`
    ).run(v.name, configJson(v), isDefault, now, v.id);
  } else {
    db.prepare(
      `INSERT INTO verticals (id, name, config, is_default, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(v.id, v.name, configJson(v), isDefault, now, now);
  }
  return getVertical(db, v.id)!;
}

export function deleteVertical(db: Database.Database, id: string): boolean {
  const res = db.prepare(`DELETE FROM verticals WHERE id = ?`).run(id);
  return res.changes > 0;
}
