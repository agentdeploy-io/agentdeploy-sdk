import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../db/migrations.js";
import { setSetting } from "../db/settings.js";
import { addToBlacklist } from "../db/blacklist.js";
import { logSentEmail } from "../db/sent-log.js";
import { runGateStack } from "../agents/outreach.js";
import type { Lead } from "../db/types.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeApprovedLead(overrides: Partial<Lead> = {}): Lead {
  return {
    key: "uk/12345",
    country: "uk",
    name: "Acme Ltd",
    stage: "approved",
    status: "approved",
    emails: JSON.stringify([{ addr: "hello@acme.com", kind: "role", source: "web", confidence: 0.9, mx_ok: true }]),
    pitch_subject: "AI intake tool",
    pitch_body: "Hi, we help firms like yours automate intake.",
    ...overrides,
  };
}

function openAllGates(db: Database.Database): void {
  setSetting(db, "paused", "false");
  setSetting(db, "sendEnabled", "true");
  setSetting(db, "dryRun", "true");
  setSetting(db, "dailyCap", "10");
}

describe("gate-stack property tests", () => {
  let db: Database.Database;
  const env: Record<string, unknown> = { BRAND_NAME: "TestBrand" };

  beforeEach(() => {
    db = createDb();
    openAllGates(db);
  });

  it("all gates open → proceed is true", () => {
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("gate 1: lead not approved → blocked", () => {
    const lead = makeApprovedLead({ status: "pending_review", stage: "verified" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/not approved/);
  });

  it("gate 2: email mx_ok = false → blocked", () => {
    const lead = makeApprovedLead({
      emails: JSON.stringify([{ addr: "bad@acme.com", kind: "role", source: "web", confidence: 0.5, mx_ok: false }]),
    });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/MX/);
  });

  it("gate 3: paused → blocked", () => {
    setSetting(db, "paused", "true");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/paused/);
  });

  it("gate 4: daily cap reached → blocked", () => {
    setSetting(db, "dailyCap", "1");
    logSentEmail(db, {
      lead_key: "uk/99999",
      email: "other@test.com",
      subject: "test",
      message_id: null,
      status: "sent",
      at: new Date().toISOString(),
    });
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/daily cap/);
  });

  it("gate 5: blacklisted email → blocked", () => {
    addToBlacklist(db, "hello@acme.com", "email", "spam");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blacklisted/);
  });

  it("gate 5b: blacklisted domain → blocked", () => {
    addToBlacklist(db, "acme.com", "domain", "competitor");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blacklisted/);
  });

  it("gate 6: sendEnabled = false → blocked", () => {
    setSetting(db, "sendEnabled", "false");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/sendEnabled/);
  });

  it("gate 7: dryRun = true → proceed but email field is empty", () => {
    setSetting(db, "dryRun", "true");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.email).toBe("");
    expect(result.statusStr).toBe("dry-run");
  });

  it("gate 7b: dryRun = false → proceed with email populated", () => {
    setSetting(db, "dryRun", "false");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.email).toBe("hello@acme.com");
    expect(result.statusStr).toBe("queued");
  });

  it("no pitch body → blocked", () => {
    const lead = makeApprovedLead({ pitch_body: null });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/no pitch/);
  });

  it("no email address → blocked", () => {
    const lead = makeApprovedLead({ emails: null });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/no contact address/);
  });

  it("opted out lead → blocked permanently", () => {
    const lead = makeApprovedLead({ status: "opted_out" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/opted out/);
  });
});
