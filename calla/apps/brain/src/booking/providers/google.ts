/**
 * Google Calendar provider (Calendar v3 REST, global fetch).
 *
 * Base URLs come from readBookingConfig() so GOOGLE_API_BASE can point at a
 * local mock. All times on the wire are RFC3339; availability uses POST
 * freeBusy, event creation stamps Europe/Dublin (rep timezone) on start/end.
 */
import { randomUUID } from "node:crypto";
import type { GoogleOAuthConfig } from "../oauth.js";
import { parseProviderTime } from "../scheduling.js";
import { BookingApiError } from "../types.js";
import type {
  Appointment,
  Attendee,
  BookingContext,
  BusyRange,
  ConnectionRecord,
  Rep,
} from "../types.js";
import { apiFetchEmpty, apiFetchJson, appointmentDescription, appointmentTitle } from "./shared.js";

interface FreeBusyResponse {
  calendars?: Record<string, { busy?: { start?: string; end?: string }[] }>;
}

/** Busy intervals on the connected account's primary calendar. */
export async function googleBusy(
  cfg: GoogleOAuthConfig,
  conn: ConnectionRecord,
  fromIso: string,
  toIso: string,
): Promise<BusyRange[]> {
  const json = await apiFetchJson<FreeBusyResponse>(
    `${cfg.apiBase}/calendar/v3/freeBusy`,
    "google freeBusy",
    {
      token: conn.accessToken,
      body: {
        timeMin: fromIso,
        timeMax: toIso,
        timeZone: "UTC",
        items: [{ id: "primary" }],
      },
    },
  );
  const busy = json.calendars?.primary?.busy ?? [];
  return busy
    .map((b) => ({ start: b.start ?? "", end: b.end ?? "" }))
    .filter((b) => b.start && b.end);
}

export interface CreateEventInput {
  attendee: Attendee;
  context?: BookingContext;
  startIso: string;
  endIso: string;
  timezone: string;
  rep: Rep;
}

interface GoogleEvent {
  id?: string;
  htmlLink?: string;
  /** Meet join URL — present when the event carries a Google Meet conference. */
  hangoutLink?: string;
  summary?: string;
  status?: string;
  start?: { dateTime?: string; date?: string; timeZone?: string };
  end?: { dateTime?: string; date?: string; timeZone?: string };
  attendees?: { email?: string; displayName?: string }[];
  description?: string;
  created?: string;
}

function googleEventToAppointment(
  event: GoogleEvent,
  providerRepId: string,
  timezone: string,
): Appointment | null {
  if (!event.id) return null;
  const start = event.start?.dateTime
    ? parseProviderTime(event.start.dateTime, event.start.timeZone ?? timezone)
    : null;
  const end = event.end?.dateTime
    ? parseProviderTime(event.end.dateTime, event.end.timeZone ?? timezone)
    : null;
  if (!start || !end) return null;
  const first = event.attendees?.[0];
  return {
    id: event.id,
    provider: "google",
    repId: providerRepId,
    attendee: {
      name: first?.displayName || first?.email || "unknown",
      ...(first?.email ? { email: first.email } : {}),
    },
    start,
    end,
    title: event.summary ?? "Survey",
    status: event.status === "cancelled" ? "cancelled" : "confirmed",
    createdAt: event.created ?? new Date().toISOString(),
    ...(event.hangoutLink ? { meetingUrl: event.hangoutLink } : {}),
  };
}

/**
 * Create the survey event on the primary calendar.
 * start/end carry the rep's IANA timezone (Europe/Dublin default) so Google
 * renders local wall time regardless of the UTC wire value.
 *
 * A Google Meet conference is created inline (conferenceData + CHIME): Google
 * provisions the hangout and stamps `hangoutLink` on the returned event. Some
 * accounts (personal / some Workspace tiers) cannot provision Meet — in that
 * case Google returns a 400/403 mentioning "conference", so we retry the same
 * event WITHOUT conference data and simply omit the meeting link.
 */
export async function googleCreateEvent(
  cfg: GoogleOAuthConfig,
  conn: ConnectionRecord,
  input: CreateEventInput,
): Promise<{ appointment: Appointment; htmlLink?: string; meetingUrl?: string }> {
  const description = appointmentDescription({
    attendee: input.attendee,
    ...(input.context ? { context: input.context } : {}),
    rep: input.rep,
  });
  const base = {
    summary: appointmentTitle(input.attendee.name),
    description,
    start: { dateTime: input.startIso, timeZone: input.timezone },
    end: { dateTime: input.endIso, timeZone: input.timezone },
    attendees: input.attendee.email ? [{ email: input.attendee.email }] : [],
  };
  const url = `${cfg.apiBase}/calendar/v3/calendars/primary/events?sendUpdates=all`;
  let event: GoogleEvent;
  try {
    event = await apiFetchJson<GoogleEvent>(url, "google create event", {
      token: conn.accessToken,
      body: {
        ...base,
        conferenceDataVersion: 1,
        conferenceData: { createRequest: { requestType: "CHIME" } },
      },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const conferenceRefused =
      err instanceof BookingApiError &&
      (err.status === 400 || err.status === 403) &&
      /conference|meet|hangout/i.test(`${msg} ${err.detail ?? ""}`);
    if (!conferenceRefused) throw err;
    console.warn("[booking] Meet conference refused by provider — creating event without one:", msg);
    event = await apiFetchJson<GoogleEvent>(url, "google create event", { token: conn.accessToken, body: base });
  }
  const mapped = googleEventToAppointment(event, input.rep.id, input.timezone);
  // The submitted attendee/context are authoritative — providers may normalize
  // displayName to the email, so keep what the caller sent.
  const appointment: Appointment = mapped
    ? { ...mapped, attendee: input.attendee, ...(input.context ? { context: input.context } : {}) }
    : {
        id: event.id ?? randomUUID(),
        provider: "google",
        repId: input.rep.id,
        attendee: input.attendee,
        start: input.startIso,
        end: input.endIso,
        title: appointmentTitle(input.attendee.name),
        ...(input.context ? { context: input.context } : {}),
        status: "confirmed",
        createdAt: new Date().toISOString(),
        ...(event.hangoutLink ? { meetingUrl: event.hangoutLink } : {}),
      };
  return {
    appointment,
    ...(event.htmlLink ? { htmlLink: event.htmlLink } : {}),
    ...(event.hangoutLink ? { meetingUrl: event.hangoutLink } : {}),
  };
}

/** Cancel (delete) an event; guests are notified via sendUpdates=all. */
export async function googleCancelEvent(
  cfg: GoogleOAuthConfig,
  conn: ConnectionRecord,
  eventId: string,
): Promise<void> {
  await apiFetchEmpty(
    `${cfg.apiBase}/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}?sendUpdates=all`,
    "google cancel event",
    { method: "DELETE", token: conn.accessToken },
  );
}

interface GoogleEventsList {
  items?: GoogleEvent[];
}

/** Upcoming events in [from, to] (singleEvents, start-time ordered). */
export async function googleListUpcoming(
  cfg: GoogleOAuthConfig,
  conn: ConnectionRecord,
  repId: string,
  fromIso: string,
  toIso: string,
  timezone: string,
): Promise<Appointment[]> {
  const params = new URLSearchParams({
    timeMin: fromIso,
    timeMax: toIso,
    singleEvents: "true",
    orderBy: "startTime",
  });
  const json = await apiFetchJson<GoogleEventsList>(
    `${cfg.apiBase}/calendar/v3/calendars/primary/events?${params.toString()}`,
    "google list events",
    { token: conn.accessToken },
  );
  return (json.items ?? [])
    .map((e) => googleEventToAppointment(e, repId, timezone))
    .filter((a): a is Appointment => a !== null);
}

/**
 * Register a push-notification channel on the primary calendar's events
 * collection (POST events/watch → Google calls `address` on every change).
 *
 * SYNC VERIFICATION: immediately after registration Google sends a
 * "sync" notification (POST with X-Goog-Resource-State: sync and an empty
 * body) to confirm the channel — POST /booking/webhook/google answers 200
 * to it (and GET /booking/webhook/google returns 200 for plain reachability
 * checks). Set X-Goog-Channel-Token to BOOKING_WEBHOOK_SECRET so the webhook
 * can prove the call is really from this registration. Max ttl ≈ 7 days
 * (604800s); re-register before expiry (channel id is returned as `id`).
 */
export async function googleRegisterWatch(
  cfg: GoogleOAuthConfig,
  conn: ConnectionRecord,
  address: string,
  token?: string,
  ttlSeconds = 604_800,
): Promise<{ channelId: string; resourceId?: string; expiration?: string }> {
  const channelId = randomUUID();
  const json = await apiFetchJson<{ id?: string; resourceId?: string; expiration?: string }>(
    `${cfg.apiBase}/calendar/v3/calendars/primary/events/watch`,
    "google events watch",
    {
      token: conn.accessToken,
      body: {
        id: channelId,
        type: "web_hook",
        address,
        ...(token ? { token } : {}),
        params: { ttl: String(ttlSeconds) },
      },
    },
  );
  return {
    channelId: json.id ?? channelId,
    ...(json.resourceId ? { resourceId: json.resourceId } : {}),
    ...(json.expiration ? { expiration: json.expiration } : {}),
  };
}
