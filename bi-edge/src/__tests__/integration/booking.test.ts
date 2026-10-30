import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@agentdeploy-io/edge-sdk", () => ({
  createAgent: vi.fn(() => ({ id: "test-agent" })),
  createHandler: vi.fn(() => ({ fetch: async () => new Response("{}", { status: 200 }) })),
  gatewayFetchWithBackoff: vi.fn(),
  gatewayHeaders: vi.fn(() => ({})),
  parseLlmJson: vi.fn(),
}));

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead, logSentEmail, listBookingsByLead } from "../../db/index.js";
import { handleInboundWebhook } from "../../routes/inbound-webhook.js";
import { nextBookingSlots, googleCalendarLink } from "../../agents/booking.js";
import { gatewayFetchWithBackoff, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import type { Lead } from "../../db/types.js";

const mockedFetch = vi.mocked(gatewayFetchWithBackoff);

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeSentLead(d: DatabaseType.Database): Lead {
  const lead: Lead = {
    key: "uk/book-test",
    country: "UK",
    name: "Book Test Ltd",
    website: "https://booktest.co.uk",
    emails: JSON.stringify([{ address: "owner@booktest.co.uk", kind: "role", mx_ok: true }]),
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
    email: "owner@booktest.co.uk",
    subject: lead.pitch_subject ?? "",
    message_id: "msg-book-1",
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

function mockLlm(draftPayload: Record<string, unknown>) {
  vi.mocked(parseLlmJson).mockImplementation((x: any) => JSON.parse(x.choices[0].message.content));
  mockedFetch.mockImplementation(async (_url, init?: any) => {
    const body = JSON.parse(init!.body);
    const isClassify = body.messages[0].content.includes("You classify inbound email");
    const classify = {
      replies: [
        {
          leadKey: "uk/book-test",
          email: "owner@booktest.co.uk",
          intent: "interested",
          permanent: false,
          summary: "wants to book a call",
          replyFrom: "owner@booktest.co.uk",
          replySubject: "Re: Missed calls = missed jobs",
          replyBody: "the reply text",
        },
      ],
    };
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: JSON.stringify(isClassify ? classify : draftPayload) } }],
      }),
    } as any;
  });
}

async function postReply(
  db: DatabaseType.Database,
  text: string,
): Promise<Record<string, unknown>> {
  const payload = {
    items: [
      {
        MessageId: `bk-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        From: { Address: "owner@booktest.co.uk", Name: "" },
        Subject: "Re: Missed calls = missed jobs",
        RawTextBody: text,
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

describe("booking slots", () => {
  it("produces 4 weekday slots 3+ hours out, 30 minutes each", () => {
    const slots = nextBookingSlots(4);
    expect(slots).toHaveLength(4);
    const now = Date.now();
    for (const s of slots) {
      expect(s.start.getTime() - now).toBeGreaterThanOrEqual(3 * 3600 * 1000 - 5000);
      expect(s.end.getTime() - s.start.getTime()).toBe(30 * 60 * 1000);
      expect(s.label).toMatch(/\(UK\)/);
    }
    // labels are strictly increasing in time
    const times = slots.map((s) => s.start.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("slots land on the next weekdays, not a month away", () => {
    const slots = nextBookingSlots(4);
    const now = Date.now();
    const tenDays = now + 10 * 24 * 3600 * 1000;
    for (const s of slots) {
      expect(s.start.getTime()).toBeLessThanOrEqual(tenDays);
      // start time is 14:00 or 16:00 London wall clock
      const label = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/London", hour: "2-digit", minute: "2-digit", hour12: false,
      }).format(s.start);
      expect(label).toMatch(/^(14|16):00$/);
    }
  });

  it("googleCalendarLink encodes a TEMPLATE with basic UTC dates", () => {
    const start = new Date("2026-11-02T13:00:00Z");
    const end = new Date("2026-11-02T13:30:00Z");
    const link = googleCalendarLink("Call: Test Co", start, end, "notes");
    expect(link).toContain("calendar.google.com/calendar/render");
    expect(link).toContain("action=TEMPLATE");
    expect(link).toContain("dates=20261102T130000Z%2F20261102T133000Z");
    expect(link).toContain("text=Call%3A+Test+Co");
  });
});

describe("inbound webhook booking flow", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("records a booking and appends the calendar link when the lead picks a slot", async () => {
    const db = createTestDb();
    makeSentLead(db);
    mockLlm({
      replies: [
        {
          key: "uk/book-test",
          subject: "Re: Missed calls = missed jobs",
          body: "Great — confirmed for that slot. Talk soon.",
          slotIndex: 0,
        },
      ],
    });

    const out = await postReply(db, "Thursday 14:00 works for me, book it in.");
    expect(out.matched).toBe(1);
    expect(out.booked).toBe(1);

    const bookings = listBookingsByLead(db, "uk/book-test");
    expect(bookings).toHaveLength(1);
    expect(bookings[0].status).toBe("confirmed");
    expect(String(bookings[0].calendar_link)).toContain("calendar.google.com");

    const draftRow = db
      .prepare("SELECT draft, draft_status FROM replies_log WHERE lead_key='uk/book-test' ORDER BY id DESC LIMIT 1")
      .get() as { draft: string; draft_status: string };
    expect(draftRow.draft_status).toBe("pending");
    expect(draftRow.draft).toContain("calendar.google.com");
  });

  it("does not book when the lead only shows interest (no slotIndex)", async () => {
    const db = createTestDb();
    makeSentLead(db);
    mockLlm({
      replies: [
        {
          key: "uk/book-test",
          subject: "Re: Missed calls = missed jobs",
          body: "Interesting — which slot suits you best?",
        },
      ],
    });

    const out = await postReply(db, "Sounds useful, tell me more.");
    expect(out.matched).toBe(1);
    expect(out.booked ?? 0).toBe(0);
    expect(listBookingsByLead(db, "uk/book-test")).toHaveLength(0);
  });

  it("ignores out-of-range slotIndex", async () => {
    const db = createTestDb();
    makeSentLead(db);
    mockLlm({
      replies: [
        {
          key: "uk/book-test",
          subject: "Re: Missed calls = missed jobs",
          body: "ok",
          slotIndex: 99,
        },
      ],
    });

    const out = await postReply(db, "anytime works.");
    expect(out.booked ?? 0).toBe(0);
    expect(listBookingsByLead(db, "uk/book-test")).toHaveLength(0);
  });
});
