/**
 * Small helpers shared by the calendar providers (fetch wrapper with typed
 * errors + the survey appointment title/description contract).
 */
import {
  BookingApiError,
  type Attendee,
  type BookingContext,
  type Rep,
} from "../types.js";

/** Appointment title contract: "Survey — {attendee.name}". */
export function appointmentTitle(attendeeName: string): string {
  return `Survey — ${attendeeName}`;
}

/** ISO-8601 UTC → Google Calendar "dates" segment (20261105T153000Z). */
function gcalDateStamp(iso: string): string {
  return new Date(Date.parse(iso))
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}Z$/, "Z");
}

/**
 * Deterministic "Add to Google Calendar" deep link (no API needed): opens a
 * pre-filled event dialog in the ATTENDEE's own Google account. Used for the
 * confirmation email so the one-click add carries the meeting link too.
 */
export function googleCalendarTemplateUrl(input: {
  title: string;
  startIso: string;
  endIso: string;
  timezone?: string;
  location?: string;
  details?: string;
}): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: input.title,
    dates: `${gcalDateStamp(input.startIso)}/${gcalDateStamp(input.endIso)}`,
    ...(input.timezone ? { ctz: input.timezone } : {}),
    ...(input.details ? { details: input.details } : {}),
    ...(input.location ? { location: input.location } : {}),
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/** Event description carrying the (minimized) booking context. */
export function appointmentDescription(input: {
  attendee: Attendee;
  context?: BookingContext;
  rep?: Pick<Rep, "name" | "email">;
}): string {
  const lines: string[] = ["Calla property survey appointment."];
  const { attendee, context, rep } = input;
  if (attendee.name) lines.push(`Attendee: ${attendee.name}`);
  if (attendee.email) lines.push(`Email: ${attendee.email}`);
  if (attendee.phone) lines.push(`Phone: ${attendee.phone}`);
  if (context?.leadKey) lines.push(`Lead: ${context.leadKey}`);
  if (context?.propertyAddress) lines.push(`Property: ${context.propertyAddress}`);
  if (context?.notes) lines.push(`Notes: ${context.notes}`);
  if (rep) lines.push(`Surveyor: ${rep.name}${rep.email ? ` (${rep.email})` : ""}`);
  lines.push("Booked via Calla.");
  return lines.join("\n");
}

export interface ApiFetchOptions {
  method?: string;
  /** Bearer token (Authorization header). */
  token?: string;
  /** JSON body (serialized). */
  body?: unknown;
  /** Extra headers. */
  headers?: Record<string, string>;
}

/**
 * fetch + JSON with provider-friendly errors: non-2xx throws BookingApiError
 * carrying the upstream status (routes map 401/404/409 through) and a short,
 * secret-free detail snippet.
 */
export async function apiFetchJson<T = unknown>(
  url: string,
  label: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/json",
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? (options.body !== undefined ? "POST" : "GET"),
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    throw new BookingApiError(
      `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const text = await res.text().catch(() => "");
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const detail = text.slice(0, 300);
    throw new BookingApiError(`${label} failed (HTTP ${res.status})`, res.status, detail);
  }
  return (json ?? {}) as T;
}

/** fetch for endpoints that return 204/no body (event deletes). */
export async function apiFetchEmpty(
  url: string,
  label: string,
  options: ApiFetchOptions = {},
): Promise<void> {
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers ?? {}),
  };
  let res: Response;
  try {
    res = await fetch(url, {
      method: options.method ?? "DELETE",
      headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  } catch (err) {
    throw new BookingApiError(
      `${label} request failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    throw new BookingApiError(`${label} failed (HTTP ${res.status})`, res.status, detail);
  }
}
