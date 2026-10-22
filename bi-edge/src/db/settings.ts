import type Database from "better-sqlite3";
import type { SettingsMap, DefaultSettings } from "./types.js";

const DEFAULTS: DefaultSettings = {
  paused: false,
  dryRun: true,
  sendEnabled: false,
  dailyCap: 10,
};

const UPSERT_SETTING = `
  INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
`;

const SELECT_SETTING = `SELECT value FROM settings WHERE key = ?`;
const SELECT_ALL = `SELECT key, value FROM settings`;
const DELETE_SETTING = `DELETE FROM settings WHERE key = ?`;

export function getSetting(db: Database.Database, key: string): string | undefined {
  const row = db.prepare(SELECT_SETTING).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Database.Database, key: string, value: string): void {
  db.prepare(UPSERT_SETTING).run(key, value);
}

export function deleteSetting(db: Database.Database, key: string): boolean {
  const result = db.prepare(DELETE_SETTING).run(key);
  return result.changes > 0;
}

export function getAllSettings(db: Database.Database): SettingsMap {
  const rows = db.prepare(SELECT_ALL).all() as { key: string; value: string }[];
  const map: SettingsMap = {};
  for (const row of rows) {
    map[row["key"]] = row["value"];
  }
  return map;
}

export function getSettingsWithDefaults(db: Database.Database): DefaultSettings {
  const stored = getAllSettings(db);
  const result: DefaultSettings = { ...DEFAULTS };

  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    const raw = stored[key];
    if (raw === undefined) continue;

    if (typeof defaultValue === "boolean") {
      result[key] = raw === "true";
    } else if (typeof defaultValue === "number") {
      result[key] = Number(raw);
    } else {
      result[key] = raw;
    }
  }

  return result;
}

export function isPaused(db: Database.Database): boolean {
  const raw = getSetting(db, "paused");
  return raw === "true";
}

export function isDryRun(db: Database.Database): boolean {
  const raw = getSetting(db, "dryRun");
  if (raw === undefined) return DEFAULTS.dryRun;
  return raw === "true";
}

export function isSendEnabled(db: Database.Database): boolean {
  const raw = getSetting(db, "sendEnabled");
  return raw === "true";
}

export function getDailyCap(db: Database.Database): number {
  const raw = getSetting(db, "dailyCap");
  if (raw === undefined) return DEFAULTS.dailyCap;
  return Number(raw);
}

/**
 * Test mode: when enabled AND a recipient is set, every send (initial pitch
 * or reply) is redirected to the operator's own test inbox. Gates still
 * apply (dry-run / sendEnabled / cap) — test mode only changes WHO receives,
 * so a real lead can never be emailed while testing.
 */
export function isTestMode(db: Database.Database): boolean {
  return getSetting(db, "testMode") === "true";
}

export function getTestRecipient(db: Database.Database): string {
  return (getSetting(db, "testRecipient") ?? "").trim();
}
