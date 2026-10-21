export const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS leads (
  key            TEXT PRIMARY KEY,
  country        TEXT NOT NULL,
  name           TEXT NOT NULL,
  reg_number     TEXT,
  sic            TEXT,
  sic_label      TEXT,
  incorporated   TEXT,
  address        TEXT,
  city           TEXT,
  website        TEXT,
  website_status TEXT DEFAULT 'none',
  website_evidence TEXT,
  emails         TEXT,
  phones         TEXT,
  socials        TEXT,
  source         TEXT,
  source_url     TEXT,
  stage          TEXT NOT NULL DEFAULT 'raw',
  classification TEXT,
  research       TEXT,
  pitch_subject  TEXT,
  pitch_body     TEXT,
  status         TEXT DEFAULT 'pending_review',
  created_at     TEXT,
  updated_at     TEXT,
  last_sync_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_country_stage ON leads(country, stage);
CREATE INDEX IF NOT EXISTS idx_leads_updated ON leads(updated_at);

CREATE TABLE IF NOT EXISTS crawl_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  started_at TEXT,
  finished_at TEXT,
  trigger TEXT,
  countries TEXT,
  params TEXT,
  state TEXT,
  vm_minutes REAL,
  tokens_used INTEGER,
  stats TEXT
);

CREATE TABLE IF NOT EXISTS sync_watermark (
  id INTEGER PRIMARY KEY CHECK (id=1),
  last_rowid INTEGER NOT NULL DEFAULT 0,
  last_synced_at TEXT
);

CREATE TABLE IF NOT EXISTS sent_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_key TEXT,
  email TEXT,
  subject TEXT,
  message_id TEXT,
  status TEXT,
  at TEXT
);

CREATE TABLE IF NOT EXISTS replies_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_key TEXT,
  reply_from TEXT,
  reply_subject TEXT,
  reply_body TEXT,
  intent TEXT,
  draft TEXT,
  draft_status TEXT,
  at TEXT
);

CREATE TABLE IF NOT EXISTS blacklist (
  id TEXT PRIMARY KEY,
  kind TEXT,
  note TEXT,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS inbound_seen (
  id INTEGER PRIMARY KEY CHECK (id=1),
  ids TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
`;

export const SCHEMA_VERSION = 1;
