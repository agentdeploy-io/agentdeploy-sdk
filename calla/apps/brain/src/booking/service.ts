/**
 * Booking SERVICE — the single canonical booking core.
 * ──────────────────────────────────────────────────────
 * Every booking capability (availability, book, list, cancel, reps) is
 * implemented ONCE here, composed from the existing primitives (BookingStore,
 * providers, scheduling, oauth). Two protocol adapters sit on top and MUST NOT
 * reimplement booking logic:
 *
 *   1. REST   — booking/routes.ts (Hono) delegates its /availability,
 *               /appointments, /appointments/:id handlers here.
 *   2. MCP    — booking/mcp-server.ts exposes the same ops as standard MCP
 *               tools (the "Google Calendar MCP" surface).
 *
 * The dual backend selector (booking/backend.ts) wraps this as the "native"
 * backend; an external Google-Calendar MCP can be the "mcp" backend; "both"
 * tries native first then falls back to external. Because both protocols call
 * THIS module, native and MCP can never drift.
 *
 * Errors: throws BookingApiError with an HTTP-ish `status` (400/404/409/502)
 * so both REST (map to status code) and MCP (map to isError + code) render
 * them consistently. Calendly "book" is a link hand-off, not an error.
 */
import {
  BookingApiError,
  type Appointment,
  type Attendee,
  type BookingContext,
  type Rep,
  type Slot,
} from "./types.js";
import { getFreshConnection, readBookingConfig } from "./oauth.js";
import { findAvailableSlots } from "./scheduling.js";
import { BookingStore, DEFAULT_TIMEZONE } from "./store.js";
import {
  googleBusy,
  googleCancelEvent,
  googleCreateEvent,
  googleListUpcoming,
} from "./providers/google.js";
import {
  msCancelEvent,
  msCreateEvent,
  msGetSchedule,
  msListUpcoming,
} from "./providers/microsoft.js";
import { calendlyCancelInvitee } from "./providers/calendly.js";
import type { CallaStore } from "../store/types.js";

// ─── Result shapes ───────────────────────────────────────────────

export type AvailabilityResult =
  | {
      kind: "slots";
      repId: string;
      provider: "google" | "microsoft";
      timezone: string;
      from: string;
      to: string;
      slots: Slot[];
      count: number;
    }
  | { kind: "link"; repId: string; provider: "calendly"; link: string };

export interface BookResult {
  appointment: Appointment;
  /** Calendly hand-off link (calendly reps) or provider event link. */
  link?: string;
  /** True when the rep uses Calendly (no server-side event created). */
  calendlyHandoff?: boolean;
}

export interface ListAppointmentsResult {
  appointments: Appointment[];
  total: number;
  window: { from: string; to: string };
  errors: { repId: string; error: string }[];
}

export interface CancelResult {
  ok: true;
  appointmentId: string;
  provider: Rep["provider"];
}

// ─── Input shapes ────────────────────────────────────────────────

export interface AvailabilityInput {
  repId: string;
  /** ISO-8601; defaults to now. */
  from?: string;
  /** ISO-8601; defaults to from + 7 days. */
  to?: string;
}

export interface BookInput {
  repId: string;
  start: string;
  end?: string;
  attendee: Attendee;
  context?: BookingContext;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

/** Wrap a BookingStore around the shared CallaStore. */
export function bookingStore(store: CallaStore): BookingStore {
  return new BookingStore(store);
}

// ─── Service operations ──────────────────────────────────────────

export async function listReps(bs: BookingStore): Promise<Rep[]> {
  return bs.listReps();
}

/**
 * Availability for a rep. Calendly reps return their scheduling link (the
 * link IS the availability surface). Google/Microsoft return computed slots.
 * Throws BookingApiError(404 unknown rep, 400 disabled/bad-range, 409
 * not-connected/reconnect, 502 provider).
 */
export async function getAvailability(
  bs: BookingStore,
  input: AvailabilityInput,
): Promise<AvailabilityResult> {
  const rep = await bs.getRep(input.repId);
  if (!rep) throw new BookingApiError(`unknown rep: ${input.repId}`, 404);
  if (!rep.enabled) throw new BookingApiError(`rep "${input.repId}" is disabled`, 400);

  if (rep.provider === "calendly") {
    if (!rep.schedulingLink) {
      throw new BookingApiError(
        "rep has no scheduling link — POST /booking/connect/calendly/link first",
        409,
      );
    }
    return { kind: "link", repId: rep.id, provider: "calendly", link: rep.schedulingLink };
  }

  const now = Date.now();
  const fromMs = input.from ? Date.parse(input.from) : now;
  if (input.from && !Number.isFinite(fromMs)) {
    throw new BookingApiError(`invalid from: ${input.from}`, 400);
  }
  const toMs = input.to ? Date.parse(input.to) : fromMs + 7 * 24 * 3600_000;
  if (input.to && !Number.isFinite(toMs)) {
    throw new BookingApiError(`invalid to: ${input.to}`, 400);
  }
  if (toMs <= fromMs) throw new BookingApiError("to must be after from", 400);
  const from = new Date(fromMs).toISOString();
  const to = new Date(toMs).toISOString();

  if (!rep.accountId) {
    throw new BookingApiError("not-connected", 409);
  }
  const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
  if (!fresh.ok) {
    throw new BookingApiError(
      fresh.reason === "provider-error" ? "provider-error" : "reconnect-required",
      fresh.reason === "provider-error" ? 502 : 409,
      fresh.detail,
    );
  }

  const cfg = readBookingConfig();
  const policy = await bs.getPolicy();
  const timezone = rep.timezone ?? policy.timezone ?? DEFAULT_TIMEZONE;
  const busy =
    rep.provider === "google"
      ? await googleBusy(cfg.google, fresh.conn, from, to)
      : await msGetSchedule(
          cfg.microsoft,
          fresh.conn,
          fresh.conn.email ?? rep.email,
          from,
          to,
          timezone,
          rep.slotMinutes ?? policy.slotMinutes,
        );
  const slots = findAvailableSlots({
    from,
    to,
    busy,
    workHours: rep.workHours ?? policy.workHours,
    slotMinutes: rep.slotMinutes ?? policy.slotMinutes,
    bufferMinutes: rep.bufferMinutes ?? policy.bufferMinutes,
    timezone,
    maxPerDay: policy.maxBookingsPerDay,
  });
  return {
    kind: "slots",
    repId: rep.id,
    provider: rep.provider as "google" | "microsoft",
    timezone,
    from,
    to,
    slots,
    count: slots.length,
  };
}

/**
 * Book an appointment for a rep. Calendly reps cannot be booked server-side —
 * returns { calendlyHandoff:true, link } so the caller shares the link (the
 * webhook later mirrors the booking). Google/Microsoft create a real event +
 * audit "booking.created". Throws BookingApiError(400/404/409/502).
 */
export async function bookAppointment(
  bs: BookingStore,
  input: BookInput,
): Promise<BookResult> {
  if (!isIsoDate(input.start)) {
    throw new BookingApiError(`invalid start (expected ISO-8601): ${input.start}`, 400);
  }
  const rep = await bs.getRep(input.repId);
  if (!rep) throw new BookingApiError(`unknown rep: ${input.repId}`, 404);
  if (!rep.enabled) throw new BookingApiError(`rep "${rep.id}" is disabled`, 400);

  if (rep.provider === "calendly") {
    return {
      // Reuse a minimal Appointment shape so callers get a uniform result.
      appointment: {
        id: `calendly-handoff-${Date.now()}`,
        provider: "calendly",
        repId: rep.id,
        attendee: input.attendee,
        start: new Date(Date.parse(input.start)).toISOString(),
        end: input.end ? new Date(Date.parse(input.end)).toISOString() : new Date(Date.parse(input.start)).toISOString(),
        title: `Survey — ${input.attendee.name}`,
        ...(input.context ? { context: input.context } : {}),
        status: "tentative",
        createdAt: new Date().toISOString(),
      },
      link: rep.schedulingLink ?? undefined,
      calendlyHandoff: true,
    };
  }

  const policy = await bs.getPolicy();
  const slotMinutes = rep.slotMinutes ?? policy.slotMinutes;
  const startMs = Date.parse(input.start);
  const endMs = input.end ? Date.parse(input.end) : startMs + slotMinutes * 60_000;
  if (input.end && !Number.isFinite(endMs)) {
    throw new BookingApiError(`invalid end (expected ISO-8601): ${input.end}`, 400);
  }
  if (endMs <= startMs) throw new BookingApiError("end must be after start", 400);

  if (!rep.accountId) throw new BookingApiError("not-connected", 409);
  const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
  if (!fresh.ok) {
    throw new BookingApiError(
      fresh.reason === "provider-error" ? "provider-error" : "reconnect-required",
      fresh.reason === "provider-error" ? 502 : 409,
      fresh.detail,
    );
  }

  const cfg = readBookingConfig();
  const timezone = rep.timezone ?? policy.timezone ?? DEFAULT_TIMEZONE;
  const createInput = {
    attendee: input.attendee,
    ...(input.context ? { context: input.context } : {}),
    startIso: new Date(startMs).toISOString(),
    endIso: new Date(endMs).toISOString(),
    timezone,
    rep,
  };
  const created =
    rep.provider === "google"
      ? await googleCreateEvent(cfg.google, fresh.conn, createInput)
      : await msCreateEvent(cfg.microsoft, fresh.conn, createInput);
  const appointment: Appointment = {
    ...created.appointment,
    ...(input.context ? { context: input.context } : {}),
  };
  await bs.audit("booking.created", {
    appointmentId: appointment.id,
    provider: rep.provider,
    repId: rep.id,
    start: appointment.start,
    end: appointment.end,
    attendeeName: appointment.attendee.name,
    leadKey: input.context?.leadKey ?? null,
    via: "service",
  });
  const link =
    "htmlLink" in created && created.htmlLink
      ? created.htmlLink
      : "webLink" in created && created.webLink
        ? created.webLink
        : undefined;
  return { appointment, ...(link ? { link } : {}) };
}

/** Aggregate upcoming appointments across reps (best-effort per rep). */
export async function listAppointments(
  bs: BookingStore,
  input: { repId?: string; days?: number } = {},
): Promise<ListAppointmentsResult> {
  const days =
    input.days && Number.isFinite(input.days) && input.days >= 1
      ? Math.min(Math.trunc(input.days), 90)
      : 7;
  const reps = await bs.listReps();
  const targets = input.repId ? reps.filter((r) => r.id === input.repId) : reps;
  if (input.repId && targets.length === 0) {
    throw new BookingApiError(`unknown rep: ${input.repId}`, 404);
  }

  const from = new Date().toISOString();
  const to = new Date(Date.now() + days * 24 * 3600_000).toISOString();
  const cfg = readBookingConfig();
  const policy = await bs.getPolicy();
  const appointments: Appointment[] = [];
  const errors: { repId: string; error: string }[] = [];

  for (const rep of targets) {
    const timezone = rep.timezone ?? policy.timezone ?? DEFAULT_TIMEZONE;
    if (rep.provider === "calendly") {
      const invitees = await bs.listInvitees();
      for (const inv of invitees) {
        if (inv.repId !== rep.id || inv.status === "cancelled") continue;
        const t = Date.parse(inv.start);
        if (Number.isFinite(t) && t >= Date.now() && t <= Date.parse(to)) {
          appointments.push(inv);
        }
      }
      continue;
    }
    if (!rep.accountId || !rep.enabled) continue;
    const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
    if (!fresh.ok) {
      errors.push({ repId: rep.id, error: fresh.reason });
      continue;
    }
    try {
      const list =
        rep.provider === "google"
          ? await googleListUpcoming(cfg.google, fresh.conn, rep.id, from, to, timezone)
          : await msListUpcoming(cfg.microsoft, fresh.conn, rep.id, from, to, timezone);
      appointments.push(...list);
    } catch (err) {
      errors.push({ repId: rep.id, error: errorMessage(err).slice(0, 200) });
    }
  }

  appointments.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  return { appointments, total: appointments.length, window: { from, to }, errors };
}

/** Cancel an appointment. repId optional (calendly mirror can resolve it). */
export async function cancelAppointment(
  bs: BookingStore,
  input: { id: string; repId?: string },
): Promise<CancelResult> {
  const appointmentId = input.id;
  let rep: Rep | null = null;
  if (input.repId) {
    rep = await bs.getRep(input.repId);
    if (!rep) throw new BookingApiError(`unknown rep: ${input.repId}`, 404);
  } else {
    const invitees = await bs.listInvitees();
    const inv = invitees.find((a) => a.id === appointmentId);
    if (inv) rep = await bs.getRep(inv.repId);
    if (!rep) {
      throw new BookingApiError(
        "repId is required (appointment not found in the calendly mirror)",
        404,
      );
    }
  }

  const cfg = readBookingConfig();
  if (rep.provider === "calendly") {
    const invitees = await bs.listInvitees();
    const inv = invitees.find((a) => a.id === appointmentId && a.repId === rep?.id);
    if (!inv) throw new BookingApiError(`unknown appointment: ${appointmentId}`, 404);
    if (cfg.calendly.accessToken) {
      await calendlyCancelInvitee(cfg.calendly, `${inv.id}`).catch((err) => {
        console.warn("[booking] calendly API cancel failed (local mirror updated):", errorMessage(err));
      });
    }
    await bs.saveInvitee({ ...inv, status: "cancelled" });
    await bs.audit("booking.cancelled", {
      appointmentId,
      provider: "calendly",
      repId: rep.id,
      viaApi: Boolean(cfg.calendly.accessToken),
      via: "service",
    });
    return { ok: true, appointmentId, provider: "calendly" };
  }

  if (!rep.accountId) throw new BookingApiError("not-connected", 409);
  const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
  if (!fresh.ok) {
    throw new BookingApiError(
      fresh.reason === "provider-error" ? "provider-error" : "reconnect-required",
      fresh.reason === "provider-error" ? 502 : 409,
      fresh.detail,
    );
  }
  if (rep.provider === "google") {
    await googleCancelEvent(cfg.google, fresh.conn, appointmentId);
  } else {
    await msCancelEvent(cfg.microsoft, fresh.conn, appointmentId);
  }
  await bs.audit("booking.cancelled", {
    appointmentId,
    provider: rep.provider,
    repId: rep.id,
    via: "service",
  });
  return { ok: true, appointmentId, provider: rep.provider };
}
