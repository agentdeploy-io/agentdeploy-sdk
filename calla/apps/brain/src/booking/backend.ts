/**
 * Dual booking backend selector — the "one or the other or both" switch.
 * ────────────────────────────────────────────────────────────────────────
 * BOOKING_BACKEND selects how booking ops are served:
 *   - "native"  (default): Calla's own booking module (service.ts) over the
 *                          reps' connected Google/M365/Calendly calendars.
 *   - "mcp":               an EXTERNAL Google Calendar MCP server (mcp-client)
 *                          the client already runs — Calla proxies to it.
 *   - "both":              native first; on not-connected/no-reps/501 fall
 *                          back to the external MCP (and vice-versa for reads).
 *
 * Both the REST routes and the Calla-hosted MCP server call `getBackend()`,
 * so there is exactly ONE booking core regardless of protocol or backend.
 *
 * Everything is best-effort + auditable: backend choice is logged, and errors
 * are normalized to BookingApiError so callers render them uniformly.
 */
import { BookingApiError } from "./types.js";
import type { BookingStore } from "./store.js";
import {
  getAvailability as nativeAvailability,
  bookAppointment as nativeBook,
  listAppointments as nativeList,
  cancelAppointment as nativeCancel,
  listReps as nativeReps,
  type AvailabilityInput,
  type AvailabilityResult,
  type BookInput,
  type BookResult,
  type CancelResult,
  type ListAppointmentsResult,
} from "./service.js";
import {
  getExternalCalendarMcp,
  type ExternalCalendarMcp,
} from "./mcp-client.js";
import { googleCalendarTemplateUrl } from "./providers/shared.js";
import type { Rep } from "./types.js";

export type BookingBackendMode = "native" | "mcp" | "both";

export function readBackendMode(): BookingBackendMode {
  const raw = (process.env.BOOKING_BACKEND ?? "native").trim().toLowerCase();
  return raw === "mcp" || raw === "both" ? (raw as BookingBackendMode) : "native";
}

export interface BackendStatus {
  mode: BookingBackendMode;
  native: boolean;
  externalMcp: { enabled: boolean; url?: string };
}

export function backendStatus(mcp: ExternalCalendarMcp = getExternalCalendarMcp()): BackendStatus {
  const mode = readBackendMode();
  return {
    mode,
    native: mode === "native" || mode === "both",
    externalMcp: {
      enabled: mcp.enabled && (mode === "mcp" || mode === "both"),
      ...(mcp.enabled ? { url: process.env.EXTERNAL_CALENDAR_MCP_URL } : {}),
    },
  };
}

/** True when a native error means "try the external MCP instead". */
function shouldFallbackToMcp(err: unknown): boolean {
  if (!(err instanceof BookingApiError)) return false;
  // 409 not-connected / 501 no-tool / 404 no-reps → the native side can't
  // serve this; in "both" mode the external calendar might.
  return err.status === 409 || err.status === 501 || err.message === "not-connected";
}

export class BookingBackend {
  constructor(
    private readonly bs: BookingStore,
    private readonly mcp: ExternalCalendarMcp = getExternalCalendarMcp(),
    private readonly mode: BookingBackendMode = readBackendMode(),
  ) {}

  get modeName(): BookingBackendMode {
    return this.mode;
  }

  async listReps(): Promise<Rep[]> {
    if (this.mode === "mcp") {
      // External MCP has no Calla rep registry; surface calendars as pseudo-reps.
      try {
        const raw = await this.mcp.listCalendars();
        return normalizeExternalReps(raw);
      } catch {
        return [];
      }
    }
    return nativeReps(this.bs);
  }

  async getAvailability(input: AvailabilityInput & { date?: string }): Promise<AvailabilityResult> {
    if (this.mode === "native") return nativeAvailability(this.bs, input);

    if (this.mode === "mcp") return this.mcpAvailability(input);

    // both: native first, fall back to external on connectivity gaps.
    try {
      return await nativeAvailability(this.bs, input);
    } catch (err) {
      if (this.mcp.enabled && shouldFallbackToMcp(err)) return this.mcpAvailability(input);
      throw err;
    }
  }

  async bookAppointment(input: BookInput): Promise<BookResult> {
    if (this.mode === "native") return nativeBook(this.bs, input);

    if (this.mode === "mcp") return this.mcpBook(input);

    try {
      return await nativeBook(this.bs, input);
    } catch (err) {
      if (this.mcp.enabled && shouldFallbackToMcp(err)) return this.mcpBook(input);
      throw err;
    }
  }

  async listAppointments(input: { repId?: string; days?: number } = {}): Promise<ListAppointmentsResult> {
    if (this.mode === "mcp") {
      const to = new Date(Date.now() + (input.days ?? 7) * 24 * 3600_000).toISOString();
      const raw = await this.mcp.listAppointments({ from: new Date().toISOString(), to, ...(input.repId ? { repId: input.repId } : {}) });
      return { appointments: normalizeExternalAppointments(raw), total: 0, window: { from: new Date().toISOString(), to }, errors: [] };
    }
    if (this.mode === "both") {
      const native = await nativeList(this.bs, input).catch(() => null);
      if (native && native.appointments.length > 0) return native;
      if (this.mcp.enabled) {
        try {
          const to = new Date(Date.now() + (input.days ?? 7) * 24 * 3600_000).toISOString();
          const raw = await this.mcp.listAppointments({ from: new Date().toISOString(), to });
          const appts = normalizeExternalAppointments(raw);
          if (appts.length > 0) {
            return { appointments: appts, total: appts.length, window: { from: new Date().toISOString(), to }, errors: [] };
          }
        } catch {
          /* fall through to native result */
        }
      }
      if (native) return native;
      return { appointments: [], total: 0, window: { from: new Date().toISOString(), to: new Date().toISOString() }, errors: [] };
    }
    return nativeList(this.bs, input);
  }

  async cancelAppointment(input: { id: string; repId?: string }): Promise<CancelResult> {
    if (this.mode === "mcp") {
      await this.mcp.cancelAppointment(input);
      return { ok: true, appointmentId: input.id, provider: "google" };
    }
    if (this.mode === "both") {
      try {
        return await nativeCancel(this.bs, input);
      } catch (err) {
        if (this.mcp.enabled && shouldFallbackToMcp(err)) {
          await this.mcp.cancelAppointment(input);
          return { ok: true, appointmentId: input.id, provider: "google" };
        }
        throw err;
      }
    }
    return nativeCancel(this.bs, input);
  }

  // ── External-MCP adapters (normalize to Calla result shapes) ──────

  private async mcpAvailability(
    input: AvailabilityInput & { date?: string },
  ): Promise<AvailabilityResult> {
    if (!this.mcp.enabled) {
      throw new BookingApiError("external calendar MCP not configured", 501);
    }
    const { slots } = await this.mcp.checkAvailability({
      ...(input.from ? { from: input.from } : {}),
      ...(input.to ? { to: input.to } : {}),
      ...(input.date ? { date: input.date } : {}),
      ...(input.repId ? { repId: input.repId } : {}),
    });
    return {
      kind: "slots",
      repId: input.repId ?? "external-mcp",
      provider: "google",
      timezone: process.env.EXTERNAL_MCP_TIMEZONE ?? "Europe/Dublin",
      from: input.from ?? new Date().toISOString(),
      to: input.to ?? new Date(Date.now() + 7 * 24 * 3600_000).toISOString(),
      slots,
      count: slots.length,
    };
  }

  private async mcpBook(input: BookInput): Promise<BookResult> {
    if (!this.mcp.enabled) {
      throw new BookingApiError("external calendar MCP not configured", 501);
    }
    const { appointment } = await this.mcp.bookAppointment({
      start: input.start,
      ...(input.end ? { end: input.end } : {}),
      title: `Survey — ${input.attendee.name}`,
      attendeeName: input.attendee.name,
      ...(input.attendee.email ? { attendeeEmail: input.attendee.email } : {}),
      ...(input.context?.notes ? { notes: input.context.notes } : {}),
      ...(input.repId ? { repId: input.repId } : {}),
    });
    await this.bs
      .audit("booking.created", {
        appointmentId: appointment.id,
        provider: "external-mcp",
        repId: appointment.repId,
        start: appointment.start,
        end: appointment.end,
        attendeeName: appointment.attendee.name,
        leadKey: input.context?.leadKey ?? null,
        via: "external-mcp",
      })
      .catch(() => {});
    const meetingUrl = appointment.meetingUrl;
    return {
      appointment,
      ...(meetingUrl ? { meetingUrl } : {}),
      addToCalendarUrl: googleCalendarTemplateUrl({
        title: appointment.title,
        startIso: appointment.start,
        endIso: appointment.end,
        ...(meetingUrl
          ? { location: meetingUrl, details: `Join video call:\n${meetingUrl}` }
          : {}),
      }),
    };
  }
}

// ─── External-shape normalizers ──────────────────────────────────

function normalizeExternalReps(raw: unknown): Rep[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { calendars?: unknown })?.calendars)
      ? ((raw as { calendars: unknown[] }).calendars)
      : [];
  const out: Rep[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const id = String(rec.id ?? rec.calendarId ?? rec.email ?? `ext-${out.length}`);
    out.push({
      id,
      name: String(rec.name ?? rec.summary ?? id),
      email: String(rec.email ?? id),
      provider: "google",
      workHours: { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:30" },
      slotMinutes: 45,
      bufferMinutes: 15,
      enabled: true,
    });
  }
  return out;
}

function normalizeExternalAppointments(raw: unknown): import("./types.js").Appointment[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { events?: unknown })?.events)
      ? ((raw as { events: unknown[] }).events)
      : Array.isArray((raw as { appointments?: unknown })?.appointments)
        ? ((raw as { appointments: unknown[] }).appointments)
        : [];
  const out: import("./types.js").Appointment[] = [];
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const start = String(rec.start ?? rec.startTime ?? rec.begin ?? "");
    if (!start) continue;
    out.push({
      id: String(rec.id ?? rec.eventId ?? `ext-${out.length}`),
      provider: "google",
      repId: String(rec.repId ?? rec.calendarId ?? "external-mcp"),
      attendee: { name: String(rec.attendeeName ?? rec.title ?? rec.summary ?? "Appointment") },
      start,
      end: String(rec.end ?? rec.endTime ?? start),
      title: String(rec.title ?? rec.summary ?? rec.subject ?? "Appointment"),
      status: "confirmed",
      createdAt: new Date().toISOString(),
    });
  }
  return out;
}

/** Build the active backend for a request/operation. */
export function getBackend(bs: BookingStore): BookingBackend {
  return new BookingBackend(bs);
}
