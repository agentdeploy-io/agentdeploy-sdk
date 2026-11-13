import type Database from "better-sqlite3";
import type {
  Lead,
  LeadPatch,
  LeadListFilters,
  LeadListResult,
  StageCounts,
} from "./types.js";

// On re-sync of a known key we MERGE, never reset:
//  - enrichment (registry data, website, contacts) refreshes from the crawl;
//  - stage can only ADVANCE (raw→verified→…→replied); terminal/advanced
//    states (sent, replied, opted_out, rejected, archived) are protected —
//    a re-crawl can no longer turn a sent lead back into a fresh "raw" lead;
//  - status, pitch, classification, research, provenance and created_at are
//    pipeline-owned and are never overwritten by a sync.
const STAGE_RANK = (col: string) =>
  `CASE ${col} WHEN 'verified' THEN 2 WHEN 'classified' THEN 3 WHEN 'researched' THEN 4
     WHEN 'approved' THEN 5 WHEN 'sent' THEN 6 WHEN 'replied' THEN 7 ELSE 1 END`;
const WS_RANK = (col: string) =>
  `CASE ${col} WHEN 'candidate' THEN 2 WHEN 'verified' THEN 3 ELSE 1 END`;

const UPSERT_SQL = `
  INSERT INTO leads (
    key, country, name, reg_number, sic, sic_label, incorporated,
    address, city, website, website_status, website_evidence,
    emails, phones, socials, contact_name, contact_role, source, source_url,
    stage, classification, research, pitch_subject, pitch_body,
    status, created_at, updated_at, last_sync_at, manychat_subscriber_id
  ) VALUES (
    @key, @country, @name, @reg_number, @sic, @sic_label, @incorporated,
    @address, @city, @website, @website_status, @website_evidence,
    @emails, @phones, @socials, @contact_name, @contact_role, @source, @source_url,
    @stage, @classification, @research, @pitch_subject, @pitch_body,
    @status, @created_at, @updated_at, @last_sync_at, @manychat_subscriber_id
  )
  ON CONFLICT(key) DO UPDATE SET
    country = excluded.country,
    name = excluded.name,
    reg_number = COALESCE(excluded.reg_number, leads.reg_number),
    sic = COALESCE(excluded.sic, leads.sic),
    sic_label = COALESCE(excluded.sic_label, leads.sic_label),
    incorporated = COALESCE(excluded.incorporated, leads.incorporated),
    address = COALESCE(excluded.address, leads.address),
    city = COALESCE(excluded.city, leads.city),
    website = COALESCE(excluded.website, leads.website),
    website_status = CASE
      WHEN leads.website_status = 'flagged' THEN leads.website_status
      WHEN ${WS_RANK("excluded.website_status")} > ${WS_RANK("leads.website_status")}
        THEN excluded.website_status
      ELSE leads.website_status
    END,
    website_evidence = COALESCE(excluded.website_evidence, leads.website_evidence),
    emails = COALESCE(excluded.emails, leads.emails),
    phones = COALESCE(excluded.phones, leads.phones),
    socials = COALESCE(excluded.socials, leads.socials),
    contact_name = COALESCE(excluded.contact_name, leads.contact_name),
    contact_role = COALESCE(excluded.contact_role, leads.contact_role),
    classification = COALESCE(leads.classification, excluded.classification),
    research = COALESCE(leads.research, excluded.research),
    pitch_subject = COALESCE(leads.pitch_subject, excluded.pitch_subject),
    pitch_body = COALESCE(leads.pitch_body, excluded.pitch_body),
    stage = CASE
      WHEN leads.stage IN ('sent', 'replied', 'opted_out', 'rejected', 'archived')
        THEN leads.stage
      WHEN ${STAGE_RANK("excluded.stage")} > ${STAGE_RANK("leads.stage")}
        THEN excluded.stage
      ELSE leads.stage
    END,
    status = leads.status,
    -- (Double-quoted: some SQLite builds reject the unquoted
    --  excluded.manchat_subscriber_id reference in UPSERT clauses.)
    manychat_subscriber_id = COALESCE(excluded."manychat_subscriber_id", leads."manychat_subscriber_id"),
    source = COALESCE(leads.source, excluded.source),
    source_url = COALESCE(leads.source_url, excluded.source_url),
    updated_at = excluded.updated_at,
    last_sync_at = excluded.last_sync_at
`;

const SELECT_BY_KEY = `SELECT * FROM leads WHERE key = ?`;

const CORRUPTED_CONTACT_RE = /\[object Object/;

/**
 * Contact columns are TEXT (JSON strings). Callers typed against `Lead`
 * should pass strings, but a runtime array bound to a CF DO SqlStorage
 * binding silently coerces to "[object Object]" — normalize here so no
 * write path can corrupt the columns.
 */
function contactField(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    return s === "" || CORRUPTED_CONTACT_RE.test(s) ? null : s;
  }
  if (Array.isArray(v) || typeof v === "object") {
    return Array.isArray(v) && v.length === 0 ? null : JSON.stringify(v);
  }
  return String(v);
}

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
    emails: contactField(lead.emails),
    phones: contactField(lead.phones),
    socials: contactField(lead.socials),
    contact_name: lead.contact_name ?? null,
    contact_role: lead.contact_role ?? null,
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
    manychat_subscriber_id: lead.manychat_subscriber_id ?? null,
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
    if (value === undefined) continue;
    fields.push(`${field} = @${field}`);
    params[field] = field === "emails" || field === "phones" || field === "socials" ? contactField(value) : value;
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
    if (value === undefined) continue;
    fields.push(`${field} = @${field}`);
    params[field] = field === "emails" || field === "phones" || field === "socials" ? contactField(value) : value;
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
