import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// inbound-manchat → dm-reply → edge-sdk (cloudflare: scheme) — stub out the
// LLM gateway; the webhook tests only assert on lead creation, not replies.
vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
  gatewayFetchWithBackoff: vi.fn(),
  gatewayHeaders: vi.fn(() => ({})),
  parseLlmJson: vi.fn(),
}));

import Database from "better-sqlite3";
import { runMigrations } from "../db/migrations.js";
import { getLead } from "../db/leads.js";
import { normalizeManyChatEvent, handleManychatWebhook } from "../routes/inbound-manchat.js";
import { manychatPageInfo, manychatSendText } from "../manychat/client.js";

function createDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function post(payload: unknown): Request {
  return new Request("http://localhost/inbound/manychat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

describe("normalizeManyChatEvent", () => {
  it("parses the canonical new_message shape", () => {
    const n = normalizeManyChatEvent({
      type: "new_message",
      timestamp: 1761292800,
      data: {
        user_id: 998877,
        message: "hello",
        profile: { first_name: "Priya", profile_url: "https://instagram.com/priya" },
      },
    });
    expect(n).not.toBeNull();
    expect(n!.userId).toBe("998877");
    expect(n!.name).toBe("Priya");
    expect(n!.profileUrl).toBe("https://instagram.com/priya");
    expect(n!.text).toBe("hello");
    expect(n!.eventType).toBe("new_message");
    expect(n!.at).toBe("2025-10-24T08:00:00.000Z");
  });

  it("tolerates psid/comment/text variants", () => {
    const n = normalizeManyChatEvent({
      type: "new_comment",
      data: { psid: "123abc", comment: "great post", profile_url: "https://instagram.com/x" },
    });
    expect(n).not.toBeNull();
    expect(n!.userId).toBe("123abc");
    expect(n!.text).toBe("great post");
    expect(n!.profileUrl).toBe("https://instagram.com/x");
    expect(n!.name).toBe("Manychat contact 123abc");
  });

  it("returns null when no contact id is present", () => {
    expect(normalizeManyChatEvent({ type: "broadcast_message_sent", data: { page_id: 5 } })).toBeNull();
    expect(normalizeManyChatEvent({ type: "unknown" })).toBeNull();
  });

  it("defaults region to ig", () => {
    const n = normalizeManyChatEvent({ type: "follow", data: { user_id: 1 } });
    expect(n!.region).toBe("ig");
  });
});

describe("handleManychatWebhook", () => {
  let db: Database.Database;
  beforeEach(() => {
    db = createDb();
  });
  afterEach(() => db.close());

  it("rejects a wrong webhook token when one is configured", async () => {
    const env = { MANYCHAT_WEBHOOK_TOKEN: "s3cret" };
    const res = await handleManychatWebhook(post({ type: "new_message", token: "nope", data: { user_id: 1 } }), env, db as any);
    expect(res.status).toBe(401);
    expect(getLead(db, "mc-1")).toBeUndefined();
  });

  it("accepts a matching token", async () => {
    const env = { MANYCHAT_WEBHOOK_TOKEN: "s3cret" };
    const res = await handleManychatWebhook(post({ type: "new_message", token: "s3cret", data: { user_id: 7, message: "hi" } }), env, db as any);
    expect(res.status).toBe(200);
    expect(getLead(db, "mc-7")).toBeDefined();
  });

  it("creates a lead from an inbound DM", async () => {
    const res = await handleManychatWebhook(
      post({
        type: "new_message",
        data: { user_id: 42, message: "are you hiring?", profile: { first_name: "Sam", profile_url: "https://instagram.com/sam" } },
      }),
      {},
      db as any,
    );
    expect(res.status).toBe(200);
    const j = (await res.json()) as any;
    expect(j.lead).toBe(true);
    expect(j.created).toBe(true);

    const lead = getLead(db, "mc-42")!;
    expect(lead.name).toBe("Sam");
    expect(lead.source).toBe("manychat");
    expect(lead.website).toBe("https://instagram.com/sam");
    expect(lead.stage).toBe("raw");
    expect(lead.status).toBe("pending_review");
    expect(lead.research).toContain("are you hiring?");
    const socials = JSON.parse(lead.socials!) as Array<{ platform: string; url: string }>;
    expect(socials[0]).toEqual({ platform: "instagram", url: "https://instagram.com/sam" });
  });

  it("appends repeat events to the same lead instead of duplicating", async () => {
    const env = {};
    await handleManychatWebhook(post({ type: "new_message", data: { user_id: 42, message: "first" } }), env, db as any);
    const res = await handleManychatWebhook(post({ type: "new_comment", data: { user_id: 42, comment: "second" } }), env, db as any);
    const j = (await res.json()) as any;
    expect(j.updated).toBe(true);
    const lead = getLead(db, "mc-42")!;
    expect(lead.research).toContain("first");
    expect(lead.research).toContain("second");
    const count = (db.prepare("SELECT COUNT(*) n FROM leads WHERE key = 'mc-42'").get() as any).n;
    expect(count).toBe(1);
  });

  it("skips non-lead event types", async () => {
    const res = await handleManychatWebhook(post({ type: "broadcast_message_sent", data: { user_id: 42 } }), {}, db as any);
    const j = (await res.json()) as any;
    expect(j.lead).toBe(false);
    expect(getLead(db, "mc-42")).toBeUndefined();
  });

  it("handles GET with 405 and bad JSON with 400", async () => {
    const get = new Request("http://localhost/inbound/manychat", { method: "GET" });
    expect((await handleManychatWebhook(get, {}, db as any)).status).toBe(405);
    const bad = new Request("http://localhost/inbound/manychat", { method: "POST", body: "{nope" });
    expect((await handleManychatWebhook(bad, {}, db as any)).status).toBe(400);
  });
});

describe("manychat client", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("getInfo sends Bearer auth and unwraps data", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ status: "success", data: { id: 1, name: "Page", category: "Biz", avatar_link: "", username: "p", about: "", description: "", is_pro: false, timezone: "UTC" } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const page = await manychatPageInfo({ MANYCHAT_API_KEY: "12:abc" });
    expect(page.name).toBe("Page");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.manychat.com/fb/page/getInfo");
    expect((init.headers as any).Authorization).toBe("Bearer 12:abc");
  });

  it("maps 401 to a ManyChatError with the API message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ status: "error", message: "Wrong token" }), { status: 401 })),
    );
    const p = manychatPageInfo({ MANYCHAT_API_KEY: "12:abc" });
    await expect(p).rejects.toMatchObject({
      name: "ManyChatError",
      status: 401,
      apiMessage: "Wrong token",
    });
  });

  it("throws a clear error when no key is configured", async () => {
    const p = manychatPageInfo({});
    await expect(p).rejects.toThrow(/MANYCHAT_API_KEY/);
  });

  it("sendText builds a dynamic-block v2 payload with subscriber_id", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ status: "success" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await manychatSendText(77, "Hello!", { MANYCHAT_API_KEY: "12:abc" });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.manychat.com/fb/sending/sendContent");
    const body = JSON.parse(init.body);
    expect(body.subscriber_id).toBe(77);
    expect(body.data.version).toBe("v2");
    expect(body.data.content.messages).toEqual([{ type: "text", text: "Hello!" }]);
  });
});
