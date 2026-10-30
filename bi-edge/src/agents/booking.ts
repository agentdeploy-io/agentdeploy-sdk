/**
 * Booking slots + Google Calendar links for the email reply flow.
 *
 * The agent proposes concrete slots when a lead shows interest; when the
 * lead picks one, we record a confirmed booking and hand the customer a
 * Google Calendar "add event" link (no API credentials required). When a
 * Google Calendar service account is configured later, `google_event_id`
 * on the bookings table is where the real event id lands.
 */

export interface BookingSlot {
  index: number;
  start: Date;
  end: Date;
  label: string;
}

/**
 * Next `count` slots: the next two weekdays (London time), 14:00 and 16:00
 * local, 30 minutes each. Slots in the past 3 hours are skipped.
 */
export function nextBookingSlots(count = 4): BookingSlot[] {
  const tz = "Europe/London";
  const now = new Date();
  const slots: BookingSlot[] = [];
  const times = [14, 16];

  let day = new Date(now);
  let index = 0;
  while (slots.length < count) {
    day = new Date(day.getTime() + 24 * 3600 * 1000);
    const dow = londonDayOfWeek(day);
    if (dow === 0 || dow === 6) continue; // skip weekends
    for (const hour of times) {
      if (slots.length >= count) break;
      const start = londonLocalToUtc(day, hour, 0);
      if (start.getTime() - now.getTime() < 3 * 3600 * 1000) continue;
      const end = new Date(start.getTime() + 30 * 60 * 1000);
      slots.push({ index, start, end, label: slotLabel(start, tz) });
      index++;
    }
  }
  return slots;
}

function slotLabel(start: Date, tz: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: tz,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(start) + " (UK)";
}

/** Day of week (0=Sun) in a given IANA timezone. */
function londonDayOfWeek(d: Date): number {
  const wd = new Intl.DateTimeFormat("en-US", { timeZone: "Europe/London", weekday: "short" }).format(d);
  return { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[wd] ?? 1;
}

/**
 * Build a UTC Date for `hour:minute` on the London wall-clock day `day`
 * (any instant on that day works for the wall-clock date).
 */
function londonLocalToUtc(day: Date, hour: number, minute: number): Date {
  // The UTC instant whose London wall-clock time is hour:minute on that day.
  // Date.UTC months are 0-based — the formatter returns 1-based.
  const guess = Date.UTC(
    getLondonYear(day), getLondonMonth(day) - 1, getLondonDayOfMonth(day),
    hour - londonUtcOffsetHours(day), minute,
  );
  return new Date(guess);
}

function londonUtcOffsetHours(d: Date): number {
  const utc = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Europe/London",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour") % 24, get("minute"), get("second"));
  return (asUtc - utc.getTime()) / 3600000;
}

function getLondonYear(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", year: "numeric" }).format(d));
}
function getLondonMonth(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", month: "2-digit" }).format(d));
}
function getLondonDayOfMonth(d: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/London", day: "2-digit" }).format(d));
}

/** Basic-format UTC timestamp for the Google Calendar template (YYYYMMDDTHHMMSSZ). */
function gcalBasic(d: Date): string {
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

/**
 * Google Calendar "add to calendar" template link — the customer clicks it,
 * picks their Google account, and the event lands in their calendar.
 */
export function googleCalendarLink(title: string, start: Date, end: Date, details = ""): string {
  const params = new URLSearchParams({
    action: "TEMPLATE",
    text: title,
    dates: `${gcalBasic(start)}/${gcalBasic(end)}`,
    details,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}
