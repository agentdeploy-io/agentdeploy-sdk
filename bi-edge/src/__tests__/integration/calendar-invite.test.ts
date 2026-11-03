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
    sendViaBrevo: vi.fn(async () => ({ messageId: "msg-ics-1" })),
  };
});

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead, insertBooking, setSetting } from "../../db/index.js";
import { buildIcs, sendCalendarInvite } from "../../agents/calendar-invite.js";
import { sendViaBrevo } from "../../agents/outreach.js";
import type { Lead } from "../../db/types.js";

const mockedBrevo = vi.mocked(sendViaBrevo);

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

const BOOKING = {
  id: 42,
  lead_key: "uk/invite-test",
  customer_email: "prospect@example.com",
  start_at: "2026-11-02T14:00:00.000Z",
  end_at: "2026-11-02T14:30:00.000Z",
  title: "Call: Invite Test Ltd",
  calendar_link: "https://calendar.google.com/calendar/render?action=TEMPLATE",
  status: "confirmed",
};

describe("buildIcs", () => {
  it("emits a valid METHOD:REQUEST calendar with UTC times", () => {
    const ics = buildIcs(
      BOOKING,
      "agent.miles@gradient3.io",
      "Agent Miles",
      ["prospect@example.com", "tom@gradient3.io"],
      "Meeting with Agent Miles about AI agents.",
    );
    expect(ics).toContain("BEGIN:VCALENDAR");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("DTSTART:20261102T140000Z");
    expect(ics).toContain("DTEND:20261102T143000Z");
    expect(ics).toContain("UID:booking-42-uk_invite-test@gradient3.io");
    expect(ics).toContain("ORGANIZER;CN=Agent Miles:mailto:agent.miles@gradient3.io");
    // Long lines are RFC-folded (CRLF + space) — unfold before asserting.
    const unfolded = ics.replace(/\r\n /g, "");
    expect(unfolded).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:prospect@example.com");
    expect(unfolded).toContain("ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:tom@gradient3.io");
    // CRLF line endings per RFC 5545
    expect(ics).toContain("\r\n");
    // every physical line within the 75-octet limit
    for (const line of ics.split("\r\n")) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
  });
});

describe("sendCalendarInvite", () => {
  let db: DatabaseType.Database;
  let bookingId: number;
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    db = createTestDb();
    const lead: Lead = {
      key: "uk/invite-test",
      country: "UK",
      name: "Invite Test Ltd",
      website: "https://invitetest.co.uk",
      emails: JSON.stringify([{ address: "prospect@example.com", kind: "role", mx_ok: true }]),
      stage: "replied",
      status: "replied",
      pitch_subject: "Missed calls",
      pitch_body: "Hi...",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-20T00:00:00Z",
    };
    upsertLead(db, lead);
    bookingId = insertBooking(db, BOOKING);
  });

  it("dry-run: no network, lists recipients (customer + operator)", async () => {
    // fresh DB: dryRun defaults true; set the operator address
    setSetting(db, "bookingInviteTo", "tom@gradient3.io");
    const result = await sendCalendarInvite(db, { BREVO_SENDER_EMAIL: "agent.miles@gradient3.io", BRAND_NAME: "Agent Miles" }, bookingId);
    expect(result).toContain("DRY-RUN invite");
    expect(result).toContain("prospect@example.com, tom@gradient3.io");
    expect(mockedBrevo).not.toHaveBeenCalled();
  });

  it("live: sends one email to both recipients with an .ics attachment", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    setSetting(db, "bookingInviteTo", "tom@gradient3.io");
    const result = await sendCalendarInvite(
      db,
      { BREVO_SENDER_EMAIL: "agent.miles@gradient3.io", BRAND_NAME: "Agent Miles" },
      bookingId,
    );
    expect(result).toContain("invite → prospect@example.com, tom@gradient3.io");
    expect(mockedBrevo).toHaveBeenCalledTimes(1);
    const [to, , subject, , , options] = mockedBrevo.mock.calls[0];
    expect(to).toEqual(["prospect@example.com", "tom@gradient3.io"]);
    expect(subject).toContain("Calendar invite");
    const ics = Buffer.from(options!.attachment!.contentBase64, "base64").toString("utf8");
    expect(ics).toContain("METHOD:REQUEST");
    expect(ics).toContain("DTSTART:20261102T140000Z");
    expect(options!.attachment!.filename).toBe(`meeting-${bookingId}.ics`);
  });

  it("no id: sends for all confirmed bookings", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    const result = await sendCalendarInvite(
      db,
      { BREVO_SENDER_EMAIL: "agent.miles@gradient3.io", BRAND_NAME: "Agent Miles" },
      null,
    );
    expect(result).toContain(`booking ${bookingId}: invite →`);
  });

  it("missing booking id is reported", async () => {
    setSetting(db, "dryRun", "false");
    setSetting(db, "sendEnabled", "true");
    const result = await sendCalendarInvite(db, {}, 999);
    expect(result).toBe("Booking 999 not found");
  });
});
