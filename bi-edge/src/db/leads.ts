import type Database from "better-sqlite3";
import type {
  Lead,
  LeadPatch,
  LeadListFilters,
  LeadListResult,
  StageCounts,
} from "./types.js";

const UPSERT_SQL = `
  INSERT OR REPLACE INTO leads (
    key, country, name, reg_number, sic, sic_label, incorporated,
    address, city, website, website_status, website_evidence,
    emails, phones, socials, source, source_url,
    stage, classification, research, pitch_subject, pitch_body,
    status, created_at, updated_at, last_sync_at
  ) VALUES (
    @key, @country, @name, @reg_number, @sic, @sic_label, @incorporated,
    @address, @city, @website, @website_status, @website_evidence,
    @emails, @phones, @socials, @source, @source_url,
    @stage, @classification, @research, @pitch_subject, @pitch_body,
    @status, @created_at, @updated_at, @last_sync_at
  )
`;

const SELECT_BY_KEY = `SELECT * FROM leads WHERE key = ?`;

const DELETE_BY_KEY = `DELETE FROM leads WHERE key = ?`;

const COUNT_BY_STAGE = `SELECT stage, COUNT(*) as cnt FROM leads GROUP BY stage`;

export function upsertLead(db: Database.Database, lead: Lead): void {
  const stmt = db.prepare(UPSERT_SQL);
  stmt.run({
    key: lead.key,
    country: lead.country,
    name: lead.name,
    reg_number: lead.reg_number ?? null,
    sic: lead.sic ?? null,
    sic_label: lead.sic_label ?? null,
    incorporated: lead.incorporated ?? null,
    address: lead.address ?? null,
    city: lead.city ?? null,
    website: lead.website ?? null,
    website_status: lead.website_status ?? "none",
    website_evidence: lead.website_evidence ?? null,
    emails: lead.emails ?? null,
    phones: lead.phones ?? null,
    socials: lead.socials ?? null,
    source: lead.source ?? null,
    source_url: lead.source_url ?? null,
    stage: lead.stage ?? "raw",
    classification: lead.classification ?? null,
    research: lead.research ?? null,
    pitch_subject: lead.pitch_subject ?? null,
    pitch_body: lead.pitch_body ?? null,
    status: lead.status ?? "pending_review",
    created_at: lead.created_at ?? new Date().toISOString(),
    updated_at: lead.updated_at ?? new Date().toISOString(),
    last_sync_at: lead.last_sync_at ?? null,
  });
}

export function getLead(db: Database.Database, key: string): Lead | undefined {
  return db.prepare(SELECT_BY_KEY).get(key) as Lead | undefined;
}

export function listLeads(db: Database.Database, filters: LeadListFilters = {}): LeadListResult {
  const { stage, country, tier, status, page = 1, pageSize = 50 } = filters;
  const conditions: string[] = [];
  const params: Record<string, unknown> = {};

  if (stage) {
    conditions.push("stage = @stage");
    params["stage"] = stage;
  }
  if (country) {
    conditions.push("country = @country");
    params["country"] = country;
  }
  if (status) {
    conditions.push("status = @status");
    params["status"] = status;
  }
  if (tier) {
    conditions.push("json_extract(classification, '$.tier') = @tier");
    params["tier"] = tier;
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  const total = (
    db.prepare(`SELECT COUNT(*) as cnt FROM leads ${where}`).get(params) as {
      cnt: number;
    }
  ).cnt;

  const offset = (page - 1) * pageSize;
  params["limit"] = pageSize;
  params["offset"] = offset;

  const rows = db
    .prepare(`SELECT * FROM leads ${where} ORDER BY updated_at DESC LIMIT @limit OFFSET @offset`)
    .all(params) as Lead[];

  return { rows, total, page, pageSize };
}

export function updateLead(db: Database.Database, key: string, patch: LeadPatch): boolean {
  const fields: string[] = [];
  const params: Record<string, unknown> = { key };

  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) {
      fields.push(`${field} = @${field}`);
      params[field] = value;
    }
  }

  if (fields.length === 0) return false;

  fields.push("updated_at = @updated_at_now");
  params["updated_at_now"] = new Date().toISOString();

  const sql = `UPDATE leads SET ${fields.join(", ")} WHERE key = @key`;
  const result = db.prepare(sql).run(params);
  return result.changes > 0;
}

export function batchUpdateLeads(
  db: Database.Database,
  keys: string[],
  patch: LeadPatch
): number {
  if (keys.length === 0) return 0;

  const fields: string[] = [];
  const params: Record<string, unknown> = {};

  for (const [field, value] of Object.entries(patch)) {
    if (value !== undefined) {
      fields.push(`${field} = @${field}`);
      params[field] = value;
    }
  }

  if (fields.length === 0) return 0;

  fields.push("updated_at = @updated_at_now");
  params["updated_at_now"] = new Date().toISOString();

  const placeholders = keys.map((k, i) => {
    params[`k${i}`] = k;
    return `@k${i}`;
  });

  const sql = `UPDATE leads SET ${fields.join(", ")} WHERE key IN (${placeholders.join(",")})`;

  const runInTransaction = db.transaction(() => {
    return db.prepare(sql).run(params).changes;
  });

  return runInTransaction();
}

export function deleteLead(db: Database.Database, key: string): boolean {
  const result = db.prepare(DELETE_BY_KEY).run(key);
  return result.changes > 0;
}

export function countByStage(db: Database.Database): StageCounts {
  const rows = db.prepare(COUNT_BY_STAGE).all() as { stage: string; cnt: number }[];
  const counts: StageCounts = {};
  for (const row of rows) {
    counts[row["stage"]] = row["cnt"];
  }
  return counts;
}
