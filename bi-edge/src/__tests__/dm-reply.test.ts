import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// The DM loop talks to the LLM gateway (classify/draft) and the Manychat API
// (send). Both are stubbed: the gateway mock returns canned intents/replies,
// the global fetch mock records Manychat calls.
const mockState = vi.hoisted(() => ({
  intent: "interested" as string,
  manychatFetch: undefined as undefined | ReturnType<typeof vi.fn>,
}));

vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
  gatewayHeaders: vi.fn(() => ({})),
  gatewayFetchWithBackoff: vi.fn(async (_path: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { messages: Array<{ content: string }> };
    const sys = String(body.messages?.[0]?.content ?? "");
    const content = sys.includes("You classify")
      ? JSON.stringify({ intent: mockState.intent, summary: "test intent" })
      : JSON.stringify({ reply: "Thanks for reaching out — here is my calendar link." });
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }),
  parseLlmJson: vi.fn((obj: unknown) => {
    const gw = (obj as any)?.choices?.[0]?.message?.content ?? "";
    try {
      return JSON.parse(String(gw));
    } catch {
      return { response: String(gw) };
    }
  }),
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
  getPendingDrafts,
  logSentEmail,
  listRecentSent,
} from "../db/index.js";
import { processDmInbound, sendDmReplyDraft } from "../agents/dm-reply.js";
import { handleCommand } from "../agents/supervisor.js";
import type { Lead } from "../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeDmLead(db: DatabaseType.Database, overrides: Partial<Lead> = {}): Lead {
  const lead: Lead = {
    key: "mc-111",
    country: "ig",
    name: "Priya",
    source: "manychat",
    stage: "raw",
    status: "pending_review",
    manychat_subscriber_id: "111",
    ...overrides,
  };
  upsertLead(db, lead);
  return lead;
}

const ENV: Record<string, unknown> = {
  BRAND_NAME: "Agent Miles",
  CALENDLY_URL: "https://cal.com/agent-miles",
  MANYCHAT_API_KEY: "12:abc",
  AD_GATEWAY_BASE_URL: "http://llm.test",
};

function addPendingDmDraft(db: DatabaseType.Database, overrides: Partial<{ draft: string; lead_key: string }> = {}): number {
  const id = logReply(db, {
    lead_key: overrides.lead_key ?? "mc-111",
    reply_from: "Priya",
    reply_body: "Hi, are you taking on new clients?",
    intent: "interested",
    draft: overrides.draft ?? "Thanks for reaching out — here is my calendar link.",
    draft_status: "pending",
    at: new Date().toISOString(),
    channel: "manychat",
  });
  return id as number;
}

describe("dm-reply loop", () => {
  let db: DatabaseType.Database;

  beforeEach(() => {
    db = createTestDb();
    mockState.intent = "interested";
    mockState.manychatFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success" }), { status: 200, headers: { "Content-Type": "application/json" } }),
    );
    vi.stubGlobal("fetch", mockState.manychatFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    db.close();
  });

  describe("processDmInbound (classify → draft)", () => {
    it("interested DM → reply logged (channel manychat) + pending draft", async () => {
      makeDmLead(db);
      const out = await processDmInbound(db, "mc-111", "I'd love to work with you!", ENV);
      expect(out.intent).toBe("interested");
      expect(out.draftPending).toBe(true);

      const drafts = getPendingDrafts(db);
      expect(drafts.length).toBe(1);
      expect(drafts[0].channel).toBe("manychat");
      expect(drafts[0].draft).toContain("calendar link");
      expect(getLead(db, "mc-111")?.status).toBe("replied");
    });

    it("opt_out DM → lead opted out, no draft", async () => {
      mockState.intent = "opt_out";
      makeDmLead(db);
      const out = await processDmInbound(db, "mc-111", "stop messaging me", ENV);
      expect(out.intent).toBe("opt_out");
      expect(getPendingDrafts(db).length).toBe(0);
      expect(getLead(db, "mc-111")?.status).toBe("opted_out");
    });

    it("not_interested DM → no draft", async () => {
      mockState.intent = "not_interested";
      makeDmLead(db);
      const out = await processDmInbound(db, "mc-111", "lol nice post", ENV);
      expect(out.intent).toBe("not_interested");
      expect(out.draftPending).toBeFalsy();
      expect(getPendingDrafts(db).length).toBe(0);
    });

    it("empty text → no-op", async () => {
      makeDmLead(db);
      const out = await processDmInbound(db, "mc-111", "", ENV);
      expect(out).toEqual({});
    });
  });

  describe("sendDmReplyDraft", () => {
    it("dry-run by default: logs, marks sent, no Manychat call", async () => {
      makeDmLead(db);
      const id = addPendingDmDraft(db);
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("DRY-RUN");
      expect(out).toContain("111");
      expect(mockState.manychatFetch).not.toHaveBeenCalled();

      expect(getReplyLogById(db, id)?.draft_status).toBe("sent");
      const sent = listRecentSent(db, 5);
      expect(sent.length).toBe(1);
      expect(sent[0].status).toBe("dry-run");
      expect(sent[0].channel).toBe("manychat");
      expect(sent[0].email).toBe("dm:111");
    });

    it("real send blocked while dmEnabled is false", async () => {
      makeDmLead(db);
      setSetting(db, "dmDryRun", "false");
      const id = addPendingDmDraft(db);
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("dmEnabled is false");
      expect(mockState.manychatFetch).not.toHaveBeenCalled();
    });

    it("real send: Manychat sendContent with Bearer key + draft text", async () => {
      makeDmLead(db);
      setSetting(db, "dmDryRun", "false");
      setSetting(db, "dmEnabled", "true");
      const id = addPendingDmDraft(db, { draft: "Hey Priya, happy to chat — cal.com/agent-miles" });
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("sent");
      expect(mockState.manychatFetch).toHaveBeenCalledTimes(1);

      const [url, init] = mockState.manychatFetch.mock.calls[0] as [string, RequestInit];
      expect(url).toBe("https://api.manychat.com/fb/sending/sendContent");
      expect((init.headers as any).Authorization).toBe("Bearer 12:abc");
      const body = JSON.parse(String(init.body));
      expect(body.subscriber_id).toBe(111);
      expect(body.data.content.messages[0].text).toContain("cal.com/agent-miles");

      expect(getReplyLogById(db, id)?.draft_status).toBe("sent");
      const sent = listRecentSent(db, 5);
      expect(sent[0].status).toBe("sent");
      expect(sent[0].channel).toBe("manychat");
      expect(getLead(db, "mc-111")?.status).toBe("replied");
    });

    it("daily cap blocks once reached", async () => {
      makeDmLead(db);
      setSetting(db, "dmDryRun", "false");
      setSetting(db, "dmEnabled", "true");
      setSetting(db, "dmDailyCap", "1");
      logSentEmail(db, { lead_key: "mc-999", email: "dm:999", message_id: null, status: "sent", at: new Date().toISOString(), channel: "manychat" });
      const id = addPendingDmDraft(db);
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("DM daily cap reached");
      expect(mockState.manychatFetch).not.toHaveBeenCalled();
    });

    it("email drafts are rejected by the DM sender", async () => {
      makeDmLead(db);
      const id = logReply(db, {
        lead_key: "mc-111",
        reply_from: "Priya",
        reply_body: "hi",
        intent: "question",
        draft: "an email draft",
        draft_status: "pending",
        at: new Date().toISOString(),
        channel: "email",
      }) as number;
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("not a DM draft");
    });

    it("falls back to createSubscriber when the subscriber id is unknown", async () => {
      makeDmLead(db, { manychat_subscriber_id: null });
      // key mc-111 still derives 111; force failure of the first send
      mockState.manychatFetch = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "error", message: "subscriber not found" }), { status: 400 }),
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ status: "success", data: { id: "777" } }), { status: 200 }),
        )
        .mockResolvedValue(
          new Response(JSON.stringify({ status: "success" }), { status: 200 }),
        );
      vi.stubGlobal("fetch", mockState.manychatFetch);
      setSetting(db, "dmDryRun", "false");
      setSetting(db, "dmEnabled", "true");
      const id = addPendingDmDraft(db);
      const out = await sendDmReplyDraft(db, id, ENV);
      expect(out).toContain("sent");
      const urls = (mockState.manychatFetch.mock.calls as [string, RequestInit][]).map((c) => c[0]);
      expect(urls).toContain("https://api.manychat.com/fb/sending/sendContent");
      expect(urls).toContain("https://api.manychat.com/fb/subscriber/createSubscriber");
      expect(getLead(db, "mc-111")?.manychat_subscriber_id).toBe("777");
    });
  });

  describe("schema + defaults", () => {
    it("migration 4 adds channel columns with 'email' default", () => {
      const cols = (db.prepare("PRAGMA table_info(replies_log)").all() as any[]).map((c) => c.name);
      expect(cols).toContain("channel");
      const sentCols = (db.prepare("PRAGMA table_info(sent_log)").all() as any[]).map((c) => c.name);
      expect(sentCols).toContain("channel");
      const leadCols = (db.prepare("PRAGMA table_info(leads)").all() as any[]).map((c) => c.name);
      expect(leadCols).toContain("manychat_subscriber_id");

      const id = logReply(db, {
        lead_key: "uk/x",
        reply_from: "a@b.c",
        reply_body: "hi",
        draft: "d",
        draft_status: "pending",
        at: new Date().toISOString(),
      }) as number;
      expect(getReplyLogById(db, id)?.channel).toBe("email");
    });
  });

  describe("/send-reply routing", () => {
    it("routes DM drafts through the DM sender", async () => {
      makeDmLead(db);
      const id = addPendingDmDraft(db);
      const out = await handleCommand("/send-reply", [String(id)], db, ENV);
      expect(out).toContain("DRY-RUN");
      expect(out).toContain("subscriber 111");
      expect(mockState.manychatFetch).not.toHaveBeenCalled();
    });
  });
});
