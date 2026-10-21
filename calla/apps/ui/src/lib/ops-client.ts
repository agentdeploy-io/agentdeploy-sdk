/**
 * Ops REST Adapter
 * ────────────────
 * Read-only client over the brain's operational surfaces (qualification
 * flows, booking, audit log) consumed by the Reports screen.
 *
 * Mirrors mastra-client / skills-client conventions:
 *   - base URL from runtime config (getBrainUrl, default "/brain" proxy)
 *   - authFetch (cookie / Bearer edge-JWT depending on deployment)
 *   - disabled mode (BRAIN_URL ""/"none")
 *
 * Degradation contract: these endpoints land in the same release as the
 * Reports screen, so a 404 (older brain) or an unreachable brain is a
 * NORMAL state, not an error. Every method resolves — it never throws into
 * render — returning `{items: [], unreachable: true}` plus enough context
 * (`disabled`, `status`, `error`) for the panel to say honestly why it has
 * nothing to show.
 *
 * Endpoints:
 *   GET {base}/flows/runs?status=&limit=  → { runs: FlowRun[] }
 *   GET {base}/booking/appointments?days= → { appointments: Appointment[] }   (404 when booking is off)
 *   GET {base}/audit?limit=               → { entries: AuditEntry[] }
 */

import { getBrainUrl } from "@/config";
import { authFetch } from "@/hooks/useAuthFetch";

// ─── Types ───────────────────────────────────────────────────────

/** Set on every result when BRAIN_URL is empty/"none" (brain intentionally off). */
export const OPS_CLIENT_DISABLED = "Brain not configured — set BRAIN_URL to read flow runs.";

export interface FlowRunRouting {
  repId?: string;
  proposedSlots?: unknown[];
  link?: string;
}

/** One qualification-flow run, defensively mapped from the brain payload. */
export interface FlowRun {
  id: string;
  flowId: string;
  status: string;
  leadKey?: string;
  chatRef?: string;
  score?: number;
  tier?: string;
  priority?: string;
  updatedAt: string;
  routing?: FlowRunRouting;
  /** Answered-question count when the brain reports progress, else null. */
  answersCount: number | null;
  /** Untouched payload — panels may read extra fields without a client change. */
  raw: Record<string, unknown>;
}

export interface Appointment {
  id: string;
  provider: string;
  repId: string;
  /** Provider event title (e.g. "Property survey — Acme Ltd"). */
  title?: string;
  attendeeName: string;
  attendeeEmail?: string;
  start: string;
  end: string;
  status: string;
  leadKey?: string;
  raw: Record<string, unknown>;
}

export interface AuditEntry {
  seq: number;
  ts: string;
  kind: string;
  entry: unknown;
  agentId?: string;
}

/** Distinct audit `kind` with its occurrence count (newest occurrence first). */
export interface AuditKindCount {
  kind: string;
  count: number;
  lastTs: string | null;
}

/**
 * Result envelope for every read. `items` is ALWAYS an array — callers can
 * render it directly without a null check.
 */
export interface OpsResult<T> {
  items: T[];
  /**
   * Per-item problems the backend reported ALONGSIDE a successful read (e.g.
   * booking's `{errors:[{repId,error}]}` when one calendar couldn't be
   * reached). Empty on failure — `error` carries that instead.
   */
  warnings: string[];
  /** True when the brain produced no usable answer (disabled, network, 404, 5xx). */
  unreachable: boolean;
  /** True when BRAIN_URL is empty/"none". */
  disabled: boolean;
  /** HTTP status when the brain answered; null on network failure / disabled. */
  status: number | null;
  /** Human-readable failure reason (null when the read succeeded). */
  error: string | null;
}

export interface OpsClient {
  /** False when BRAIN_URL is empty/"none" — every read resolves unreachable. */
  enabled: boolean;
  /** Resolved brain base URL. */
  baseUrl: string;
  listFlowRuns(status?: string, limit?: number): Promise<OpsResult<FlowRun>>;
  listAppointments(days?: number): Promise<OpsResult<Appointment>>;
  listAuditKinds(limit?: number): Promise<OpsResult<AuditKindCount>>;
}

// ─── Helpers ─────────────────────────────────────────────────────

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

export function firstNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

/** Pull the array out of `{runs|appointments|entries: []}` or a bare array. */
function listOf(data: unknown, ...keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  const rec = asRecord(data);
  for (const key of keys) {
    if (Array.isArray(rec[key])) return rec[key] as unknown[];
  }
  return [];
}

function emptyResult<T>(
  partial: Partial<OpsResult<T>> & { unreachable: boolean },
): OpsResult<T> {
  return {
    items: [],
    warnings: [],
    disabled: partial.disabled ?? false,
    status: partial.status ?? null,
    error: partial.error ?? null,
    unreachable: partial.unreachable,
  };
}

function okResult<T>(items: T[], status: number | null, warnings: string[] = []): OpsResult<T> {
  return { items, warnings, unreachable: false, disabled: false, status, error: null };
}

/** Booking answers `{appointments, errors:[{repId,error}]}` — surface the per-rep failures. */
function warningsOf(data: unknown): string[] {
  const list = listOf(data, "errors", "warnings");
  const out: string[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const message = firstString(rec.error, rec.message, rec.reason);
    if (!message) continue;
    const repId = firstString(rec.repId, rec.rep_id);
    out.push(repId ? `${repId}: ${message}` : message);
  }
  return out;
}

// ─── Mappers ─────────────────────────────────────────────────────

/**
 * Progress signal: the brain may report answered questions as an array, a
 * count, or nested under `progress` / `state`. Anything else → null so the
 * panel shows the status instead of inventing a percentage.
 */
function answersCountOf(rec: Record<string, unknown>): number | null {
  const progress = asRecord(rec.progress);
  const state = asRecord(rec.state);
  const candidates: unknown[] = [
    rec.answers,
    progress.answers,
    state.answers,
    rec.answersCount,
    progress.answersCount,
  ];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate.length;
  }
  const n = firstNumber(...candidates);
  return n === undefined ? null : n;
}

function mapFlowRun(item: unknown): FlowRun | null {
  const rec = asRecord(item);
  const context = asRecord(rec.context ?? rec.input ?? rec.payload);
  const id = firstString(rec.id, rec.runId, rec.flowRunId);
  if (!id) return null;

  const routingRec = asRecord(rec.routing);
  const repId = firstString(routingRec.repId, routingRec.rep);
  const link = firstString(routingRec.link, routingRec.url);
  const slots = Array.isArray(routingRec.proposedSlots) ? routingRec.proposedSlots : undefined;
  const routing: FlowRunRouting | undefined =
    repId || link || slots
      ? { repId, proposedSlots: slots, link }
      : undefined;
  const priority = firstString(rec.priority);

  return {
    id,
    flowId: firstString(rec.flowId, rec.flow, rec.workflowId, context.flowId) ?? "flow",
    status: (firstString(rec.status, rec.state) ?? "unknown").toLowerCase(),
    leadKey: firstString(rec.leadKey, rec.lead_key, context.leadKey),
    chatRef: firstString(rec.chatRef, rec.chat_ref, rec.channel, context.chatRef),
    score: firstNumber(rec.score, rec.qualificationScore, context.score),
    tier: firstString(rec.tier, rec.qualificationTier, context.tier),
    priority: priority?.toLowerCase(),
    updatedAt: firstString(rec.updatedAt, rec.updated_at, rec.createdAt, rec.created_at) ?? "",
    routing,
    answersCount: answersCountOf(rec),
    raw: rec,
  };
}

function mapAppointment(item: unknown): Appointment | null {
  const rec = asRecord(item);
  const id = firstString(rec.id, rec.appointmentId);
  if (!id) return null;
  const attendee = asRecord(rec.attendee);
  const context = asRecord(rec.context ?? rec.metadata);

  return {
    id,
    provider: firstString(rec.provider, rec.calendarProvider) ?? "calendar",
    repId: firstString(rec.repId, rec.rep_id, rec.owner) ?? "",
    title: firstString(rec.title, rec.summary, rec.subject),
    attendeeName: firstString(attendee.name, rec.attendeeName, attendee.email) ?? "Unknown",
    attendeeEmail: firstString(attendee.email, rec.attendeeEmail),
    start: firstString(rec.start, rec.startTime, rec.startsAt) ?? "",
    end: firstString(rec.end, rec.endTime, rec.endsAt) ?? "",
    status: (firstString(rec.status, rec.state) ?? "unknown").toLowerCase(),
    leadKey: firstString(rec.leadKey, context.leadKey, context.lead_key),
    raw: rec,
  };
}

// ─── Factory ─────────────────────────────────────────────────────

export function createOpsClient(baseUrl: string = getBrainUrl()): OpsClient {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const enabled = base.length > 0 && base.toLowerCase() !== "none";

  /** GET + JSON parse. Never throws — failures come back as `error`. */
  async function read(action: string, path: string): Promise<{
    data: unknown;
    status: number | null;
    error: string | null;
  }> {
    if (!enabled) {
      return { data: null, status: null, error: OPS_CLIENT_DISABLED };
    }
    try {
      const res = await authFetch(`${base}${path}`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        return {
          data: null,
          status: res.status,
          error: `${action}: ${res.status} ${res.statusText}`.trim(),
        };
      }
      return { data: await res.json(), status: res.status, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "request failed";
      return { data: null, status: null, error: `${action}: ${message}` };
    }
  }

  function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
  }

  return {
    enabled,
    baseUrl: base,

    async listFlowRuns(status?: string, limit = 100): Promise<OpsResult<FlowRun>> {
      const { data, status: httpStatus, error } = await read(
        "listFlowRuns",
        `/flows/runs${query({ status, limit })}`,
      );
      if (error) {
        return emptyResult<FlowRun>({
          unreachable: true,
          disabled: !enabled,
          status: httpStatus,
          error,
        });
      }
      const items = listOf(data, "runs", "flowRuns", "items")
        .map(mapFlowRun)
        .filter((r): r is FlowRun => r !== null);
      return okResult(items, httpStatus);
    },

    async listAppointments(days = 7): Promise<OpsResult<Appointment>> {
      const { data, status: httpStatus, error } = await read(
        "listAppointments",
        `/booking/appointments${query({ days })}`,
      );
      if (error) {
        return emptyResult<Appointment>({
          unreachable: true,
          disabled: !enabled,
          status: httpStatus,
          error,
        });
      }
      const items = listOf(data, "appointments", "items", "bookings")
        .map(mapAppointment)
        .filter((a): a is Appointment => a !== null);
      return okResult(items, httpStatus, warningsOf(data));
    },

    async listAuditKinds(limit = 200): Promise<OpsResult<AuditKindCount>> {
      const { data, status: httpStatus, error } = await read(
        "listAuditKinds",
        `/audit${query({ limit })}`,
      );
      if (error) {
        return emptyResult<AuditKindCount>({
          unreachable: true,
          disabled: !enabled,
          status: httpStatus,
          error,
        });
      }

      const counts = new Map<string, AuditKindCount>();
      for (const item of listOf(data, "entries", "audit", "items")) {
        const rec = asRecord(item);
        const kind = firstString(rec.kind, rec.type) ?? "unknown";
        const ts = firstString(rec.ts, rec.timestamp, rec.at) ?? null;
        const existing = counts.get(kind);
        if (existing) {
          existing.count += 1;
          if (ts && (!existing.lastTs || ts > existing.lastTs)) existing.lastTs = ts;
        } else {
          counts.set(kind, { kind, count: 1, lastTs: ts });
        }
      }
      const items = Array.from(counts.values()).sort(
        (a, b) => b.count - a.count || a.kind.localeCompare(b.kind),
      );
      return okResult(items, httpStatus);
    },
  };
}

/** Default client bound to the runtime BRAIN_URL config. */
export const opsClient: OpsClient = createOpsClient();
