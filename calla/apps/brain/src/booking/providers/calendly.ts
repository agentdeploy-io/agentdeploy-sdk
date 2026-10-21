/**
 * Calendly provider — NO OAuth required for the core flow.
 *
 * Outbound: the rep's public scheduling link IS the availability surface
 * (Calendly owns slot math). Inbound: signed webhooks (invitee.created /
 * invitee.canceled) are verified with X-Signature = hex HMAC-SHA256 of the
 * RAW request body under CALENDLY_WEBHOOK_SECRET (constant-time compare) and
 * normalized into Appointments; reps are matched by their stored
 * eventTypeUri (or scheduling link). CALENDLY_ACCESS_TOKEN is optional and
 * only used for API lookups/cancels (e.g. DELETE scheduled_events/invitees).
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CalendlyConfig } from "../oauth.js";
import type { Appointment, Attendee, Rep } from "../types.js";
import { apiFetchEmpty } from "./shared.js";

/**
 * Verify Calendly's X-Signature header: hex HMAC-SHA256 over the raw body
 * with the webhook secret. Constant-time; false on any shape mismatch.
 */
export function verifyCalendlySignature(
  rawBody: string,
  signatureHeader: string | undefined,
  secret: string,
): boolean {
  const sig = signatureHeader?.trim().toLowerCase();
  if (!sig || !secret || typeof rawBody !== "string") return false;
  const expected = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(sig, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ─── Webhook parsing ─────────────────────────────────────────────

interface CalendlyInviteePayload {
  event_type?: string;
  invitee?: {
    uri?: string;
    name?: string;
    email?: string;
    text_reminder_number?: string;
    status?: string;
  };
  invitee_scheduled_event?: {
    uri?: string;
    start_time?: string;
    end_time?: string;
    location?: unknown;
    event_type?: string;
  };
}

export interface ParsedCalendlyEvent {
  kind: "invitee.created" | "invitee.canceled";
  /** Invitee id — last path segment of the invitee URI (URL-safe). */
  id: string;
  /** Full invitee URI (cancel via API + dedupe). */
  inviteeUri: string;
  eventTypeUri: string;
  attendee: Attendee;
  start: string | null;
  end: string | null;
  scheduledEventUri: string | null;
}

function lastSegment(uri: string): string {
  const parts = String(uri ?? "").split("/").filter(Boolean);
  return parts[parts.length - 1] ?? "";
}

/**
 * Normalize an invitee.created / invitee.canceled webhook body.
 * Returns null for other/unknown event types (ignored with 200).
 */
export function parseCalendlyWebhook(body: unknown): ParsedCalendlyEvent | null {
  const raw = (body ?? {}) as { event?: string; payload?: CalendlyInviteePayload };
  const kind =
    raw.event === "invitee.created" || raw.event === "invitee.canceled"
      ? raw.event
      : null;
  if (!kind) return null;
  const p = raw.payload ?? {};
  const inviteeUri = p.invitee?.uri ?? "";
  if (!inviteeUri) return null;
  const attendee: Attendee = {
    name: p.invitee?.name?.trim() || "Calendly invitee",
    ...(p.invitee?.email ? { email: p.invitee.email } : {}),
    ...(p.invitee?.text_reminder_number ? { phone: p.invitee.text_reminder_number } : {}),
  };
  return {
    kind,
    id: lastSegment(inviteeUri),
    inviteeUri,
    eventTypeUri:
      p.event_type ?? p.invitee_scheduled_event?.event_type ?? "",
    attendee,
    start: p.invitee_scheduled_event?.start_time ?? null,
    end: p.invitee_scheduled_event?.end_time ?? null,
    scheduledEventUri: p.invitee_scheduled_event?.uri ?? null,
  };
}

/**
 * Match a rep to a webhook's event type: exact eventTypeUri, else the
 * scheduling link embedded in the event-type/scheduling URLs.
 */
export function matchRepForEventType(
  reps: Rep[],
  eventTypeUri: string,
  schedulingUrl?: string,
): Rep | null {
  const byEventType = reps.find((r) => r.eventTypeUri && r.eventTypeUri === eventTypeUri);
  if (byEventType) return byEventType;
  if (schedulingUrl) {
    const byLink = reps.find((r) => r.schedulingLink && r.schedulingLink === schedulingUrl);
    if (byLink) return byLink;
  }
  return null;
}

/** Build the normalized Appointment for a parsed webhook event. */
export function calendlyAppointment(
  parsed: ParsedCalendlyEvent,
  repId: string,
): Appointment {
  const now = new Date().toISOString();
  return {
    id: parsed.id,
    provider: "calendly",
    repId,
    attendee: parsed.attendee,
    start: parsed.start ?? now,
    end: parsed.end ?? parsed.start ?? now,
    title: `Survey — ${parsed.attendee.name}`,
    ...(parsed.scheduledEventUri
      ? { context: { notes: `Calendly event: ${parsed.scheduledEventUri}` } }
      : {}),
    status: parsed.kind === "invitee.canceled" ? "cancelled" : "confirmed",
    createdAt: now,
  };
}

// ─── Optional API (CALENDLY_ACCESS_TOKEN) ────────────────────────

/**
 * Cancel an invitee via the Calendly API (requires CALENDLY_ACCESS_TOKEN).
 * `inviteeUriOrPath` accepts the full https://api.calendly.com/... URI or a
 * relative path. Throws when no token is configured (callers fall back to
 * marking the local record cancelled).
 */
export async function calendlyCancelInvitee(
  cfg: CalendlyConfig,
  inviteeUriOrPath: string,
): Promise<void> {
  if (!cfg.accessToken) {
    throw new Error("CALENDLY_ACCESS_TOKEN not configured — cannot cancel via Calendly API");
  }
  const path = inviteeUriOrPath.startsWith("http")
    ? new URL(inviteeUriOrPath).pathname
    : inviteeUriOrPath;
  await apiFetchEmpty(`${cfg.apiBase}${path}/cancel`, "calendly cancel invitee", {
    method: "POST",
    token: cfg.accessToken,
  });
}
