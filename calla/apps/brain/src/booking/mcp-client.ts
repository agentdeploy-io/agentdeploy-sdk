/**
 * External Calendar MCP client — the "mcp" backend of the dual booking system.
 * ──────────────────────────────────────────────────────────────────────────
 * Connects (as an MCP CLIENT) to a client-provided Google Calendar MCP server
 * (e.g. a practice that already runs its own calendar MCP, or a hosted Google
 * Calendar MCP). Uses @modelcontextprotocol/sdk's Client + Streamable HTTP
 * transport — the same standard the Calla-hosted MCP server speaks, so Calla
 * can both CONSUME and PROVIDE booking over MCP.
 *
 * Canonical ops are mapped onto the external server's tool names. Because
 * external MCP servers vary, tool resolution is:
 *   1. explicit env overrides (EXTERNAL_MCP_TOOL_*), else
 *   2. heuristic name matching against the discovered tool list, else
 *   3. op unavailable (throws BookingApiError 501 with a clear message).
 *
 * Disabled (enabled=false) when EXTERNAL_CALENDAR_MCP_URL is unset — the
 * backend selector then never picks it. Every call is best-effort: connection
 * or tool errors surface as BookingApiError so the selector can fall back to
 * native in "both" mode.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { BookingApiError, type Appointment, type Slot } from "./types.js";

export type ExternalOp =
  | "availability"
  | "book"
  | "list"
  | "cancel"
  | "reps";

/** Heuristic tool-name candidates per op (lowercased substring match). */
const TOOL_HINTS: Record<ExternalOp, string[]> = {
  availability: ["availab", "freebusy", "free_busy", "find_time", "find-time", "slot", "schedule"],
  book: ["create_event", "createevent", "book", "add_event", "addevent", "schedule_event", "new_event"],
  list: ["list_event", "listevent", "get_events", "getevents", "list", "upcoming", "events"],
  cancel: ["delete_event", "deleteevent", "cancel", "remove_event", "removeevent"],
  reps: ["list_calendar", "listcalendar", "calendars", "list_rep", "resources", "list_resources"],
};

function clean(v: string | undefined): string | undefined {
  const t = (v ?? "").trim();
  return t.length > 0 ? t : undefined;
}

export interface ExternalMcpConfig {
  url?: string;
  token?: string;
  toolOverrides: Partial<Record<ExternalOp, string>>;
}

export function readExternalMcpConfig(): ExternalMcpConfig {
  const env = process.env;
  return {
    url: clean(env.EXTERNAL_CALENDAR_MCP_URL),
    token: clean(env.EXTERNAL_CALENDAR_MCP_TOKEN),
    toolOverrides: {
      availability: clean(env.EXTERNAL_MCP_TOOL_AVAILABILITY),
      book: clean(env.EXTERNAL_MCP_TOOL_BOOK),
      list: clean(env.EXTERNAL_MCP_TOOL_LIST),
      cancel: clean(env.EXTERNAL_MCP_TOOL_CANCEL),
      reps: clean(env.EXTERNAL_MCP_TOOL_REPS),
    },
  };
}

/** Extract + JSON-parse the first text content block from an MCP tool result. */
function parseToolResult(result: { content?: unknown; structuredContent?: unknown }): unknown {
  if (result && typeof result === "object" && "structuredContent" in result && result.structuredContent) {
    return result.structuredContent;
  }
  const content = (result as { content?: Array<{ type: string; text?: string }> })?.content;
  if (Array.isArray(content)) {
    const textBlock = content.find((b) => b?.type === "text" && typeof b.text === "string");
    if (textBlock?.text) {
      try {
        return JSON.parse(textBlock.text);
      } catch {
        return { text: textBlock.text };
      }
    }
  }
  return result ?? null;
}

/**
 * A lazily-connected MCP client to an external calendar server. One instance
 * per brain process; reconnects on demand. Not thread-safe across concurrent
 * connects (fine for our single-process Node server; guarded by a promise).
 */
export class ExternalCalendarMcp {
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;
  private toolNames: string[] | null = null;
  readonly enabled: boolean;

  constructor(private readonly cfg: ExternalMcpConfig = readExternalMcpConfig()) {
    this.enabled = Boolean(cfg.url);
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    if (!this.cfg.url) {
      throw new BookingApiError("external calendar MCP not configured (EXTERNAL_CALENDAR_MCP_URL)", 501);
    }
    this.connectPromise = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url!), {
        ...(this.cfg.token
          ? { requestInit: { headers: { authorization: `Bearer ${this.cfg.token}` } } }
          : {}),
      });
      const client = new Client({ name: "calla-booking", version: "1.0.0" });
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /** Discover tool names once (cached). */
  async listToolNames(): Promise<string[]> {
    if (this.toolNames) return this.toolNames;
    const client = await this.ensureClient();
    const res = await client.listTools();
    this.toolNames = (res.tools ?? []).map((t) => t.name);
    return this.toolNames;
  }

  /** Resolve the external tool name for a canonical op (override → heuristic). */
  async resolveTool(op: ExternalOp): Promise<string> {
    const override = this.cfg.toolOverrides[op];
    if (override) return override;
    const names = await this.listToolNames();
    const hints = TOOL_HINTS[op];
    for (const hint of hints) {
      const hit = names.find((n) => n.toLowerCase().includes(hint));
      if (hit) return hit;
    }
    throw new BookingApiError(
      `external calendar MCP has no "${op}" tool (discovered: ${names.join(", ") || "none"}). ` +
        `Set EXTERNAL_MCP_TOOL_${op.toUpperCase()} to map it.`,
      501,
    );
  }

  private async call(op: ExternalOp, args: Record<string, unknown>): Promise<unknown> {
    try {
      const client = await this.ensureClient();
      const name = await this.resolveTool(op);
      const result = await client.callTool({ name, arguments: args });
      return parseToolResult(result as { content?: unknown; structuredContent?: unknown });
    } catch (err) {
      if (err instanceof BookingApiError) throw err;
      throw new BookingApiError(
        `external calendar MCP "${op}" failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
  }

  // ── Canonical ops (normalized to Calla shapes, defensively) ──────

  /** Availability → Slot[] (best-effort normalization of external shapes). */
  async checkAvailability(input: {
    from?: string;
    to?: string;
    date?: string;
    repId?: string;
  }): Promise<{ slots: Slot[]; raw: unknown }> {
    const args: Record<string, unknown> = {};
    if (input.from) args.from = input.from;
    if (input.to) args.to = input.to;
    if (input.date) args.date = input.date;
    if (input.repId) args.calendarId = input.repId;
    const raw = await this.call("availability", args);
    return { slots: normalizeSlots(raw), raw };
  }

  /** Book → Appointment-ish (best-effort normalization). */
  async bookAppointment(input: {
    start: string;
    end?: string;
    title?: string;
    attendeeName?: string;
    attendeeEmail?: string;
    notes?: string;
    repId?: string;
  }): Promise<{ appointment: Appointment; raw: unknown }> {
    const args: Record<string, unknown> = {
      start: input.start,
      ...(input.end ? { end: input.end } : {}),
      ...(input.title ? { title: input.title, summary: input.title } : {}),
      ...(input.attendeeName ? { attendeeName: input.attendeeName } : {}),
      ...(input.attendeeEmail ? { attendeeEmail: input.attendeeEmail, email: input.attendeeEmail } : {}),
      ...(input.notes ? { notes: input.notes, description: input.notes } : {}),
      ...(input.repId ? { calendarId: input.repId } : {}),
    };
    const raw = await this.call("book", args);
    return { appointment: normalizeAppointment(raw, input), raw };
  }

  async listAppointments(input: { from?: string; to?: string; repId?: string }): Promise<unknown> {
    const args: Record<string, unknown> = {};
    if (input.from) args.from = input.from;
    if (input.to) args.to = input.to;
    if (input.repId) args.calendarId = input.repId;
    return this.call("list", args);
  }

  async cancelAppointment(input: { id: string; repId?: string }): Promise<unknown> {
    const args: Record<string, unknown> = { id: input.id, eventId: input.id };
    if (input.repId) args.calendarId = input.repId;
    return this.call("cancel", args);
  }

  async listCalendars(): Promise<unknown> {
    return this.call("reps", {});
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.toolNames = null;
  }
}

// ─── Defensive normalizers (external MCP shapes vary widely) ──────

function firstString(o: unknown, keys: string[]): string | undefined {
  if (!o || typeof o !== "object") return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

function normalizeSlots(raw: unknown): Slot[] {
  const arr = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { slots?: unknown })?.slots)
      ? ((raw as { slots: unknown[] }).slots)
      : Array.isArray((raw as { available?: unknown })?.available)
        ? ((raw as { available: unknown[] }).available)
        : Array.isArray((raw as { times?: unknown })?.times)
          ? ((raw as { times: unknown[] }).times)
          : [];
  const out: Slot[] = [];
  for (const item of arr) {
    if (typeof item === "string") {
      const start = item;
      const endMs = Date.parse(start) + 45 * 60_000;
      if (Number.isFinite(Date.parse(start))) {
        out.push({ start, end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : start });
      }
      continue;
    }
    const start = firstString(item, ["start", "startTime", "begin", "from", "time"]);
    const end = firstString(item, ["end", "endTime", "to", "finish"]);
    if (start) out.push({ start, end: end ?? start });
  }
  return out;
}

function normalizeAppointment(
  raw: unknown,
  input: { start: string; end?: string; title?: string; attendeeName?: string; attendeeEmail?: string },
): Appointment {
  const id =
    firstString(raw, ["id", "eventId", "event_id", "uid"]) ?? `mcp-${Date.now()}`;
  const start = firstString(raw, ["start", "startTime", "begin", "from"]) ?? input.start;
  const end = firstString(raw, ["end", "endTime", "to"]) ?? input.end ?? start;
  const title = firstString(raw, ["title", "summary", "subject"]) ?? input.title ?? "Appointment";
  const meetingUrl = firstString(raw, ["meetingUrl", "hangoutLink", "meetLink", "conferenceLink", "videoCallUrl"]);
  return {
    id,
    provider: "google",
    repId: "external-mcp",
    attendee: {
      name: input.attendeeName ?? "External MCP booking",
      ...(input.attendeeEmail ? { email: input.attendeeEmail } : {}),
    },
    start,
    end,
    title,
    status: "confirmed",
    createdAt: new Date().toISOString(),
    ...(meetingUrl ? { meetingUrl } : {}),
  };
}

/** Process-wide singleton (lazily created). */
let singleton: ExternalCalendarMcp | null = null;
export function getExternalCalendarMcp(): ExternalCalendarMcp {
  if (!singleton) singleton = new ExternalCalendarMcp();
  return singleton;
}
