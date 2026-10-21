/**
 * Calla-hosted Booking MCP server — the "Google Calendar MCP" surface.
 * ────────────────────────────────────────────────────────────────────
 * Exposes Calla's booking capability as a STANDARD MCP server (Streamable
 * HTTP), backed by the same dual backend selector the REST routes use. Any
 * MCP client can connect — a Mastra agent (via @mastra/mcp), the voice agent,
 * Claude Desktop, Cursor, or an external orchestrator — and get the exact
 * same availability/booking behaviour, audit trail and HITL gating as the
 * REST API. This is what makes booking "MCP-native" without duplicating logic.
 *
 * Tools: list_reps, check_availability, book_appointment, list_appointments,
 * cancel_appointment.
 *
 * Transport: stateless Web-Standard Streamable HTTP (a fresh McpServer +
 * transport per request — simple, robust, no session map to leak). Mount with
 * handleBookingMcpRequest(store, req) inside a Hono route (see server.ts).
 *
 * NOTE on zod: the MCP SDK's `ZodRawShapeCompat` type references the ROOT zod
 * (3.25 bridge) while brain resolves a nested zod 4.6.5, so the two nominal
 * `ZodString` types don't unify at compile time. Runtime validation is fine
 * (the SDK duck-types via `_zod.def`, present in zod 4). We therefore bind
 * `registerTool` to a loosely-typed local `register()` and give each callback
 * an explicit arg interface — no `any` leaks, no dependency-tree surgery.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";
import type { CallaStore } from "../store/types.js";
import { BookingApiError } from "./types.js";
import { bookingStore } from "./service.js";
import { getBackend, backendStatus } from "./backend.js";

/** Render a value as an MCP tool result (JSON text content). */
function jsonResult(value: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }],
    isError,
  };
}

/** Map a thrown error to an MCP error result (code + message, no stack). */
function errorResult(err: unknown) {
  const status = err instanceof BookingApiError ? err.status : undefined;
  const message = err instanceof Error ? err.message : String(err);
  return jsonResult(
    {
      error: message,
      ...(status ? { status } : {}),
      ...(err instanceof BookingApiError && err.detail ? { detail: err.detail.slice(0, 300) } : {}),
    },
    true,
  );
}

// ─── Explicit arg types (callback params) ────────────────────────

interface ListRepsArgs {}
interface CheckAvailabilityArgs {
  repId: string;
  date?: string;
  from?: string;
  to?: string;
}
interface BookAppointmentArgs {
  repId: string;
  start: string;
  end?: string;
  attendeeName: string;
  attendeeEmail?: string;
  attendeePhone?: string;
  leadKey?: string;
  propertyAddress?: string;
  notes?: string;
}
interface ListAppointmentsArgs {
  repId?: string;
  days?: number;
}
interface CancelAppointmentArgs {
  id: string;
  repId?: string;
}

/**
 * Build a fresh McpServer with the booking tools registered against the
 * active backend. Created per request (stateless transport).
 */
export function createBookingMcpServer(store: CallaStore): McpServer {
  const bs = bookingStore(store);
  const backend = getBackend(bs);

  const server = new McpServer(
    { name: "calla-booking", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // Loosely-typed alias for registerTool: the SDK's generic constraint wants a
  // `ZodRawShapeCompat` built from the ROOT zod, which our nested zod-4 shapes
  // don't nominally satisfy (runtime is fine — the SDK duck-types `_zod.def`).
  // Binding once with an explicit signature keeps each callback's args typed
  // via the interfaces below and avoids `never` propagation.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: { title?: string; description?: string; inputSchema?: unknown },
    cb: (args: never, extra: unknown) => unknown,
  ) => unknown;

  register(
    "list_reps",
    {
      title: "List bookable reps",
      description:
        "List the bookable representatives/calendars and their providers. Use a repId from here for check_availability and book_appointment.",
      inputSchema: {},
    },
    async (_args: ListRepsArgs) => {
      try {
        const reps = await backend.listReps();
        return jsonResult({
          backend: backend.modeName,
          reps: reps.map((r) => ({
            id: r.id,
            name: r.name,
            provider: r.provider,
            enabled: r.enabled,
            connected: r.provider === "calendly" ? Boolean(r.schedulingLink) : Boolean(r.accountId),
            timezone: r.timezone ?? "Europe/Dublin",
          })),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  register(
    "check_availability",
    {
      title: "Check availability",
      description:
        "Return open appointment slots for a rep. Calendly reps return a scheduling link instead of slots. Provide either a date (YYYY-MM-DD) or an explicit from/to ISO range; defaults to the next 7 days.",
      inputSchema: {
        repId: z.string().describe("Rep id from list_reps"),
        date: z.string().optional().describe("YYYY-MM-DD (local); expands to that day"),
        from: z.string().optional().describe("ISO-8601 range start"),
        to: z.string().optional().describe("ISO-8601 range end"),
      },
    },
    async (args: CheckAvailabilityArgs) => {
      try {
        const { repId, date, from, to } = args;
        let rangeFrom = from;
        let rangeTo = to;
        if (date && !from) {
          rangeFrom = `${date}T00:00:00.000Z`;
          rangeTo = new Date(Date.parse(rangeFrom) + 24 * 3600_000).toISOString();
        }
        const result = await backend.getAvailability({
          repId,
          ...(rangeFrom ? { from: rangeFrom } : {}),
          ...(rangeTo ? { to: rangeTo } : {}),
          ...(date ? { date } : {}),
        });
        return jsonResult({ backend: backend.modeName, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  register(
    "book_appointment",
    {
      title: "Book an appointment",
      description:
        "Create an appointment for a rep. For Calendly reps this returns a scheduling link to hand to the person (confirmed via Calendly's webhook). Attendee data is minimized (name required; email/phone optional).",
      inputSchema: {
        repId: z.string().describe("Rep id from list_reps"),
        start: z.string().describe("ISO-8601 start time"),
        end: z.string().optional().describe("ISO-8601 end (defaults to start + slot length)"),
        attendeeName: z.string().describe("Attendee full name"),
        attendeeEmail: z.string().optional().describe("Attendee email"),
        attendeePhone: z.string().optional().describe("Attendee phone"),
        leadKey: z.string().optional().describe("Associated lead key (attribution)"),
        propertyAddress: z.string().optional().describe("Property/service address context"),
        notes: z.string().optional().describe("Free-text context for the event body"),
      },
    },
    async (args: BookAppointmentArgs) => {
      try {
        const { repId, start, end, attendeeName, attendeeEmail, attendeePhone, leadKey, propertyAddress, notes } = args;
        const result = await backend.bookAppointment({
          repId,
          start,
          ...(end ? { end } : {}),
          attendee: {
            name: attendeeName,
            ...(attendeeEmail ? { email: attendeeEmail } : {}),
            ...(attendeePhone ? { phone: attendeePhone } : {}),
          },
          ...(leadKey || propertyAddress || notes
            ? {
                context: {
                  ...(leadKey ? { leadKey } : {}),
                  ...(propertyAddress ? { propertyAddress } : {}),
                  ...(notes ? { notes } : {}),
                },
              }
            : {}),
        });
        return jsonResult({
          backend: backend.modeName,
          appointment: result.appointment,
          ...(result.link ? { link: result.link } : {}),
          ...(result.calendlyHandoff
            ? { calendlyHandoff: true, note: "Share the link; the booking confirms via Calendly webhook." }
            : {}),
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  register(
    "list_appointments",
    {
      title: "List appointments",
      description: "List upcoming appointments (default next 7 days), optionally for one rep.",
      inputSchema: {
        repId: z.string().optional().describe("Filter to one rep"),
        days: z.number().int().min(1).max(90).optional().describe("Days ahead (default 7)"),
      },
    },
    async (args: ListAppointmentsArgs) => {
      try {
        const result = await backend.listAppointments({
          ...(args.repId ? { repId: args.repId } : {}),
          ...(args.days ? { days: args.days } : {}),
        });
        return jsonResult({ backend: backend.modeName, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  register(
    "cancel_appointment",
    {
      title: "Cancel an appointment",
      description: "Cancel an appointment by id (repId optional; helps resolve the provider).",
      inputSchema: {
        id: z.string().describe("Appointment id"),
        repId: z.string().optional().describe("Rep id (helps resolve the provider)"),
      },
    },
    async (args: CancelAppointmentArgs) => {
      try {
        const result = await backend.cancelAppointment({
          id: args.id,
          ...(args.repId ? { repId: args.repId } : {}),
        });
        return jsonResult({ backend: backend.modeName, ...result });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  return server;
}

/**
 * Handle one MCP Streamable-HTTP request (stateless): build a fresh server +
 * transport, connect, delegate the Web Request, return the Web Response.
 * Mount inside a Hono route: `return handleBookingMcpRequest(store, c.req.raw)`.
 */
export async function handleBookingMcpRequest(
  store: CallaStore,
  req: Request,
): Promise<Response> {
  const server = createBookingMcpServer(store);
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless + buffered JSON responses: no session map, no SSE stream to
    // keep open — safe to close the transport/server right after handling.
    enableJsonResponse: true,
  });
  try {
    await server.connect(transport);
    return await transport.handleRequest(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ error: `MCP request failed: ${message}` }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  } finally {
    // enableJsonResponse buffers the full body, so closing now is safe.
    transport.close().catch(() => {});
    server.close().catch(() => {});
  }
}

/** Status helper for the REST /booking surface (reports MCP availability). */
export function mcpSurfaceStatus() {
  const enabled = (process.env.BOOKING_MCP_ENABLED ?? "true").trim().toLowerCase() !== "false";
  return { enabled, path: "/mcp/booking", transport: "streamable-http", backend: backendStatus() };
}
