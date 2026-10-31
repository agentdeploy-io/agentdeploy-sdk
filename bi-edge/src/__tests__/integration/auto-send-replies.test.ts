import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
  createHandler: vi.fn(() => ({ fetch: async () => new Response("{}", { status: 200 }) })),
  gatewayFetchWithBackoff: vi.fn(),
  gatewayHeaders: vi.fn(() => ({})),
  parseLlmJson: vi.fn(),
}));

vi.mock("../../agents/outreach.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../agents/outreach.js")>();
  return {
    ...actual,
    sendViaBrevo: vi.fn(async () => ({ messageId: "msg-auto-sent" })),
  };
});

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  runMigrations,
  upsertLead,
  logSentEmail,
  setSetting,
  getReplyLogById,
  listRecentSent,
} from "../../db/index.js";
import { handleInboundWebhook } from "../../routes/inbound-webhook.js";
import { gatewayFetchWithBackoff, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import { sendViaBrevo } from "../../agents/outreach.js";
import type { Lead } from "../../db/types.js";

const mockedFetch = vi.mocked(gatewayFetchWithBackoff);
const mockedBrevo = vi.mocked(sendViaBrevo);

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeSentLead(d: DatabaseType.Database): Lead {
  const lead: Lead = {
    key: "uk/auto-send-test",
    country: "UK",
    name: "Auto Send Test Ltd",
    website: "https://autosendtest.co.uk",
    emails: JSON.stringify([{ address: "owner@autosendtest.co.uk", kind: "role", mx_ok: true }]),
    stage: "sent",
    status: "sent",
    pitch_subject: "Missed calls = missed jobs",
    pitch_body: "Hi, we build AI receptionists...",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };
  upsertLead(d, lead);
  logSentEmail(d, {
    lead_key: lead.key,
    email: "owner@autosendtest.co.uk",
    subject: lead.pitch_subject ?? "",
    message_id: "msg-auto-1",
    status: "sent",
    at: new Date().toISOString(),
  });
  return lead;
}

const ENV: Record<string, unknown> = {
  BRAND_NAME: "Agent Miles",
  BREVO_API_KEY: "test-key",
  BREVO_SENDER_EMAIL: "agent.miles@gradient3.io",
  AD_MODEL: "test-model",
};

function mockLlm() {
  vi.mocked(parseLlmJson).mockImplementation((x: any) => JSON.parse(x.choices[0].message.content));
  mockedFetch.mockImplementation(async (_url, init?: any) => {
    const body = JSON.parse(init!.body);
    const isClassify = body.messages[0].content.includes("You classify inbound email");
    const classify = {
      replies: [
        {
          leadKey: "uk/auto-send-test",
          email: "owner@autosendtest.co.uk",
          intent: "interested",
          permanent: false,
          summary: "wants a call",
          replyFrom: "owner@autosendtest.co.uk",
          replySubject: "Re: Missed calls = missed jobs",
          replyBody: "Interested — can we talk this week?",
        },
      ],
    };
    const draft = {
      replies: [
        {
          key: "uk/auto-send-test",
          subject: "Re: Missed calls = missed jobs",
          body: "Hi, glad to hear it — here are slots: Mon 14:00 (UK) or Tue 16:00 (UK).",
        },
      ],
    };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(isClassify ? classify : draft) } }],
      }),
    } as any;
  });
}

async function postReply(db: DatabaseType.Database): Promise<Record<string, unknown>> {
  const payload = {
    items: [
      {
        MessageId: `as-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        From: { Address: "owner@autosendtest.co.uk", Name: "" },
        Subject: "Re: Missed calls = missed jobs",
        RawTextBody: "Interested — can we talk this week?",
        SentAtDate: new Date().toISOString(),
        SpamScore: 0,
      },
    ],
  };
  const req = new Request("http://x/inbound-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const res = await handleInboundWebhook(req, ENV as any, db);
  return res.json() as Promise<Record<string, unknown>>;
}

describe("autoSendReplies (HITL toggle)", () => {
  let db: DatabaseType.Database;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    db = createTestDb();
    makeSentLead(db);
    mockLlm();
  });

  it("default (HITL on): draft stays pending, nothing sent", async () => {
    const out = await postReply(db);
    expect(out.drafted).toBe(1);
    expect(out.autoSent ?? 0).toBe(0);
    const row = db
      .prepare("SELECT draft_status FROM replies_log WHERE lead_key = ?")
      .get("uk/auto-send-test") as { draft_status: string | null };
    expect(row.draft_status).toBe("pending");
    expect(mockedBrevo).not.toHaveBeenCalled();
    // only the original pitch is in sent_log
    expect(listRecentSent(db).filter((s) => s.lead_key === "uk/auto-send-test")).toHaveLength(1);
  });

  it("autoSendReplies + dry-run: draft auto-marked sent without network", async () => {
    setSetting(db, "autoSendReplies", "true");
    // dryRun defaults to true in a fresh DB
    const out = await postReply(db);
    expect(out.autoSent).toBe(1);
    const row = db
      .prepare("SELECT draft_status FROM replies_log WHERE lead_key = ?")
      .get("uk/auto-send-test") as { draft_status: string | null };
    expect(row.draft_status).toBe("sent");
    expect(mockedBrevo).not.toHaveBeenCalled();
    const sent = listRecentSent(db).filter((s) => s.lead_key === "uk/auto-send-test");
    expect(sent).toHaveLength(2);
    expect(sent[0].status).toBe("dry-run");
  });

  it("autoSendReplies + live send: delivers via Brevo with Re: subject", async () => {
    setSetting(db, "autoSendReplies", "true");
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    const out = await postReply(db);
    expect(out.autoSent).toBe(1);
    expect(mockedBrevo).toHaveBeenCalledTimes(1);
    const [to, name, subject, html] = mockedBrevo.mock.calls[0];
    expect(to).toBe("owner@autosendtest.co.uk");
    expect(subject).toBe("Re: Missed calls = missed jobs");
    expect(html).toContain("glad to hear it");
    const row = getReplyLogById(db, (db.prepare("SELECT MAX(id) AS id FROM replies_log").get() as { id: number }).id);
    expect(row?.draft_status).toBe("sent");
  });

  it("autoSendReplies + sendEnabled=false: draft held pending", async () => {
    setSetting(db, "autoSendReplies", "true");
    setSetting(db, "dryRun", "false");
    // sendEnabled defaults to false
    const out = await postReply(db);
    expect(out.autoSent ?? 0).toBe(0);
    const row = db
      .prepare("SELECT draft_status FROM replies_log WHERE lead_key = ?")
      .get("uk/auto-send-test") as { draft_status: string | null };
    expect(row.draft_status).toBe("pending");
    expect(mockedBrevo).not.toHaveBeenCalled();
  });
});
