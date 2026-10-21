/**
 * Booking persistence — built ONLY on CallaStore.cacheGet/cacheSet (+
 * appendAudit for the trail), following the channels/bindings.ts pattern.
 * The cache has no scan, so listable collections live under their own keys.
 *
 * Cache keys (agentId "booking"):
 *   booking:reps                 -> Rep[]                     (no TTL)
 *   booking:policy               -> BookingPolicy             (no TTL)
 *   conn:<provider>:<accountId>  -> ConnectionRecord          (no TTL)
 *   booking:conn:index           -> {provider, accountId}[]   (no TTL)
 *   booking:oauth:state:<state>  -> OAuthStateRecord          (10-min TTL)
 *   booking:calendly:invitees    -> Appointment[] (capped 500, no TTL)
 *
 * Audit kinds (hash-chained, agentId "booking"):
 *   booking.connected / booking.created / booking.cancelled / booking.webhook
 */
import { randomBytes } from "node:crypto";
import type { CallaStore } from "../store/types.js";
import type {
  Appointment,
  BookingPolicy,
  BookingProvider,
  ConnectionRecord,
  OAuthStateRecord,
  Rep,
  WorkHours,
} from "./types.js";
import { parseHHMM } from "./scheduling.js";

/** All booking cache rows share this agentId (the cache PK is (key, agentId)). */
export const BOOKING_CACHE_AGENT = "booking";

const REPS_KEY = "booking:reps";
const POLICY_KEY = "booking:policy";
const CONN_PREFIX = "conn:";
const CONN_INDEX_KEY = "booking:conn:index";
const STATE_PREFIX = "booking:oauth:state:";
const INVITEES_KEY = "booking:calendly:invitees";

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INVITEES_CAP = 500;
const REP_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TIME_RE = /^\d{2}:\d{2}$/;

export const DEFAULT_TIMEZONE = "Europe/Dublin";

export const DEFAULT_WORK_HOURS: WorkHours = {
  days: [1, 2, 3, 4, 5],
  start: "09:00",
  end: "17:30",
};

export const DEFAULT_POLICY: BookingPolicy = {
  slotMinutes: 45,
  bufferMinutes: 15,
  workHours: DEFAULT_WORK_HOURS,
  timezone: DEFAULT_TIMEZONE,
  maxBookingsPerDay: null,
};

export type BookingAuditKind =
  | "booking.connected"
  | "booking.created"
  | "booking.cancelled"
  | "booking.webhook";

// ─── Validation ──────────────────────────────────────────────────

/** Validate/normalize work hours; returns an error string or null. */
export function validateWorkHours(raw: unknown): WorkHours | string {
  if (raw === undefined || raw === null) return { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] };
  if (typeof raw !== "object" || raw === null) return "workHours must be an object";
  const wh = raw as Partial<WorkHours>;
  const days = wh.days ?? DEFAULT_WORK_HOURS.days;
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6) ||
    new Set(days).size !== days.length
  ) {
    return "workHours.days must be a unique array of integers 0-6 (1 = Monday … 5 = Friday)";
  }
  const start = wh.start ?? DEFAULT_WORK_HOURS.start;
  const end = wh.end ?? DEFAULT_WORK_HOURS.end;
  if (typeof start !== "string" || !TIME_RE.test(start) || typeof end !== "string" || !TIME_RE.test(end)) {
    return 'workHours.start/end must be "HH:MM" strings';
  }
  try {
    const [sh, sm] = parseHHMM(start);
    const [eh, em] = parseHHMM(end);
    if (eh * 60 + em <= sh * 60 + sm) return "workHours.end must be after workHours.start";
  } catch (err) {
    return err instanceof Error ? err.message : "invalid workHours";
  }
  return { days: [...days].sort((a, b) => a - b), start, end };
}

function positiveInt(raw: unknown, min: number, max: number, fallback: number): number | string {
  if (raw === undefined || raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `expected an integer between ${min} and ${max}, got ${String(raw)}`;
  }
  return n;
}

export interface RepInput {
  id?: string;
  name: string;
  email: string;
  provider: BookingProvider;
  accountId?: string;
  schedulingLink?: string;
  eventTypeUri?: string;
  timezone?: string;
  workHours?: WorkHours;
  slotMinutes?: number;
  bufferMinutes?: number;
  enabled?: boolean;
}

/** Validate/normalize a rep payload; returns the Rep or an error string. */
export function normalizeRep(input: RepInput, generatedId: string): Rep | string {
  const name = String(input.name ?? "").trim();
  if (!name || name.length > 120) return "name is required (≤120 chars)";
  const email = String(input.email ?? "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return "a valid email is required";

  const id = String(input.id ?? "").trim() || generatedId;
  if (!REP_ID_RE.test(id)) {
    return `invalid rep id "${id}": lowercase letters, numbers and hyphens only (≤64)`;
  }

  const workHours = validateWorkHours(input.workHours);
  if (typeof workHours === "string") return workHours;

  const slotMinutes = positiveInt(input.slotMinutes, 5, 480, DEFAULT_POLICY.slotMinutes);
  if (typeof slotMinutes === "string") return `slotMinutes: ${slotMinutes}`;
  const bufferMinutes = positiveInt(input.bufferMinutes, 0, 240, DEFAULT_POLICY.bufferMinutes);
  if (typeof bufferMinutes === "string") return `bufferMinutes: ${bufferMinutes}`;

  const timezone = String(input.timezone ?? "").trim() || DEFAULT_TIMEZONE;
  try {
    // Throws RangeError for unknown IANA zones.
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    return `unknown timezone "${timezone}" (expected an IANA zone like Europe/Dublin)`;
  }

  const rep: Rep = {
    id,
    name,
    email,
    provider: input.provider,
    timezone,
    workHours,
    slotMinutes,
    bufferMinutes,
    enabled: input.enabled ?? true,
  };
  const accountId = String(input.accountId ?? "").trim();
  if (accountId) rep.accountId = accountId;
  const schedulingLink = String(input.schedulingLink ?? "").trim();
  if (schedulingLink) {
    if (!/^https?:\/\//i.test(schedulingLink)) return "schedulingLink must be an http(s) URL";
    rep.schedulingLink = schedulingLink;
  }
  const eventTypeUri = String(input.eventTypeUri ?? "").trim();
  if (eventTypeUri) rep.eventTypeUri = eventTypeUri;
  return rep;
}

/** Validate/normalize a policy payload; returns the policy or an error string. */
export function normalizePolicy(input: Partial<BookingPolicy>): BookingPolicy | string {
  const workHours = validateWorkHours(input.workHours ?? DEFAULT_POLICY.workHours);
  if (typeof workHours === "string") return workHours;
  const slotMinutes = positiveInt(input.slotMinutes, 5, 480, DEFAULT_POLICY.slotMinutes);
  if (typeof slotMinutes === "string") return `slotMinutes: ${slotMinutes}`;
  const bufferMinutes = positiveInt(input.bufferMinutes, 0, 240, DEFAULT_POLICY.bufferMinutes);
  if (typeof bufferMinutes === "string") return `bufferMinutes: ${bufferMinutes}`;

  let maxBookingsPerDay: number | null = DEFAULT_POLICY.maxBookingsPerDay;
  if (input.maxBookingsPerDay !== undefined && input.maxBookingsPerDay !== null) {
    const n = positiveInt(input.maxBookingsPerDay, 1, 100, DEFAULT_POLICY.slotMinutes);
    if (typeof n === "string") return `maxBookingsPerDay: ${n}`;
    maxBookingsPerDay = n;
  }

  const timezone = String(input.timezone ?? "").trim() || DEFAULT_POLICY.timezone;
  try {
    new Intl.DateTimeFormat("en-GB", { timeZone: timezone });
  } catch {
    return `unknown timezone "${timezone}" (expected an IANA zone like Europe/Dublin)`;
  }

  return { slotMinutes, bufferMinutes, workHours, timezone, maxBookingsPerDay };
}

function isRepShape(raw: unknown): raw is Rep {
  const r = raw as Rep | null;
  return Boolean(
    r &&
      typeof r === "object" &&
      typeof r.id === "string" &&
      typeof r.name === "string" &&
      typeof r.email === "string" &&
      (r.provider === "calendly" || r.provider === "google" || r.provider === "microsoft") &&
      typeof r.workHours === "object" &&
      r.workHours !== null,
  );
}

function isConnectionShape(raw: unknown): raw is ConnectionRecord {
  const c = raw as ConnectionRecord | null;
  return Boolean(
    c &&
      typeof c === "object" &&
      (c.provider === "google" || c.provider === "microsoft" || c.provider === "calendly") &&
      typeof c.accountId === "string" &&
      typeof c.accessToken === "string",
  );
}

function isAppointmentShape(raw: unknown): raw is Appointment {
  const a = raw as Appointment | null;
  return Boolean(
    a &&
      typeof a === "object" &&
      typeof a.id === "string" &&
      typeof a.repId === "string" &&
      typeof a.start === "string" &&
      typeof a.end === "string" &&
      typeof a.attendee === "object" &&
      a.attendee !== null,
  );
}

function slugId(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return `${slug || "rep"}-${randomBytes(3).toString("hex")}`;
}

// ─── Store ───────────────────────────────────────────────────────

export class BookingStore {
  constructor(private readonly store: CallaStore) {}

  // ── Reps ──────────────────────────────────────────────────────

  async listReps(): Promise<Rep[]> {
    const raw = await this.store
      .cacheGet<unknown>(REPS_KEY, BOOKING_CACHE_AGENT)
      .catch(() => null);
    return Array.isArray(raw) ? raw.filter(isRepShape) : [];
  }

  async getRep(repId: string): Promise<Rep | null> {
    const reps = await this.listReps();
    return reps.find((r) => r.id === repId) ?? null;
  }

  /** Create a rep (validates + generates the id). Returns [rep] or [null, error]. */
  async createRep(input: RepInput): Promise<[Rep | null, string | null]> {
    const generatedId = slugId(String(input.name ?? "rep"));
    const normalized = normalizeRep({ ...input, ...(input.id ? { id: input.id } : {}) }, generatedId);
    if (typeof normalized === "string") return [null, normalized];
    const reps = await this.listReps();
    if (reps.some((r) => r.id === normalized.id)) {
      return [null, `rep "${normalized.id}" already exists (PUT to update)`];
    }
    reps.push(normalized);
    await this.store.cacheSet(REPS_KEY, BOOKING_CACHE_AGENT, reps, null);
    return [normalized, null];
  }

  /** Update an existing rep; returns [rep] or [null, error]. */
  async updateRep(
    repId: string,
    patch: Partial<RepInput>,
  ): Promise<[Rep | null, string | null]> {
    const reps = await this.listReps();
    const idx = reps.findIndex((r) => r.id === repId);
    if (idx < 0) return [null, `unknown rep: ${repId}`];
    const merged: RepInput = {
      id: repId,
      name: patch.name ?? reps[idx].name,
      email: patch.email ?? reps[idx].email,
      provider: reps[idx].provider,
      accountId: patch.accountId ?? reps[idx].accountId,
      schedulingLink: patch.schedulingLink ?? reps[idx].schedulingLink,
      eventTypeUri: patch.eventTypeUri ?? reps[idx].eventTypeUri,
      timezone: patch.timezone ?? reps[idx].timezone,
      workHours: patch.workHours ?? reps[idx].workHours,
      slotMinutes: patch.slotMinutes ?? reps[idx].slotMinutes,
      bufferMinutes: patch.bufferMinutes ?? reps[idx].bufferMinutes,
      enabled: patch.enabled ?? reps[idx].enabled,
    };
    const normalized = normalizeRep(merged, repId);
    if (typeof normalized === "string") return [null, normalized];
    reps[idx] = normalized;
    await this.store.cacheSet(REPS_KEY, BOOKING_CACHE_AGENT, reps, null);
    return [normalized, null];
  }

  async deleteRep(repId: string): Promise<Rep | null> {
    const reps = await this.listReps();
    const removed = reps.find((r) => r.id === repId) ?? null;
    if (!removed) return null;
    await this.store.cacheSet(
      REPS_KEY,
      BOOKING_CACHE_AGENT,
      reps.filter((r) => r.id !== repId),
      null,
    );
    return removed;
  }

  // ── Policy ────────────────────────────────────────────────────

  async getPolicy(): Promise<BookingPolicy> {
    const raw = await this.store
      .cacheGet<Partial<BookingPolicy>>(POLICY_KEY, BOOKING_CACHE_AGENT)
      .catch(() => null);
    if (!raw || typeof raw !== "object") return { ...DEFAULT_POLICY, workHours: { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] } };
    const normalized = normalizePolicy(raw);
    return typeof normalized === "string"
      ? { ...DEFAULT_POLICY, workHours: { ...DEFAULT_WORK_HOURS, days: [...DEFAULT_WORK_HOURS.days] } }
      : normalized;
  }

  /** Merge-update the policy; returns [policy] or [null, error]. */
  async putPolicy(patch: Partial<BookingPolicy>): Promise<[BookingPolicy | null, string | null]> {
    const current = await this.getPolicy();
    const normalized = normalizePolicy({ ...current, ...patch });
    if (typeof normalized === "string") return [null, normalized];
    await this.store.cacheSet(POLICY_KEY, BOOKING_CACHE_AGENT, normalized, null);
    return [normalized, null];
  }

  // ── Connections ───────────────────────────────────────────────

  private connKey(provider: string, accountId: string): string {
    return `${CONN_PREFIX}${provider}:${accountId}`;
  }

  async getConnection(provider: string, accountId: string): Promise<ConnectionRecord | null> {
    const raw = await this.store
      .cacheGet<unknown>(this.connKey(provider, accountId), BOOKING_CACHE_AGENT)
      .catch(() => null);
    return isConnectionShape(raw) ? raw : null;
  }

  async putConnection(conn: ConnectionRecord): Promise<void> {
    await this.store.cacheSet(
      this.connKey(conn.provider, conn.accountId),
      BOOKING_CACHE_AGENT,
      conn,
      null,
    );
    const index =
      (await this.store
        .cacheGet<{ provider: string; accountId: string }[]>(CONN_INDEX_KEY, BOOKING_CACHE_AGENT)
        .catch(() => null)) ?? [];
    const exists = index.some(
      (e) => e.provider === conn.provider && e.accountId === conn.accountId,
    );
    if (!exists) {
      index.push({ provider: conn.provider, accountId: conn.accountId });
      await this.store.cacheSet(CONN_INDEX_KEY, BOOKING_CACHE_AGENT, index, null);
    }
  }

  async listConnections(): Promise<ConnectionRecord[]> {
    const index =
      (await this.store
        .cacheGet<{ provider: string; accountId: string }[]>(CONN_INDEX_KEY, BOOKING_CACHE_AGENT)
        .catch(() => null)) ?? [];
    const out: ConnectionRecord[] = [];
    for (const entry of index) {
      const conn = await this.getConnection(entry.provider, entry.accountId);
      if (conn) out.push(conn);
    }
    return out;
  }

  // ── OAuth state (10-min TTL, single-use) ─────────────────────

  async putState(state: string, record: OAuthStateRecord): Promise<void> {
    await this.store.cacheSet(
      `${STATE_PREFIX}${state}`,
      BOOKING_CACHE_AGENT,
      record,
      STATE_TTL_MS,
    );
  }

  /** Read + immediately expire a state record (single use). */
  async consumeState(state: string): Promise<OAuthStateRecord | null> {
    const key = `${STATE_PREFIX}${state}`;
    const raw = await this.store
      .cacheGet<OAuthStateRecord>(key, BOOKING_CACHE_AGENT)
      .catch(() => null);
    if (
      !raw ||
      typeof raw !== "object" ||
      typeof raw.repId !== "string" ||
      typeof raw.provider !== "string"
    ) {
      return null;
    }
    await this.store.cacheSet(key, BOOKING_CACHE_AGENT, null, 1).catch(() => {});
    return raw;
  }

  // ── Calendly invitees (capped mirror of webhook appointments) ─

  async listInvitees(): Promise<Appointment[]> {
    const raw = await this.store
      .cacheGet<unknown>(INVITEES_KEY, BOOKING_CACHE_AGENT)
      .catch(() => null);
    return Array.isArray(raw) ? raw.filter(isAppointmentShape) : [];
  }

  /** Upsert (by appointment id) and keep the newest INVITEES_CAP entries. */
  async saveInvitee(appointment: Appointment): Promise<void> {
    const list = await this.listInvitees();
    const idx = list.findIndex((a) => a.id === appointment.id && a.provider === "calendly");
    if (idx >= 0) list[idx] = appointment;
    else list.push(appointment);
    const capped = list.slice(-INVITEES_CAP);
    await this.store.cacheSet(INVITEES_KEY, BOOKING_CACHE_AGENT, capped, null);
  }

  // ── Audit (hash-chained) ──────────────────────────────────────

  async audit(kind: BookingAuditKind, entry: Record<string, unknown>): Promise<void> {
    await this.store
      .appendAudit({ agentId: BOOKING_CACHE_AGENT, kind, entry })
      .catch((err) => console.error(`[booking] audit ${kind} failed:`, err));
  }
}
