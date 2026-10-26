import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { CfSqlDatabase } from "../../db/cf-sqlite.js";
import { handleInboundSync } from "../../routes/inbound-sync.js";
import { runMigrations, getLead } from "../../db/index.js";
import { getFirstEmail, pickBestEmail } from "../../agents/outreach.js";
import type { Lead } from "../../db/types.js";

/**
 * Faithful stand-in for the Cloudflare DO `storage.sql` binding: it executes
 * against a real better-sqlite3 database but coerces bound arrays/objects
 * with String() exactly like the observed CF behavior — which is what
 * silently stored "[object Object]" into every crawler-sourced lead's
 * emails/phones/socials. Tests must go through this wrapper (not raw
 * better-sqlite3, which throws on arrays) or the test can diverge from
 * production.
 */
function cfLikeStorage(real: DatabaseType.Database) {
  const coerce = (p: unknown): unknown =>
    p != null && typeof p === "object" && !(p instanceof ArrayBuffer) && !ArrayBuffer.isView(p)
      ? String(p)
      : p;
  const isQuery = (q: string) => /^\s*(SELECT|PRAGMA|WITH)/i.test(q);
  return {
    exec(...args: unknown[]) {
      const [query, ...params] = args;
      const q = String(query);
      if (params.length === 0) {
        if (isQuery(q)) return { toArray: () => real.prepare(q).all(), rowsWritten: 0 };
        real.exec(q);
        return { toArray: () => [], rowsWritten: 0 };
      }
      const coerced = params.map(coerce);
      if (isQuery(q)) return { toArray: () => real.prepare(q).all(...coerced), rowsWritten: 0 };
      const info = real.prepare(q).run(...coerced);
      return { toArray: () => [], rowsWritten: info.changes };
    },
  } as unknown as SqlStorage;
}

function makeCfDb(): { db: CfSqlDatabase; real: DatabaseType.Database } {
  const real = new Database(":memory:");
  const db = new CfSqlDatabase(cfLikeStorage(real), (cb) => cb());
  runMigrations(db as unknown as DatabaseType.Database);
  return { db, real };
}

function postSync(
  db: CfSqlDatabase,
  leads: Array<Record<string, unknown>>,
): Promise<Response> {
  const request = new Request("http://localhost/inbound/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AD-Sync": "s3cret" },
    body: JSON.stringify({ leads }),
  });
  return handleInboundSync(request, { AD_SYNC_SECRET: "s3cret" }, db as unknown as DatabaseType.Database);
}

describe("sync contact-field serialization (P0 regression)", () => {
  let real: DatabaseType.Database;
  let db: CfSqlDatabase;

  beforeEach(() => {
    const f = makeCfDb();
    real = f.real;
    db = f.db;
  });

  afterEach(() => {
    real.close();
  });

  it("stores array emails/phones/socials as JSON, not '[object Object]'", async () => {
    const res = await postSync(db, [
      {
        key: "uk/probe-1",
        country: "uk",
        name: "Probe Design Ltd",
        source: "dork:brave",
        stage: "raw",
        emails: [{ address: "hello@probedesign.co.uk", kind: "role", mx_ok: true }],
        phones: ["+44 20 7946 0001"],
        socials: { linkedin: ["https://linkedin.com/company/probedesign"] },
      },
    ]);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(1);

    const emails = real.prepare("SELECT emails FROM leads WHERE key='uk/probe-1'").get() as { emails: string };
    expect(emails.emails).toBe(JSON.stringify([{ address: "hello@probedesign.co.uk", kind: "role", mx_ok: true }]));
    const phones = real.prepare("SELECT phones FROM leads WHERE key='uk/probe-1'").get() as { phones: string };
    expect(phones.phones).toBe(JSON.stringify(["+44 20 7946 0001"]));
  });

  it("resets corrupted legacy '[object Object]' strings to null", async () => {
    const res = await postSync(db, [
      {
        key: "uk/probe-2",
        country: "uk",
        name: "Legacy Co",
        source: "dork:brave",
        stage: "raw",
        emails: "[object Object]",
        phones: "[object Object, Object]",
      },
    ]);
    expect(res.status).toBe(200);
    const row = real.prepare("SELECT emails, phones FROM leads WHERE key='uk/probe-2'").get() as { emails: string | null; phones: string | null };
    expect(row.emails).toBeNull();
    expect(row.phones).toBeNull();
  });

  it("keeps already-JSON string contact fields intact", async () => {
    const json = JSON.stringify([{ addr: "tom@gradient3.io", kind: "role" }]);
    const res = await postSync(db, [
      { key: "uk/probe-3", country: "uk", name: "JSON String Co", source: "csv", stage: "raw", emails: json },
    ]);
    expect(res.status).toBe(200);
    const row = real.prepare("SELECT emails FROM leads WHERE key='uk/probe-3'").get() as { emails: string };
    expect(row.emails).toBe(json);
  });

  it("outreach helpers fail closed on corrupted rows", () => {
    const bad: Lead = { key: "uk/x", country: "uk", name: "X", stage: "raw", emails: "[object Object]" };
    expect(getFirstEmail(bad)).toBe("");
    expect(pickBestEmail(bad)).toBe("");
  });

  it("pickBestEmail prefers personal > role > guessed, mx_ok first", () => {
    const lead: Lead = {
      key: "uk/y",
      country: "uk",
      name: "Y",
      stage: "raw",
      emails: JSON.stringify([
        { address: "info@y.co.uk", kind: "role", mx_ok: true },
        { address: "info@y.co.uk", kind: "guessed", mx_ok: true },
        { address: "tom@y.co.uk", kind: "personal", mx_ok: true },
      ]),
    };
    expect(pickBestEmail(lead)).toBe("tom@y.co.uk");

    const noPersonal: Lead = { ...lead, emails: JSON.stringify([
      { address: "info@y.co.uk", kind: "role", mx_ok: true },
      { address: "hello@y.co.uk", kind: "guessed", mx_ok: true },
    ]) };
    expect(pickBestEmail(noPersonal)).toBe("info@y.co.uk");

    const mxFail: Lead = { ...lead, emails: JSON.stringify([
      { address: "tom@y.co.uk", kind: "personal", mx_ok: false },
      { address: "info@y.co.uk", kind: "role", mx_ok: true },
    ]) };
    expect(pickBestEmail(mxFail)).toBe("info@y.co.uk");
  });
});
