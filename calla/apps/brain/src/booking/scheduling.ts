/**
 * Pure timezone-aware scheduling math — NO date libraries (Intl only).
 *
 * The slot finder is shared by the Google and Microsoft providers: both
 * normalize their calendars into UTC BusyRanges, then findAvailableSlots()
 * walks local days in the rep's timezone (Europe/Dublin by default, DST-safe
 * via Intl), grids slots from the work-hours start, and rejects anything that
 * overlaps a busy range inflated by the buffer.
 */
import type { BusyRange, Slot, WorkHours } from "./types.js";

export interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  /** ISO weekday: 1 = Monday … 7 = Sunday. */
  weekday: number;
}

const WEEKDAY_BY_EN_SHORT: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

function zoneFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    weekday: "short",
    hourCycle: "h23",
  });
}

/** Decompose an instant into wall-clock parts in the given IANA timezone. */
export function zoneParts(date: Date, timeZone: string): ZoneParts {
  const parts: Record<string, string> = {};
  for (const p of zoneFormatter(timeZone).formatToParts(date)) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAY_BY_EN_SHORT[parts.weekday] ?? 1,
  };
}

/** UTC offset (ms) of `timeZone` at the given instant (local-as-UTC − UTC). */
export function zoneOffsetMs(instant: Date, timeZone: string): number {
  const p = zoneParts(instant, timeZone);
  const localAsUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return localAsUtc - instant.getTime();
}

/**
 * Convert a wall-clock time in `timeZone` to a UTC instant. Iterates the
 * offset twice so DST transitions (Europe/Dublin flips GMT↔IST) resolve
 * correctly for typical booking windows.
 */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
  second = 0,
): Date {
  const asUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const off1 = zoneOffsetMs(new Date(asUtc), timeZone);
  const t1 = asUtc - off1;
  const off2 = zoneOffsetMs(new Date(t1), timeZone);
  return new Date(asUtc - off2);
}

/** Format an instant as "YYYY-MM-DDTHH:mm:ss" wall time in `timeZone`. */
export function utcToWallTime(date: Date, timeZone: string): string {
  const p = zoneParts(date, timeZone);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${p.year}-${pad(p.month)}-${pad(p.day)}` +
    `T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
  );
}

/** Parse "HH:MM" → [hour, minute]; throws on malformed input. */
export function parseHHMM(value: string): [number, number] {
  const m = /^(\d{2}):(\d{2})$/.exec(value ?? "");
  if (!m) throw new Error(`Invalid HH:MM time: ${value}`);
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) throw new Error(`Invalid HH:MM time: ${value}`);
  return [hour, minute];
}

/**
 * Parse provider wall-time strings into UTC ISO.
 * Handles: RFC3339 with offset/Z (returned as-is, normalized), and Graph-style
 * offset-less wall times ("2026-10-05T09:00:00.0000000") interpreted in
 * `fallbackTimeZone`. Returns null when unparseable.
 */
export function parseProviderTime(value: string, fallbackTimeZone: string): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(raw)) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?$/.exec(raw);
  if (!m) {
    const t = Date.parse(raw);
    return Number.isFinite(t) ? new Date(t).toISOString() : null;
  }
  return zonedTimeToUtc(
    Number(m[1]),
    Number(m[2]),
    Number(m[3]),
    Number(m[4]),
    Number(m[5]),
    fallbackTimeZone,
    Number(m[6] ?? 0),
  ).toISOString();
}

export interface FindSlotsInput {
  /** Window start (ISO-8601 UTC). */
  from: string;
  /** Window end (ISO-8601 UTC). */
  to: string;
  /** Existing busy intervals (ISO-8601 UTC), e.g. from freeBusy/getSchedule. */
  busy: BusyRange[];
  workHours: WorkHours;
  slotMinutes: number;
  bufferMinutes: number;
  /** IANA timezone of the work hours (Europe/Dublin default). */
  timezone: string;
  /** Max confirmed bookings per local day (busy ranges count toward it). */
  maxPerDay?: number | null;
}

const MAX_DAY_ITERATIONS = 62; // ~2 months hard cap

function overlaps(aStart: number, aEnd: number, bStart: number, bEnd: number): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/**
 * Available start slots inside [from, to]:
 *  - one grid per local working day, stepping `slotMinutes` from work-hours
 *    start (slots align to the day grid, never straddle work-hours end);
 *  - a slot is rejected when it overlaps any busy range inflated by
 *    `bufferMinutes` on BOTH sides (buffer before + after each appointment);
 *  - `maxPerDay` caps slots per local day, counting busy ranges that
 *    intersect the day as already-booked;
 *  - DST-safe: local days are walked via noon-anchored 24h steps in `timezone`.
 */
export function findAvailableSlots(input: FindSlotsInput): Slot[] {
  const { busy, workHours, timezone } = input;
  const slotMs = Math.max(1, Math.trunc(input.slotMinutes)) * 60_000;
  const bufferMs = Math.max(0, Math.trunc(input.bufferMinutes)) * 60_000;
  const fromMs = Date.parse(input.from);
  const toMs = Date.parse(input.to);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs) || toMs <= fromMs) return [];

  let workWindow: { startH: number; startM: number; endH: number; endM: number };
  try {
    const [startH, startM] = parseHHMM(workHours.start);
    const [endH, endM] = parseHHMM(workHours.end);
    workWindow = { startH, startM, endH, endM };
  } catch {
    return [];
  }
  const { startH, startM, endH, endM } = workWindow;
  const days = new Set(workHours.days ?? []);

  const busyRanges = busy
    .map((b) => [Date.parse(b.start), Date.parse(b.end)] as const)
    .filter(([s, e]) => Number.isFinite(s) && Number.isFinite(e) && e > s);

  const slots: Slot[] = [];
  const first = zoneParts(new Date(fromMs), timezone);
  let day = { year: first.year, month: first.month, day: first.day };

  for (let i = 0; i < MAX_DAY_ITERATIONS; i += 1) {
    const midnight = zonedTimeToUtc(day.year, day.month, day.day, 0, 0, timezone);
    if (midnight.getTime() > toMs) break;
    const dayInfo = zoneParts(midnight, timezone);

    if (days.has(dayInfo.weekday)) {
      const wStart = zonedTimeToUtc(day.year, day.month, day.day, startH, startM, timezone);
      const wEnd = zonedTimeToUtc(day.year, day.month, day.day, endH, endM, timezone);
      const dayStartMs = midnight.getTime();
      const dayEndMs = dayStartMs + 24 * 3600_000;

      const winFrom = Math.max(fromMs, wStart.getTime());
      const winTo = Math.min(toMs, wEnd.getTime());

      const bookedToday = busyRanges.filter(([s, e]) =>
        overlaps(s, e, dayStartMs, dayEndMs),
      ).length;
      const remaining =
        input.maxPerDay == null ? Infinity : Math.max(0, input.maxPerDay - bookedToday);

      let pushedToday = 0;
      for (let t = wStart.getTime(); t + slotMs <= wEnd.getTime(); t += slotMs) {
        if (pushedToday >= remaining) break;
        const sEnd = t + slotMs;
        if (t < winFrom || sEnd > winTo) continue;
        const blocked = busyRanges.some(([bs, be]) =>
          overlaps(t, sEnd, bs - bufferMs, be + bufferMs),
        );
        if (blocked) continue;
        slots.push({
          start: new Date(t).toISOString(),
          end: new Date(sEnd).toISOString(),
        });
        pushedToday += 1;
      }
    }

    // Advance to the next LOCAL day via a noon anchor (DST days are 23/25h).
    const noon = zonedTimeToUtc(day.year, day.month, day.day, 12, 0, timezone);
    const next = zoneParts(new Date(noon.getTime() + 24 * 3600_000), timezone);
    day = { year: next.year, month: next.month, day: next.day };
  }

  return slots;
}
