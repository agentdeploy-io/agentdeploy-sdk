import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead, getLead, setSetting, addToBlacklist, logSentEmail, getSentByLead, countSentToday } from "../../db/index.js";
import { runGateStack, runOutreach, getFirstEmail } from "../../agents/outreach.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeFullyPreparedLead(overrides: Partial<Lead> = {}): Lead {
  return {
    key: "uk/outreach-001",
    country: "uk",
    name: "Acme Digital Ltd",
    sic: "62012",
    sic_label: "Business software development",
    website: "https://acmedigital.co.uk",
    website_status: "verified",
    emails: JSON.stringify([
      { addr: "hello@acmedigital.co.uk", kind: "role", source: "web", confidence: 0.9, mx_ok: true },
    ]),
    stage: "approved",
    status: "approved",
    pitch_subject: "Quick question about your intake process",
    pitch_body: "Hi there, I noticed Acme Digital is growing fast. We help agencies automate lead intake so no opportunity slips through the cracks. Would a 15-minute call make sense?",
    classification: JSON.stringify({
      tier: "HOT",
      fit: 92,
      vertical: "Digital Agency",
      signals: ["SIC match", "team size"],
    }),
    research: JSON.stringify({
      services: ["web design", "SEO"],
      team: ["8 people"],
      techStack: ["WordPress"],
      clients: [],
      news: [],
      snippets: [],
    }),
    created_at: "2025-01-01T00:00:00Z",
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

function openAllGates(db: DatabaseType.Database): void {
  setSetting(db, "paused", "false");
  setSetting(db, "sendEnabled", "true");
  setSetting(db, "dryRun", "false");
  setSetting(db, "dailyCap", "50");
}

describe("outreach-gates integration", () => {
  let db: DatabaseType.Database;
  const env: Record<string, unknown> = {
    BRAND_NAME: "TestBrand",
    BRAND_SITE_URL: "https://testbrand.com",
    CALENDLY_URL: "https://calendly.com/testbrand",
    BREVO_API_KEY: "mock-brevo-key",
    BREVO_SENDER_EMAIL: "outreach@testbrand.com",
  };

  beforeEach(() => {
    db = createTestDb();
    openAllGates(db);
  });

  afterEach(() => {
    db.close();
  });

  it("fully prepared lead passes all gates", () => {
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.reason).toBe("");
    expect(result.email).toBe("hello@acmedigital.co.uk");
  });

  it("gate: lead not approved → blocked", () => {
    const lead = makeFullyPreparedLead({ status: "pending_review", stage: "researched" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/not approved/);
  });

  it("gate: lead opted_out → blocked", () => {
    const lead = makeFullyPreparedLead({ status: "opted_out" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/opted out/);
  });

  it("gate: lead rejected → blocked", () => {
    const lead = makeFullyPreparedLead({ status: "rejected" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/rejected/);
  });

  it("gate: paused → blocked", () => {
    setSetting(db, "paused", "true");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/paused/);
  });

  it("gate: sendEnabled=false → blocked", () => {
    setSetting(db, "sendEnabled", "false");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/sendEnabled/);
  });

  it("gate: daily cap reached → blocked", () => {
    setSetting(db, "dailyCap", "2");
    logSentEmail(db, {
      lead_key: "uk/other-1",
      email: "other1@test.com",
      subject: "test 1",
      message_id: "msg-1",
      status: "sent",
      at: new Date().toISOString(),
    });
    logSentEmail(db, {
      lead_key: "uk/other-2",
      email: "other2@test.com",
      subject: "test 2",
      message_id: "msg-2",
      status: "sent",
      at: new Date().toISOString(),
    });

    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/daily cap/);
  });

  it("gate: already sent to this lead → blocked even if re-approved", () => {
    logSentEmail(db, {
      lead_key: "uk/outreach-001",
      email: "hello@acmedigital.co.uk",
      subject: "prior send",
      message_id: "msg-prior",
      status: "sent",
      at: new Date().toISOString(),
    });
    // Operator re-approves the already-sent lead (status back to approved) —
    // the sent_log guard must still block, so the same business is never
    // emailed twice.
    const lead = makeFullyPreparedLead({ stage: "approved", status: "approved" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/already sent to this lead/);
  });

  it("gate: already sent to this email from another lead → blocked", () => {
    logSentEmail(db, {
      lead_key: "uk/duplicate-lead",
      email: "hello@acmedigital.co.uk",
      subject: "prior send",
      message_id: "msg-dup",
      status: "sent",
      at: new Date().toISOString(),
    });
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/already sent to this email address/);
  });

  it("gate: prior dry-run rows do not block a real send", () => {
    logSentEmail(db, {
      lead_key: "uk/outreach-001",
      email: "hello@acmedigital.co.uk",
      subject: "dry run",
      message_id: null,
      status: "dry-run",
      at: new Date().toISOString(),
    });
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.reason).toBe("");
  });

  it("gate: blacklisted email → blocked", () => {
    addToBlacklist(db, "hello@acmedigital.co.uk", "email", "reported spam");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blacklisted/);
  });

  it("gate: blacklisted domain → blocked", () => {
    addToBlacklist(db, "acmedigital.co.uk", "domain", "competitor");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blacklisted/);
  });

  it("gate: email mx_ok=false → blocked", () => {
    const lead = makeFullyPreparedLead({
      emails: JSON.stringify([
        { addr: "hello@acmedigital.co.uk", kind: "role", source: "web", confidence: 0.5, mx_ok: false },
      ]),
    });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/MX/);
  });

  it("gate: no pitch body → blocked", () => {
    const lead = makeFullyPreparedLead({ pitch_body: null });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/no pitch/);
  });

  it("gate: no email address → blocked", () => {
    const lead = makeFullyPreparedLead({ emails: null });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/no contact/);
  });

  it("dry-run mode: all gates pass; email names the intended target but nothing sends", () => {
    setSetting(db, "dryRun", "true");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(true);
    expect(result.dryRun).toBe(true);
    // email always carries the intended recipient now (test mode relies on it);
    // runOutreach only calls sendViaBrevo when !dryRun.
    expect(result.email).toBe(getFirstEmail(lead));
    expect(result.statusStr).toBe("dry-run");
  });

  it("dry-run outreach: logs sent email and updates stage", async () => {
    setSetting(db, "dryRun", "true");
    const lead = makeFullyPreparedLead();
    upsertLead(db, lead);

    const result = await runOutreach(db, lead, env);

    expect(result.proceed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.statusStr).toBe("dry-run");

    const sentLogs = getSentByLead(db, lead.key);
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0].status).toBe("dry-run");
    expect(sentLogs[0].email).toBe("hello@acmedigital.co.uk");
    expect(sentLogs[0].message_id).toBeNull();

    const updated = getLead(db, lead.key);
    expect(updated?.stage).toBe("sent");
    expect(updated?.status).toBe("sent");
  });

  it("live send: calls Brevo and logs sent email", async () => {
    setSetting(db, "dryRun", "false");
    const lead = makeFullyPreparedLead();
    upsertLead(db, lead);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ messageId: "brevo-msg-12345" }),
      text: async () => "",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runOutreach(db, lead, env);

    expect(result.proceed).toBe(true);
    expect(result.statusStr).toBe("sent");

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toContain("brevo.com");
    const body = JSON.parse(opts.body);
    expect(body.to[0].email).toBe("hello@acmedigital.co.uk");
    expect(body.subject).toBe("Quick question about your intake process");

    const sentLogs = getSentByLead(db, lead.key);
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0].status).toBe("sent");
    expect(sentLogs[0].message_id).toBe("brevo-msg-12345");
    expect(sentLogs[0].email).toBe("hello@acmedigital.co.uk");

    const updated = getLead(db, lead.key);
    expect(updated?.stage).toBe("sent");
    expect(updated?.status).toBe("sent");

    vi.unstubAllGlobals();
  });

  it("live send failure: logs failure and returns blocked", async () => {
    setSetting(db, "dryRun", "false");
    const lead = makeFullyPreparedLead();
    upsertLead(db, lead);

    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal server error",
    });
    vi.stubGlobal("fetch", mockFetch);

    const result = await runOutreach(db, lead, env);

    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/send failed/);
    expect(result.statusStr).toBe("failed");

    const sentLogs = getSentByLead(db, lead.key);
    expect(sentLogs).toHaveLength(1);
    expect(sentLogs[0].status).toMatch(/failed/);
    expect(sentLogs[0].message_id).toBeNull();

    vi.unstubAllGlobals();
  });

  it("sent_log count is correctly tracked across multiple sends", async () => {
    setSetting(db, "dryRun", "true");

    for (let i = 0; i < 5; i++) {
      const lead = makeFullyPreparedLead({ key: `uk/batch-${i}` });
      upsertLead(db, lead);
      await runOutreach(db, lead, env);
    }

    const todayCount = countSentToday(db);
    expect(todayCount).toBe(5);
  });

  it("gate: blocked SIC code → blocked", () => {
    setSetting(db, "blockedSics", "62012");
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blocked vertical/);
  });

  it("gate: blocked keyword in name → blocked", () => {
    setSetting(db, "blockedKeywords", "casino");
    const lead = makeFullyPreparedLead({ name: "Casino Digital Ltd" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/blocked keyword/);
  });

  it("gate: headcount exceeds maxHeadcount → blocked", () => {
    setSetting(db, "maxHeadcount", "10");
    const lead = makeFullyPreparedLead({
      classification: JSON.stringify({
        tier: "HOT",
        fit: 92,
        vertical: "Digital Agency",
        headcount: 500,
        signals: [],
      }),
    });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/too large/);
  });

  it("HTML email body is correctly generated", () => {
    const lead = makeFullyPreparedLead();
    const result = runGateStack(db, lead, env);
    expect(result.html).toContain("Acme Digital is growing fast");
    expect(result.html).toContain("TestBrand");
    expect(result.html).toContain("testbrand.com");
    expect(result.html).toContain("Reply <b>STOP</b> to opt out");
  });
});
