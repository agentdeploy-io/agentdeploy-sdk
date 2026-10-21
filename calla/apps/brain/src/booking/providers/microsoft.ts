/**
 * Microsoft 365 (Graph) calendar provider — global fetch, GRAPH_API_BASE
 * overridable for mocks. Availability uses POST /me/calendar/getSchedule,
 * bookings POST /me/calendar/events. Graph wall times ("2026-10-05T09:00:00
 * .0000000", no offset) are converted with scheduling.ts (Intl, Europe/Dublin).
 */
import { randomUUID } from "node:crypto";
import type { MicrosoftOAuthConfig } from "../oauth.js";
import { parseProviderTime, utcToWallTime } from "../scheduling.js";
import type {
  Appointment,
  Attendee,
  BookingContext,
  BusyRange,
  ConnectionRecord,
  Rep,
} from "../types.js";
import { apiFetchEmpty, apiFetchJson, appointmentDescription, appointmentTitle } from "./shared.js";

interface ScheduleItem {
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isPrivate?: boolean;
  status?: string;
  subject?: string;
}

interface GetScheduleResponse {
  value?: { scheduleId?: string; scheduleItems?: ScheduleItem[] }[];
}

/** Busy intervals for `email` (or the connected user when omitted). */
export async function msGetSchedule(
  cfg: MicrosoftOAuthConfig,
  conn: ConnectionRecord,
  email: string,
  fromIso: string,
  toIso: string,
  timezone: string,
  intervalMinutes = 45,
): Promise<BusyRange[]> {
  const json = await apiFetchJson<GetScheduleResponse>(
    `${cfg.graphBase}/me/calendar/getSchedule`,
    "graph getSchedule",
    {
      token: conn.accessToken,
      body: {
        schedules: [email],
        startTime: { dateTime: utcToWallTime(new Date(fromIso), timezone), timeZone: timezone },
        endTime: { dateTime: utcToWallTime(new Date(toIso), timezone), timeZone: timezone },
        availabilityViewInterval: Math.max(5, Math.trunc(intervalMinutes)),
      },
    },
  );
  const items = json.value?.[0]?.scheduleItems ?? [];
  const busy: BusyRange[] = [];
  for (const item of items) {
    const start = item.start?.dateTime
      ? parseProviderTime(item.start.dateTime, item.start.timeZone ?? timezone)
      : null;
    const end = item.end?.dateTime
      ? parseProviderTime(item.end.dateTime, item.end.timeZone ?? timezone)
      : null;
    if (start && end) busy.push({ start, end });
  }
  return busy;
}

export interface CreateEventInput {
  attendee: Attendee;
  context?: BookingContext;
  startIso: string;
  endIso: string;
  timezone: string;
  rep: Rep;
}

interface GraphEvent {
  id?: string;
  subject?: string;
  status?: string;
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  attendees?: { emailAddress?: { address?: string; name?: string } }[];
  createdDateTime?: string;
  webLink?: string;
}

function graphEventToAppointment(
  event: GraphEvent,
  repId: string,
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
  const first = event.attendees?.[0]?.emailAddress;
  return {
    id: event.id,
    provider: "microsoft",
    repId,
    attendee: {
      name: first?.name || first?.address || "unknown",
      ...(first?.address ? { email: first.address } : {}),
    },
    start,
    end,
    title: event.subject ?? "Survey",
    status: event.status === "cancelled" ? "cancelled" : "confirmed",
    createdAt: event.createdDateTime ?? new Date().toISOString(),
  };
}

/** Create the survey event on the connected user's calendar. */
export async function msCreateEvent(
  cfg: MicrosoftOAuthConfig,
  conn: ConnectionRecord,
  input: CreateEventInput,
): Promise<{ appointment: Appointment; webLink?: string }> {
  const body = {
    subject: appointmentTitle(input.attendee.name),
    body: {
      contentType: "Text",
      content: appointmentDescription({
        attendee: input.attendee,
        ...(input.context ? { context: input.context } : {}),
        rep: input.rep,
      }),
    },
    start: {
      dateTime: utcToWallTime(new Date(input.startIso), input.timezone),
      timeZone: input.timezone,
    },
    end: {
      dateTime: utcToWallTime(new Date(input.endIso), input.timezone),
      timeZone: input.timezone,
    },
    attendees: input.attendee.email
      ? [
          {
            emailAddress: {
              address: input.attendee.email,
              name: input.attendee.name,
            },
            type: "required",
          },
        ]
      : [],
    isOnlineMeeting: false,
    allowNewTimeProposals: false,
  };
  const event = await apiFetchJson<GraphEvent>(
    `${cfg.graphBase}/me/calendar/events`,
    "graph create event",
    { token: conn.accessToken, body },
  );
  const mapped = graphEventToAppointment(event, input.rep.id, input.timezone);
  // The submitted attendee/context are authoritative — Graph may normalize the
  // attendee name to the email, so keep what the caller sent.
  const appointment: Appointment = mapped
    ? { ...mapped, attendee: input.attendee, ...(input.context ? { context: input.context } : {}) }
    : {
        id: event.id ?? randomUUID(),
        provider: "microsoft",
        repId: input.rep.id,
        attendee: input.attendee,
        start: input.startIso,
        end: input.endIso,
        title: appointmentTitle(input.attendee.name),
        ...(input.context ? { context: input.context } : {}),
        status: "confirmed",
        createdAt: new Date().toISOString(),
      };
  return { appointment, ...(event.webLink ? { webLink: event.webLink } : {}) };
}

/** Cancel (delete) an event. */
export async function msCancelEvent(
  cfg: MicrosoftOAuthConfig,
  conn: ConnectionRecord,
  eventId: string,
): Promise<void> {
  await apiFetchEmpty(
    `${cfg.graphBase}/me/events/${encodeURIComponent(eventId)}`,
    "graph cancel event",
    { method: "DELETE", token: conn.accessToken },
  );
}

interface GraphEventsList {
  value?: GraphEvent[];
}

/** Upcoming events in [from, to] via calendarView (UTC window). */
export async function msListUpcoming(
  cfg: MicrosoftOAuthConfig,
  conn: ConnectionRecord,
  repId: string,
  fromIso: string,
  toIso: string,
  timezone: string,
): Promise<Appointment[]> {
  const params = new URLSearchParams({
    startdatetime: fromIso,
    enddatetime: toIso,
    $orderby: "start/dateTime",
    $select: "id,subject,status,start,end,attendees,createdDateTime",
  });
  const json = await apiFetchJson<GraphEventsList>(
    `${cfg.graphBase}/me/calendarView?${params.toString()}`,
    "graph calendarView",
    { token: conn.accessToken },
  );
  return (json.value ?? [])
    .map((e) => graphEventToAppointment(e, repId, timezone))
    .filter((a): a is Appointment => a !== null);
}

/**
 * Create a Graph change-notification subscription on /me/events so bookings
 * made OUTSIDE Calla stay visible.
 *
 * EXPIRY: Graph caps calendar subscriptions at 3 days (4320 minutes) — this
 * helper requests ~71.5h (4290 min) for margin.
 * TODO(renewal): schedule a PATCH /subscriptions/{id} (extend
 * expirationDateTime) before expiry, e.g. a daily cron/Mastra workflow; an
 * expired subscription silently stops notifications.
 *
 * HANDSHAKE: Graph immediately POSTs { validationToken } to notificationUrl —
 * POST /booking/webhook/microsoft echoes it back as text/plain (must respond
 * < 10s). Later notifications carry clientState; the webhook compares it to
 * MICROSOFT_CLIENT_STATE (default BOOKING_WEBHOOK_SECRET) and 401s mismatches.
 */
export async function msCreateSubscription(
  cfg: MicrosoftOAuthConfig,
  conn: ConnectionRecord,
  notificationUrl: string,
  clientState?: string,
  ttlMinutes = 4290,
): Promise<{ subscriptionId?: string; expirationDateTime?: string }> {
  const expiration = new Date(Date.now() + Math.min(4320, ttlMinutes) * 60_000)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z");
  const state = clientState ?? cfg.clientState ?? randomUUID();
  const json = await apiFetchJson<{ id?: string; expirationDateTime?: string }>(
    `${cfg.graphBase}/subscriptions`,
    "graph create subscription",
    {
      token: conn.accessToken,
      body: {
        changeType: "created,updated,deleted",
        notificationUrl,
        resource: "me/events",
        expirationDateTime: expiration,
        clientState: state,
      },
    },
  );
  return {
    ...(json.id ? { subscriptionId: json.id } : {}),
    ...(json.expirationDateTime ? { expirationDateTime: json.expirationDateTime } : {}),
  };
}
