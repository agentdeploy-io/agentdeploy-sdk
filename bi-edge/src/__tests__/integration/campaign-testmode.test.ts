import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
  createHandler: vi.fn(() => ({ fetch: async () => new Response("{}", { status: 200 }) })),
  gatewayFetchWithBackoff: vi.fn(),
  gatewayHeaders: vi.fn(() => ({})),
  parseLlmJson: vi.fn(),
}));

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  runMigrations,
  upsertLead,
  getLead,
  setSetting,
  logSentEmail,
  getReplyLogById,
  listRecentReplies,
  getSetting,
} from "../../db/index.js";
import { runGateStack, runOutreach, getFirstEmail } from "../../agents/outreach.js";
import { handleCommand } from "../../agents/supervisor.js";
import { handleInboundWebhook } from "../../routes/inbound-webhook.js";
import {
  resolveCampaign,
  campaignEnvOverrides,
  updateCampaign,
} from "../../services/campaign.js";
import { gatewayFetchWithBackoff, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import { BiEdgeAgent } from "../../index.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeLead(d: DatabaseType.Database, overrides: Partial<Lead> = {}): Lead {
  const lead: Lead = {
    key: "uk/acme-tm",
    country: "UK",
    name: "Acme Digital Ltd",
    website: "https://acmedigital.co.uk",
    emails: JSON.stringify([
      { addr: "hello@acmedigital.co.uk", kind: "role", source: "web", confidence: 0.9, mx_ok: true },
    ]),
    stage: "approved",
    status: "approved",
    pitch_subject: "Quick question about your intake process",
    pitch_body: "Hi there, we help agencies automate lead intake.",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
    ...overrides,
  };
  upsertLead(d, lead);
  return lead;
}

const ENV: Record<string, unknown> = {
  BRAND_NAME: "Agent Miles",
  BRAND_SITE_URL: "https://gradient3.io",
  BRAND_ONE_LINER: "We build AI employees for small businesses.",
  BRAND_LOGO_URL: "https://gradient3.io/favicon.svg",
  BREVO_API_KEY: "test-key",
  BREVO_SENDER_EMAIL: "agent.miles@gradient3.io",
  AD_MODEL: "test-model",
};

const mockedFetch = vi.mocked(gatewayFetchWithBackoff);

describe("campaign resolution", () => {
  it("falls back to env when no settings stored", () => {
    const db = createTestDb();
    const c = resolveCampaign(db, ENV as any);
    expect(c.brandName).toBe("Agent Miles");
    expect(c.brandOneLiner).toBe("We build AI employees for small businesses.");
    expect(c.icpNotes).toBe("");
  });

  it("settings override env; empty clears back to env", () => {
    const db = createTestDb();
    updateCampaign(db, { brandName: "Gradient Studio", icpNotes: "prioritise dental" } as any, ENV as any);
    let c = resolveCampaign(db, ENV as any);
    expect(c.brandName).toBe("Gradient Studio");
    expect(c.icpNotes).toBe("prioritise dental");

    // env override for writer/outreach picks up the UI edit
    const overrides = campaignEnvOverrides(db, ENV as any);
    expect(overrides.BRAND_NAME).toBe("Gradient Studio");
    expect(overrides.BRAND_ONE_LINER).toBe("We build AI employees for small businesses.");

    // clearing brandName falls back to env again
    updateCampaign(db, { brandName: "" } as any, ENV as any);
    c = resolveCampaign(db, ENV as any);
    expect(c.brandName).toBe("Agent Miles");
    // override now equals the env value (resolved campaign), still applied
    expect(campaignEnvOverrides(db, ENV as any).BRAND_NAME).toBe("Agent Miles");
  });
});

describe("test mode recipient redirect", () => {
  let db: DatabaseType.Database;
  beforeEach(() => {
    db = createTestDb();
    setSetting(db, "dryRun", "true");
  });

  it("gate stack targets the test inbox and skips the lead-email requirement", () => {
    setSetting(db, "sendEnabled", "true");
    // lead with NO email — normally blocked, allowed in test mode
    const lead = makeLead(db, { emails: "[]" });
    const blocked = runGateStack(db, lead, ENV as any);
    expect(blocked.proceed).toBe(false);

    setSetting(db, "testMode", "true");
    setSetting(db, "testRecipient", "founder@gradient3.io");
    const result = runGateStack(db, lead, ENV as any);
    expect(result.proceed).toBe(true);
    expect(result.email).toBe("founder@gradient3.io");
  });

  it("dry-run outreach logs the test recipient, not the lead email", async () => {
    setSetting(db, "sendEnabled", "true");
    const lead = makeLead(db);
    setSetting(db, "testMode", "true");
    setSetting(db, "testRecipient", "founder@gradient3.io");
    const gate = await runOutreach(db, lead, ENV as any);
    expect(gate.statusStr).toBe("dry-run");
    const rows = db.prepare("SELECT email FROM sent_log").all() as { email: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].email).toBe("founder@gradient3.io");
  });

  it("send-reply redirects to the test inbox in dry-run", async () => {
    const lead = makeLead(db, { key: "uk/acme-sr", stage: "replied", status: "replied" });
    logSentEmail(db, {
      lead_key: lead.key,
      email: getFirstEmail(lead),
      subject: lead.pitch_subject ?? "",
      message_id: null,
      status: "dry-run",
      at: new Date().toISOString(),
    });
    // a pending reply draft
    db.prepare(
      "INSERT INTO replies_log (lead_key, reply_from, reply_subject, reply_body, intent, draft, draft_status, at) VALUES (?,?,?,?,?,?,?,?)"
    ).run(lead.key, "tom@acme.com", "Re: quick question", "sounds interesting", "interested", "Great — here is how…", "pending", new Date().toISOString());
    const id = (db.prepare("SELECT last_insert_rowid() AS id").get() as any).id as number;

    setSetting(db, "testMode", "true");
    setSetting(db, "testRecipient", "founder@gradient3.io");
    const reply = await handleCommand("/send-reply", [String(id)], db, ENV as any);
    expect(reply).toContain("founder@gradient3.io");
    expect(reply).toContain("DRY-RUN");
  });
});

describe("simulate-reply (synthetic inbound webhook)", () => {
  it("classifies, matches the lead and lands a pending draft", async () => {
    const db = createTestDb();
    const lead = makeLead(db, { stage: "sent", status: "sent" });
    logSentEmail(db, {
      lead_key: lead.key,
      email: getFirstEmail(lead),
      subject: lead.pitch_subject ?? "",
      message_id: "msg-1",
      status: "sent",
      at: new Date().toISOString(),
    });

    // behave like the real parser: pull choices[0].message.content and JSON.parse it
    vi.mocked(parseLlmJson).mockImplementation((x: any) =>
      JSON.parse(x.choices[0].message.content)
    );
    mockedFetch.mockImplementation(async (_url, init?: any) => {
      const body = JSON.parse(init.body);
      const isClassify = body.messages[0].content.includes("You classify inbound email");
      if (isClassify) {
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: JSON.stringify({
              replies: [{
                leadKey: lead.key,
                email: getFirstEmail(lead),
                intent: "interested",
                permanent: false,
                summary: "wants a call",
                replyFrom: "founder@gradient3.io",
                replySubject: "Re: quick question",
                replyBody: "Yes, we could use help with this. Could we hop on a call?",
              }],
            }) } }],
          }),
        } as any;
      }
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify({
            replies: [{ key: lead.key, subject: "Re: quick question", body: "Absolutely — how about Tuesday?" }],
          }) } }],
        }),
      } as any;
    });

    const payload = {
      items: [{
        MessageId: "sim-test-1",
        From: { Address: "founder@gradient3.io", Name: "" },
        Subject: "Re: quick question",
        RawTextBody: "Yes, we could use help with this.",
        SentAtDate: new Date().toISOString(),
        SpamScore: 0,
      }],
    };
    const req = new Request("http://x/inbound-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await handleInboundWebhook(req, ENV as any, db);
    const out = await res.json();
    expect(out.matched).toBe(1);
    expect(out.drafted).toBe(1);

    const drafts = listRecentReplies(db, 10).filter((r) => r.draft);
    expect(drafts).toHaveLength(1);
    expect(drafts[0].lead_key).toBe(lead.key);
    expect(drafts[0].draft).toContain("Tuesday");
    expect(getLead(db, lead.key)?.status).toBe("replied");
  });
});

function classifyMock(leadKey: string, replyFrom: string, replyBody: string) {
  return {
    replies: [{
      leadKey,
      email: replyFrom,
      intent: "interested",
      permanent: false,
      summary: "wants a call",
      replyFrom,
      replySubject: "Re: quick question",
      replyBody,
    }],
  };
}

function mockLlmAndBrevo(leadKey: string, replyFrom: string, replyBody: string, brevoBodies: any[]) {
  vi.mocked(parseLlmJson).mockImplementation((x: any) => JSON.parse(x.choices[0].message.content));
  // LLM calls go through gatewayFetchWithBackoff; the Brevo send uses global fetch.
  vi.stubGlobal("fetch", async (url: any, init?: any) => {
    const u = String(url);
    if (u.includes("api.brevo.com")) {
      brevoBodies.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ messageId: "brevo-sim-1" }) } as any;
    }
    throw new Error(`Unexpected fetch in test: ${u}`);
  });
  mockedFetch.mockImplementation(async (url: any, init?: any) => {
    const body = JSON.parse(init.body);
    const isClassify = body.messages[0].content.includes("You classify inbound email");
    if (isClassify) {
      return {
        ok: true,
        json: async () => ({
          choices: [{ message: { content: JSON.stringify(classifyMock(leadKey, replyFrom, replyBody)) } }],
        }),
      } as any;
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify({
          replies: [{ key: leadKey, subject: "Re: quick question", body: "Absolutely — how about Tuesday?" }],
        }) } }],
      }),
    } as any;
  });
}

describe("worker POST /cmd/simulate-reply (real email in test mode)", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  function makeWorker(db: DatabaseType.Database): any {
    const worker = new BiEdgeAgent({ storage: {} } as any, ENV as any);
    (worker as any).db = db;
    return worker;
  }

  it("delivers a real Brevo email to the test inbox (threaded) and still drafts a response", async () => {
    const db = createTestDb();
    const lead = makeLead(db, { stage: "sent", status: "sent" });
    logSentEmail(db, {
      lead_key: lead.key,
      email: getFirstEmail(lead),
      subject: lead.pitch_subject ?? "",
      message_id: "msg-1",
      status: "sent",
      at: new Date().toISOString(),
    });
    setSetting(db, "testMode", "true");
    setSetting(db, "testRecipient", "founder@gradient3.io");

    const brevoBodies: any[] = [];
    mockLlmAndBrevo(lead.key, "founder@gradient3.io", "Yes — could we hop on a call?", brevoBodies);

    const req = new Request("http://worker/cmd/simulate-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sent_id: 1, from: "founder@gradient3.io", text: "Yes — could we hop on a call?" }),
    });
    const res = await makeWorker(db).fetch(req);
    expect(res.status).toBe(200);
    const out = await res.json();

    expect(out.matched).toBe(1);
    expect(out.drafted).toBe(1);
    expect(out.email).toEqual({
      to: "founder@gradient3.io",
      subject: `Re: ${lead.pitch_subject}`,
      messageId: "brevo-sim-1",
    });
    expect(brevoBodies).toHaveLength(1);
    expect(brevoBodies[0].to[0].email).toBe("founder@gradient3.io");
    expect(brevoBodies[0].subject).toBe(`Re: ${lead.pitch_subject}`);
    expect(brevoBodies[0].htmlContent).toContain("could we hop on a call");
    expect(brevoBodies[0].htmlContent).toContain("&gt;");
  });

  it("skips the real email when test mode is off", async () => {
    const db = createTestDb();
    const lead = makeLead(db, { key: "uk/acme-tm2", stage: "sent", status: "sent" });
    logSentEmail(db, {
      lead_key: lead.key,
      email: getFirstEmail(lead),
      subject: lead.pitch_subject ?? "",
      message_id: "msg-2",
      status: "sent",
      at: new Date().toISOString(),
    });

    const brevoBodies: any[] = [];
    mockLlmAndBrevo(lead.key, "founder@gradient3.io", "Yes — could we hop on a call?", brevoBodies);

    const req = new Request("http://worker/cmd/simulate-reply", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sent_id: 1, from: "founder@gradient3.io", text: "Yes — could we hop on a call?" }),
    });
    const res = await makeWorker(db).fetch(req);
    expect(res.status).toBe(200);
    const out = await res.json();

    expect(out.email).toBeNull();
    expect(brevoBodies).toHaveLength(0);
    expect(out.emailNote).toContain("Test mode off");
  });
});
