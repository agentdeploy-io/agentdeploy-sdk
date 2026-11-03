/**
 * Calendar invites — real .ics delivery for confirmed bookings.
 *
 * A booking confirmation email alone is not a calendar invite: the prospect
 * has to click a template link and re-enter details. Here we generate a
 * standards-compliant ICS (METHOD:REQUEST) and deliver it as an email
 * attachment via the existing Brevo sender to BOTH the customer and the
 * operator (settings `bookingInviteTo`), so the event lands in both
 * calendars with one tap in any mail client.
 */

import type Database from "better-sqlite3";
import { getBookingById, listBookings } from "../db/bookings.js";
import { getLead } from "../db/leads.js";
import { getSetting, isDryRun, isSendEnabled } from "../db/settings.js";
import { sendViaBrevo } from "./outreach.js";

export interface BookingLike {
  id: number;
  lead_key: string;
  customer_email: string;
  start_at: string;
  end_at: string;
  title: string;
  calendar_link?: string | null;
  status?: string | null;
}

function icsStamp(iso: string): string {
  // 2026-11-02T14:00:00.000Z → 20261102T140000Z (UTC, per RFC 5545 UTC form)
  return iso.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

function foldLine(line: string): string[] {
  // RFC 5545: content lines SHOULD NOT exceed 75 octets; fold with CRLF+space.
  const out: string[] = [];
  let current = line;
  while (Buffer.byteLength(current, "utf8") > 73) {
    let cut = 73;
    while (cut > 0 && (Buffer.byteLength(current.slice(0, cut), "utf8") > 73)) cut--;
    out.push(current.slice(0, cut));
    current = " " + current.slice(cut);
  }
  out.push(current);
  return out;
}

export function buildIcs(
  booking: BookingLike,
  organizerEmail: string,
  organizerName: string,
  attendees: string[],
  description: string,
): string {
  const uid = `booking-${booking.id}-${booking.lead_key.replace(/[^a-zA-Z0-9_-]/g, "_")}@gradient3.io`;
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "METHOD:REQUEST",
    "PRODID:-//Agent Miles//Calla Booking//EN",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uid}`,
    `DTSTAMP:${icsStamp(new Date().toISOString())}`,
    `DTSTART:${icsStamp(booking.start_at)}`,
    `DTEND:${icsStamp(booking.end_at)}`,
    `SUMMARY:${booking.title}`,
    `DESCRIPTION:${description}`,
    "LOCATION:Video call (link in the email thread)",
    `ORGANIZER;CN=${organizerName}:mailto:${organizerEmail}`,
  ];
  for (const email of attendees) {
    lines.push(`ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`);
  }
  lines.push(
    "STATUS:CONFIRMED",
    "SEQUENCE:0",
    "TRANSP:OPAQUE",
    "END:VEVENT",
    "END:VCALENDAR",
  );

  const folded: string[] = [];
  for (const line of lines) {
    for (const part of foldLine(line)) folded.push(part);
  }
  return folded.join("\r\n") + "\r\n";
}

/**
 * Deliver the .ics invite for one booking (or all confirmed bookings when
 * id is null). Recipients: the customer + the operator address from the
 * `bookingInviteTo` setting. Honours dryRun. Returns a human-readable result.
 */
export async function sendCalendarInvite(
  db: Database.Database,
  env: Record<string, unknown>,
  bookingId: number | null,
): Promise<string> {
  const bookings: BookingLike[] =
    bookingId !== null
      ? [getBookingById(db, bookingId) as BookingLike | undefined].filter(Boolean) as BookingLike[]
      : (listBookings(db, 50).filter((b) => b.status === "confirmed") as unknown as BookingLike[]);

  if (bookings.length === 0) {
    return bookingId !== null
      ? `Booking ${bookingId} not found`
      : "No confirmed bookings to send invites for";
  }

  const dryRun = isDryRun(db);
  if (!dryRun && !isSendEnabled(db)) {
    return "sendEnabled is false — set it true in Settings first";
  }

  const operator = getSetting(db, "bookingInviteTo") ?? "";
  const organizerEmail = String(env.BREVO_SENDER_EMAIL ?? "");
  const organizerName = String(env.BRAND_NAME ?? "Agent Miles");

  const results: string[] = [];
  for (const booking of bookings) {
    const lead = getLead(db, booking.lead_key);
    const attendees = [booking.customer_email, operator].filter(
      (a, i, arr) => a && a !== organizerEmail && arr.indexOf(a) === i,
    );
    if (attendees.length === 0) {
      results.push(`booking ${booking.id}: no recipient addresses`);
      continue;
    }

    const when = new Date(booking.start_at);
    const whenLabel = when.toLocaleString("en-GB", {
      timeZone: "Europe/London",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
    const description =
      `Meeting with ${organizerName} about AI agents — booked from your email confirmation.\n` +
      `Time: ${whenLabel} (UK)\n` +
      (lead ? `Company: ${lead.name}\n` : "") +
      (booking.calendar_link ? `Backup booking link: ${booking.calendar_link}` : "");

    const ics = buildIcs(booking, organizerEmail, organizerName, attendees, description);
    const filename = `meeting-${booking.id}.ics`;
    const subject = `Calendar invite: ${booking.title} — ${whenLabel} (UK)`;
    const html =
      `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.65">` +
      `<p>Your meeting is booked. Open the attached <strong>${filename}</strong> and accept the invite — ` +
      `it adds the event to your calendar.</p>` +
      `<p><strong>${booking.title}</strong><br>${whenLabel} (UK)</p>` +
      (booking.calendar_link
        ? `<p>Prefer to add it manually: <a href="${booking.calendar_link}">open in Google Calendar</a>.</p>`
        : "") +
      `</div>`;

    if (dryRun) {
      results.push(`booking ${booking.id}: DRY-RUN invite → ${attendees.join(", ")}`);
      continue;
    }

    try {
      const { messageId } = await sendViaBrevo(
        attendees,
        lead?.name ?? booking.customer_email.split("@")[0],
        subject,
        html,
        env,
        { attachment: { filename, contentBase64: Buffer.from(ics, "utf8").toString("base64") } },
      );
      results.push(`booking ${booking.id}: invite → ${attendees.join(", ")} (${messageId || "ok"})`);
    } catch (e) {
      results.push(`booking ${booking.id}: FAILED — ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return results.join("; ");
}
