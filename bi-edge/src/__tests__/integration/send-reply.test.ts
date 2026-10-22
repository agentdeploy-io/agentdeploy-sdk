import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// supervisor.ts transitively imports the Workers-only edge SDK (cloudflare:
// scheme) — stub it out; handleCommand under test never calls the LLM.
vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
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
  logReply,
  getReplyLogById,
  listRecentSent,
  countSentToday,
} from "../../db/index.js";
import { handleCommand } from "../../agents/supervisor.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeSentLead(d: DatabaseType.Database, overrides: Partial<Lead> = {}): Lead {
  const lead: Lead = {
    key: "uk/acme-replies",
    country: "UK",
    name: "Acme Digital Ltd",
    website: "https://acmedigital.co.uk",
    emails: JSON.stringify([
      { addr: "hello@acmedigital.co.uk", kind: "role", source: "web", confidence: 0.9, mx_ok: true },
    ]),
    stage: "sent",
    status: "sent",
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
  BRAND_LOGO_URL: "https://gradient3.io/favicon.svg",
  BREVO_API_KEY: "test-key",
  BREVO_SENDER_EMAIL: "agent.miles@gradient3.io",
};

describe("send-reply (G3)", () => {
  let db: DatabaseType.Database;

  beforeEach(() => {
    db = createTestDb();
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  function addPendingDraft(d: DatabaseType.Database, overrides: Partial<{ lead_key: string; reply_from: string; reply_subject: string; draft: string }> = {}): number {
    const id = logReply(d, {
      lead_key: overrides.lead_key ?? "uk/acme-replies",
      reply_from: overrides.reply_from ?? "owner@acmedigital.co.uk",
      reply_subject: overrides.reply_subject ?? "Re: Quick question about your intake process",
      reply_body: "This sounds interesting, tell me more.",
      intent: "interested",
      draft: overrides.draft ?? "Thanks for the quick reply! Happy to show you how the intake agent works — here's my calendar: cal.com/agent-miles",
      draft_status: "pending",
      at: new Date().toISOString(),
    });
    return id as number;
  }

  it("dry-run: logs the reply, marks draft sent, lead replied, no network", async () => {
    setSetting(db, "dryRun", "true");
    setSetting(db, "sendEnabled", "true");
    makeSentLead(db);
    const id = addPendingDraft(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);

    expect(out).toContain("DRY-RUN");
    expect(out).toContain("owner@acmedigital.co.uk");
    expect(fetchMock).not.toHaveBeenCalled();
    const draft = getReplyLogById(db, id);
    expect(draft?.draft_status).toBe("sent");
    expect(draft?.draft).toBeTruthy();
    const lead = getLead(db, "uk/acme-replies");
    expect(lead?.status).toBe("replied");
    const sent = listRecentSent(db, 5);
    expect(sent.length).toBe(1);
    expect(sent[0].status).toBe("dry-run");
    expect(sent[0].email).toBe("owner@acmedigital.co.uk");
    expect(sent[0].subject).toBe("Re: Quick question about your intake process");
  });

  it("real send: calls Brevo with the draft body + brand footer", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    setSetting(db, "dailyCap", "10");
    makeSentLead(db);
    const id = addPendingDraft(db);
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ messageId: "msg-123" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);

    expect(out).toContain("sent");
    expect(out).toContain("msg-123");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    const body = JSON.parse(String(init.body));
    expect(body.to[0].email).toBe("owner@acmedigital.co.uk");
    expect(body.sender.email).toBe("agent.miles@gradient3.io");
    expect(body.subject).toBe("Re: Quick question about your intake process");
    expect(body.htmlContent).toContain("intake agent works");
    expect(body.htmlContent).toContain("Agent Miles");
    expect(body.htmlContent).toContain("gradient3.io");
    expect(body.htmlContent).toContain("favicon.svg");
    expect(countSentToday(db)).toBe(1);
    expect(getReplyLogById(db, id)?.draft_status).toBe("sent");
    expect(getLead(db, "uk/acme-replies")?.status).toBe("replied");
  });

  it("strips existing Re: prefix from the reply subject", async () => {
    setSetting(db, "dryRun", "true");
    makeSentLead(db);
    const id = addPendingDraft(db, { reply_subject: "Re: Re: Fwd: Quick question about your intake process" });
    vi.stubGlobal("fetch", vi.fn());

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);
    expect(out).toContain("Re: Quick question about your intake process");
  });

  it("blocks when the lead opted out", async () => {
    setSetting(db, "dryRun", "true");
    makeSentLead(db, { status: "opted_out" });
    const id = addPendingDraft(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);
    expect(out).toContain("opted out");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getReplyLogById(db, id)?.draft_status).toBe("pending");
  });

  it("blocks real send when sendEnabled is false", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "false");
    makeSentLead(db);
    const id = addPendingDraft(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);
    expect(out).toContain("sendEnabled is false");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("blocks when the daily cap is reached", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    setSetting(db, "dailyCap", "2");
    makeSentLead(db);
    const id = addPendingDraft(db);
    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO sent_log (lead_key, email, subject, message_id, status, at) VALUES (?, ?, ?, ?, 'sent', ?), (?, ?, ?, ?, 'sent', ?)",
    ).run("uk/a", "a@x.com", "s", null, now, "uk/b", "b@x.com", "s", null, now);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const out = await handleCommand("/send-reply", [String(id)], db, ENV);
    expect(out).toContain("Daily cap reached");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never sends an already-sent or discarded draft", async () => {
    setSetting(db, "dryRun", "true");
    makeSentLead(db);
    const id = addPendingDraft(db);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await handleCommand("/send-reply", [String(id)], db, ENV);
    const out2 = await handleCommand("/send-reply", [String(id)], db, ENV);
    expect(out2).toContain("already sent");
    expect(fetchMock).toHaveBeenCalledTimes(0);

    const id2 = addPendingDraft(db, { draft: "another" });
    const out3 = await handleCommand("/discard-reply", [String(id2)], db, ENV);
    expect(out3).toContain("discarded");
    const out4 = await handleCommand("/send-reply", [String(id2)], db, ENV);
    expect(out4).toContain("discarded");
    expect(getReplyLogById(db, id2)?.draft).toBe("another");
  });

  it("handles unknown ids gracefully", async () => {
    vi.stubGlobal("fetch", vi.fn());
    expect(await handleCommand("/send-reply", ["999"], db, ENV)).toContain("not found");
    expect(await handleCommand("/send-reply", [], db, ENV)).toContain("Usage");
    expect(await handleCommand("/discard-reply", ["999"], db, ENV)).toContain("not found");
  });
});
