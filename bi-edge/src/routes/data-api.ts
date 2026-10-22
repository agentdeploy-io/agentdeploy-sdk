/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  listLeads,
  getLead,
  updateLead,
  batchUpdateLeads,
  deleteLead,
  countByStage,
  listCrawlRuns,
  getPendingDrafts,
  listRecentReplies,
  listRecentSent,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";
import type { Lead, LeadListFilters, LeadPatch } from "../db/types.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

function verifyJwt(request: Request, env: Record<string, unknown>): boolean {
  const secret = env.AD_JWT_SECRET as string;
  if (!secret) return true;
  const auth = request.headers.get("Authorization");
  if (!auth?.startsWith("Bearer ")) return false;
  return auth.slice(7).length > 0;
}

function csvEscape(value: string | null | undefined): string {
  const str = String(value ?? "");
  if (str.includes(",") || str.includes('"') || str.includes("\n")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else {
        current += ch;
      }
    }
  }
  fields.push(current);
  return fields;
}

export async function handleDataApi(
  request: Request,
  env: Record<string, unknown>,
  externalDb?: DatabaseType.Database,
): Promise<Response> {
  if (!verifyJwt(request, env)) {
    return new Response(
      JSON.stringify({ error: "Unauthorized" }),
      { status: 401, headers: { "Content-Type": "application/json" } },
    );
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/^\/cmd\/data/, "");

  if (path === "" || path === "/") {
    return handleListLeads(request, url, externalDb);
  }

  if (path === "/row" && request.method === "GET") {
    return handleGetLead(url, externalDb);
  }

  if (path === "/row" && request.method === "POST") {
    return handleUpdateLead(request, externalDb);
  }

  if (path === "/batch" && request.method === "POST") {
    return handleBatchUpdate(request, externalDb);
  }

  if (path === "/export" && request.method === "GET") {
    return handleExportCsv(url, externalDb);
  }

  if (path === "/import" && request.method === "POST") {
    return handleImportCsv(request, externalDb);
  }

  if (url.pathname === "/cmd/runs") {
    return handleCrawlRuns(url, externalDb);
  }

  if (url.pathname === "/cmd/pipeline") {
    return handlePipeline(externalDb);
  }

  if (url.pathname === "/cmd/replies" && request.method === "GET") {
    return handleReplies(url, externalDb);
  }

  if (url.pathname === "/cmd/sent" && request.method === "GET") {
    return handleSentLog(url, externalDb);
  }

  return new Response(
    JSON.stringify({ error: "Not found" }),
    { status: 404, headers: { "Content-Type": "application/json" } },
  );
}

function useDb(externalDb?: DatabaseType.Database): { db: DatabaseType.Database; own: boolean } {
  if (externalDb) return { db: externalDb, own: false };
  return { db: initDb(), own: true };
}

function handleListLeads(request: Request, url: URL, externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const filters: LeadListFilters = {
      stage: (url.searchParams.get("stage") as any) ?? undefined,
      country: url.searchParams.get("country") ?? undefined,
      tier: url.searchParams.get("tier") ?? undefined,
      status: (url.searchParams.get("status") as any) ?? undefined,
      page: Number(url.searchParams.get("page")) || 1,
      pageSize: Math.min(Number(url.searchParams.get("pageSize")) || 50, 500),
    };
    const result = listLeads(db, filters);
    if (own) db.close();
    return new Response(JSON.stringify(result), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function handleGetLead(url: URL, externalDb?: DatabaseType.Database): Response {
  const key = url.searchParams.get("key");
  if (!key) {
    return new Response(JSON.stringify({ error: "key parameter required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }
  const { db, own } = useDb(externalDb);
  try {
    const lead = getLead(db, key);
    if (own) db.close();
    if (!lead) {
      return new Response(JSON.stringify({ error: "Not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response(JSON.stringify(lead), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleUpdateLead(request: Request, externalDb?: DatabaseType.Database): Promise<Response> {
  let body: { key?: string; patch?: LeadPatch };
  try {
    body = await request.json() as { key?: string; patch?: LeadPatch };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.key || !body.patch) {
    return new Response(JSON.stringify({ error: "key and patch required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { db, own } = useDb(externalDb);
  try {
    const success = updateLead(db, body.key, body.patch);
    if (own) db.close();
    return new Response(JSON.stringify({ updated: success }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function handleBatchUpdate(request: Request, externalDb?: DatabaseType.Database): Promise<Response> {
  let body: { keys?: string[]; patch?: LeadPatch };
  try {
    body = await request.json() as { keys?: string[]; patch?: LeadPatch };
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (!body.keys || !body.patch) {
    return new Response(JSON.stringify({ error: "keys[] and patch required" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { db, own } = useDb(externalDb);
  try {
    const count = batchUpdateLeads(db, body.keys, body.patch);
    if (own) db.close();
    return new Response(JSON.stringify({ updated: count }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function handleExportCsv(url: URL, externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const filters: LeadListFilters = {
      stage: (url.searchParams.get("stage") as any) ?? undefined,
      country: url.searchParams.get("country") ?? undefined,
      page: 1,
      pageSize: 10000,
    };
    const result = listLeads(db, filters);
    if (own) db.close();

    const header = "key,country,name,reg_number,sic,sic_label,incorporated,address,city,website,stage,status,created_at,updated_at";
    const rows = result.rows.map((l) =>
      [
        csvEscape(l.key),
        csvEscape(l.country),
        csvEscape(l.name),
        csvEscape(l.reg_number),
        csvEscape(l.sic),
        csvEscape(l.sic_label),
        csvEscape(l.incorporated),
        csvEscape(l.address),
        csvEscape(l.city),
        csvEscape(l.website),
        csvEscape(l.stage),
        csvEscape(l.status),
        csvEscape(l.created_at),
        csvEscape(l.updated_at),
      ].join(",")
    );

    const csv = header + "\r\n" + rows.join("\r\n") + "\r\n";

    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="leads-export-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// Columns (besides key/name/country) a CSV import may populate. Anything else
// is ignored so a stray column can't corrupt a lead row.
const IMPORTABLE_CSV_COLUMNS = new Set([
  "reg_number",
  "sic",
  "sic_label",
  "incorporated",
  "address",
  "city",
  "website",
  "website_status",
  "phones",
  "source",
  "source_url",
  "stage",
  "status",
]);

// Convert a CSV "emails" cell (single address or ,/;-separated list) into the
// canonical JSON array the outreach gate stack / getFirstEmail expect.
// mx_ok is left unset (undefined) — the gate's hasMxOk passes when it is not
// explicitly false, and real MX validation happens in the scrape pipeline.
function buildEmailsJson(raw: string): string {
  const addrs = raw
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter((s) => s.includes("@"));
  const entries = addrs.map((addr) => ({
    addr,
    kind: "role",
    source: "csv",
    confidence: 0.8,
  }));
  return JSON.stringify(entries);
}

async function handleImportCsv(request: Request, externalDb?: DatabaseType.Database): Promise<Response> {
  const { db, own } = useDb(externalDb);
  try {
    const url = new URL(request.url);
    const contentType = request.headers.get("content-type") ?? "";
    let text: string;
    let dryRun: boolean;
    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file") as unknown as
        | { text?: () => Promise<string> }
        | string
        | null;
      if (typeof file === "string") {
        text = file;
      } else if (file != null && typeof file.text === "function") {
        text = await file.text();
      } else {
        text = String(form.get("text") ?? "");
      }
      dryRun = form.get("dryRun") === "true" || url.searchParams.get("dryRun") === "true";
    } else {
      text = await request.text();
      dryRun = url.searchParams.get("dryRun") === "true";
    }

    const lines = text.split(/\r?\n/).filter((l) => l.trim());

    if (lines.length < 2) {
      if (own) db.close();
      return new Response(JSON.stringify({ error: "CSV must have header + at least one row" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const headers = parseCsvLine(lines[0]).map((h) => h.trim());
    const keyIdx = headers.indexOf("key");
    const nameIdx = headers.indexOf("name");
    const countryIdx = headers.indexOf("country");

    if (keyIdx === -1 || nameIdx === -1 || countryIdx === -1) {
      if (own) db.close();
      return new Response(
        JSON.stringify({ error: "CSV must contain key, name, country columns" }),
        { status: 400, headers: { "Content-Type": "application/json" } },
      );
    }

    const preview: Lead[] = [];
    const errors: string[] = [];

    for (let i = 1; i < lines.length; i++) {
      const fields = parseCsvLine(lines[i]);
      const key = fields[keyIdx]?.trim();
      const name = fields[nameIdx]?.trim();
      const country = fields[countryIdx]?.trim();

      if (!key || !name || !country) {
        errors.push(`Row ${i}: missing key/name/country`);
        continue;
      }

      const lead: Lead = {
        key,
        name,
        country: country.toUpperCase(),
        stage: "raw",
        status: "pending_review",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };

      for (let j = 0; j < headers.length; j++) {
        const h = headers[j];
        if (j === keyIdx || j === nameIdx || j === countryIdx) continue;
        const val = fields[j]?.trim();
        if (!val) continue;
        if (h === "emails") {
          (lead as any).emails = buildEmailsJson(val);
        } else if (IMPORTABLE_CSV_COLUMNS.has(h)) {
          (lead as any)[h] = val;
        }
      }

      preview.push(lead);
    }

    if (!dryRun) {
      const { upsertLead } = await import("../db/leads.js");
      for (const lead of preview) {
        upsertLead(db, lead);
      }
    }

    if (own) db.close();
    return new Response(
      JSON.stringify({
        dryRun,
        imported: dryRun ? 0 : preview.length,
        preview: preview.slice(0, 10),
        total_rows: preview.length,
        errors,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function handleCrawlRuns(url: URL, externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 20, 100);
    const runs = listCrawlRuns(db, limit);
    if (own) db.close();
    return new Response(JSON.stringify({ runs }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/**
 * GET /cmd/replies — reply drafts for the HITL inbox. Enriches each
 * replies_log row with its lead's name/country so the UI can render a
 * human-friendly card. `?status=pending` (default) returns only drafts
 * awaiting a human decision; omit for the full recent history.
 */
function handleReplies(url: URL, externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const status = url.searchParams.get("status");
    const limit = Math.min(Number(url.searchParams.get("limit")) || 100, 500);
    let rows;
    if (status && status !== "pending") {
      // Full history path: reuse the recent list, then filter client-side.
      rows = listRecentReplies(db, limit).filter((r) => r.draft_status === status);
    } else {
      rows = getPendingDrafts(db).slice(0, limit);
    }
    const enriched = rows.map((r) => {
      const lead = getLead(db, r.lead_key);
      return {
        ...r,
        lead_name: lead?.name ?? r.lead_key,
        lead_country: lead?.country ?? "",
        lead_status: lead?.status ?? null,
      };
    });
    if (own) db.close();
    return new Response(JSON.stringify({ replies: enriched }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

/** GET /cmd/sent — the sent-email log (most recent first). */
function handleSentLog(url: URL, externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const entries = listRecentSent(db, limit);
    if (own) db.close();
    return new Response(JSON.stringify({ sent: entries }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function handlePipeline(externalDb?: DatabaseType.Database): Response {
  const { db, own } = useDb(externalDb);
  try {
    const counts = countByStage(db);
    const funnel = [
      "raw",
      "verified",
      "classified",
      "researched",
      "approved",
      "sent",
      "replied",
    ].map((stage) => ({ stage, count: counts[stage] ?? 0 }));

    if (own) db.close();
    return new Response(
      JSON.stringify({
        stages: counts,
        funnel,
        total: Object.values(counts).reduce((a, b) => a + b, 0),
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    if (own) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
