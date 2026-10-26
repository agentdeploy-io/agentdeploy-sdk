/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { upsertSyncBatch, SCHEMA_V1, runMigrations } from "../db/index.js";
import type { Lead } from "../db/types.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

const MAX_BATCH = 25;

const CORRUPTED_CONTACT_RE = /\[object Object/;

/**
 * The leads table stores contact fields as JSON *strings*, but sync senders
 * are allowed to post arrays/objects. Cloudflare DO sql.exec string-coerces
 * bound arrays to "[object Object]" (silently destroying the data), so
 * normalize to a JSON string before binding. Corrupted legacy strings are
 * reset to null rather than propagated.
 */
function toJsonField(v: unknown): string | null {
  if (v == null) return null;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "" || CORRUPTED_CONTACT_RE.test(s)) return null;
    return s;
  }
  if (Array.isArray(v) || typeof v === "object") {
    if (Array.isArray(v) && v.length === 0) return null;
    return JSON.stringify(v);
  }
  return String(v);
}

export async function handleInboundSync(
  request: Request,
  env: Record<string, unknown>,
  externalDb?: DatabaseType.Database,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  const syncSecret = env.AD_SYNC_SECRET as string;
  if (syncSecret) {
    const provided = request.headers.get("X-AD-Sync");
    if (provided !== syncSecret) {
      return new Response(
        JSON.stringify({ error: "Invalid sync secret" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  let body: { leads?: Lead[] };
  try {
    body = await request.json() as { leads?: Lead[] };
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  if (!body.leads || !Array.isArray(body.leads)) {
    return new Response(
      JSON.stringify({ error: "leads[] required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const leads = body.leads.slice(0, MAX_BATCH);

  const now = new Date().toISOString();
  const normalized: Lead[] = leads.map((l) => ({
    key: l.key,
    country: l.country,
    name: l.name,
    reg_number: l.reg_number ?? null,
    sic: l.sic ?? null,
    sic_label: l.sic_label ?? null,
    incorporated: l.incorporated ?? null,
    address: l.address ?? null,
    city: l.city ?? null,
    website: l.website ?? null,
    website_status: l.website_status ?? "none",
    website_evidence: l.website_evidence ?? null,
    emails: toJsonField(l.emails),
    phones: toJsonField(l.phones),
    socials: toJsonField(l.socials),
    source: l.source ?? "sync",
    source_url: l.source_url ?? null,
    stage: l.stage ?? "raw",
    classification: l.classification ?? null,
    research: l.research ?? null,
    pitch_subject: l.pitch_subject ?? null,
    pitch_body: l.pitch_body ?? null,
    status: l.status ?? "pending_review",
    created_at: l.created_at ?? now,
    updated_at: now,
    last_sync_at: now,
  }));

  const ownDb = !externalDb;
  const db = externalDb ?? initDb();
  try {
    const result = upsertSyncBatch(db, normalized);
    if (ownDb) db.close();
    return new Response(
      JSON.stringify({
        accepted: result.accepted,
        watermark: result.watermark,
        batch_size: leads.length,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    if (ownDb) db.close();
    return new Response(
      JSON.stringify({ error: e.message }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
}
