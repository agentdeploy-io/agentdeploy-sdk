/**
 * Lead → rep routing for the qualification-flow engine (flows/runner.ts).
 *
 * RoutingRule rows live in the store cache at "routing:rules" (agentId
 * "booking", seeded empty; CRUD is exposed through the /flows/routing/rules
 * REST routes). routeLead() returns the rep of the FIRST matching enabled
 * rule (all present match criteria must hold), falling back to the policy
 * default: the first enabled rep in the booking registry.
 *
 * Ireland notes:
 *  - eircodePrefixes match the normalized Eircode (uppercase, spaces
 *    stripped) via startsWith — a routing key like "D15" covers the whole
 *    Dublin-15 district, "A65" covers a county-ish routing prefix;
 *  - slot proposals are computed IN-PROCESS (no HTTP hop) with the shared
 *    scheduling.findSlots math in the rep's timezone (Europe/Dublin default),
 *    using provider free-busy when the rep's calendar is connected, else
 *    work-hours-only slots marked `provisional`;
 *  - Calendly reps have no API availability: routing.link = schedulingLink
 *    and the conversation sends the link (the webhook mirrors the booking).
 *
 * Audit + edge notification for routing decisions are emitted by the CALLER
 * (flows/runner.ts) so all flow.* audit kinds stay under agentId "flows".
 */
import { randomBytes } from "node:crypto";
import type { CallaStore } from "../store/types.js";
import { getFreshConnection, readBookingConfig } from "./oauth.js";
import { googleBusy } from "./providers/google.js";
import { msGetSchedule } from "./providers/microsoft.js";
import { findAvailableSlots } from "./scheduling.js";
import { BOOKING_CACHE_AGENT, BookingStore, DEFAULT_TIMEZONE } from "./store.js";
import type { Rep, Slot } from "./types.js";

export const ROUTING_RULES_KEY = "routing:rules";

/** How many slots to propose in a routing notification (today/tomorrow window). */
export const PROPOSED_SLOT_COUNT = 3;
/** Proposal window: now → +48h ("today/tomorrow" inside work hours). */
export const PROPOSAL_WINDOW_MS = 48 * 60 * 60 * 1000;

export interface RoutingMatch {
  /** Normalized-Eircode startsWith prefixes (e.g. ["D15", "A65"]). */
  eircodePrefixes?: string[];
  country?: string;
  source?: string;
  tier?: "hot" | "warm" | "cold";
  vertical?: string;
}

export interface RoutingRule {
  id: string;
  match: RoutingMatch;
  repId: string;
  branchName?: string;
  /** Default true. */
  enabled?: boolean;
}

export interface RouteLeadContext {
  eircode?: string;
  country?: string;
  source?: string;
  tier?: "hot" | "warm" | "cold";
  vertical?: string;
}

// ─── Rule validation / persistence ───────────────────────────────

const RULE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

function isRuleShape(raw: unknown): raw is RoutingRule {
  const r = raw as RoutingRule | null;
  return Boolean(
    r &&
      typeof r === "object" &&
      typeof r.id === "string" &&
      typeof r.repId === "string" &&
      r.match &&
      typeof r.match === "object",
  );
}

/** Validate/normalize a routing-rule payload; returns the rule or an error string. */
export function validateRoutingRule(raw: unknown, reps: Rep[]): RoutingRule | string {
  if (!raw || typeof raw !== "object") return "rule must be a JSON object";
  const b = raw as Record<string, any>;
  const repId = String(b.repId ?? "").trim();
  if (!repId) return "repId is required";
  if (!reps.some((r) => r.id === repId)) return `unknown rep: ${repId}`;

  const id = String(b.id ?? "").trim() || `rule-${randomBytes(3).toString("hex")}`;
  if (!RULE_ID_RE.test(id)) {
    return `invalid rule id "${id}": lowercase letters, numbers and hyphens only (≤64)`;
  }
  if (!b.match || typeof b.match !== "object") return "match is required (object)";
  const m = b.match as Record<string, any>;
  const match: RoutingMatch = {};
  if (m.eircodePrefixes !== undefined) {
    if (!Array.isArray(m.eircodePrefixes) || m.eircodePrefixes.length === 0) {
      return "match.eircodePrefixes must be a non-empty array of strings";
    }
    match.eircodePrefixes = m.eircodePrefixes
      .map((p: unknown) => normalizeEircode(String(p)))
      .filter(Boolean);
    if (match.eircodePrefixes.length === 0) return "match.eircodePrefixes must be non-empty";
  }
  if (m.country !== undefined) match.country = String(m.country).trim().toLowerCase();
  if (m.source !== undefined) match.source = String(m.source).trim().toLowerCase();
  if (m.tier !== undefined) {
    if (!["hot", "warm", "cold"].includes(String(m.tier))) {
      return 'match.tier must be "hot" | "warm" | "cold"';
    }
    match.tier = m.tier;
  }
  if (m.vertical !== undefined) match.vertical = String(m.vertical).trim().toLowerCase();
  if (Object.keys(match).length === 0) {
    return "match needs at least one criterion (eircodePrefixes, country, source, tier, vertical)";
  }

  const rule: RoutingRule = { id, match, repId };
  if (b.branchName != null) rule.branchName = String(b.branchName).slice(0, 120);
  if (b.enabled !== undefined) rule.enabled = Boolean(b.enabled);
  return rule;
}

export async function listRoutingRules(store: CallaStore): Promise<RoutingRule[]> {
  const raw = await store
    .cacheGet<unknown>(ROUTING_RULES_KEY, BOOKING_CACHE_AGENT)
    .catch(() => null);
  return Array.isArray(raw) ? raw.filter(isRuleShape) : [];
}

async function saveRoutingRules(store: CallaStore, rules: RoutingRule[]): Promise<void> {
  await store.cacheSet(ROUTING_RULES_KEY, BOOKING_CACHE_AGENT, rules, null);
}

/** Idempotent bootstrap: ensure the (empty) rules key exists. */
export async function seedRoutingRules(store: CallaStore): Promise<void> {
  const raw = await store.cacheGet<unknown>(ROUTING_RULES_KEY, BOOKING_CACHE_AGENT).catch(() => null);
  if (!Array.isArray(raw)) await saveRoutingRules(store, []);
}

export async function createRoutingRule(
  store: CallaStore,
  raw: unknown,
): Promise<[RoutingRule | null, string | null]> {
  const bs = new BookingStore(store);
  const reps = await bs.listReps();
  const rule = validateRoutingRule(raw, reps);
  if (typeof rule === "string") return [null, rule];
  const rules = await listRoutingRules(store);
  if (rules.some((r) => r.id === rule.id)) {
    return [null, `duplicate: routing rule "${rule.id}" already exists`];
  }
  rules.push(rule);
  await saveRoutingRules(store, rules);
  return [rule, null];
}

export async function deleteRoutingRule(
  store: CallaStore,
  id: string,
): Promise<RoutingRule | null> {
  const rules = await listRoutingRules(store);
  const removed = rules.find((r) => r.id === id) ?? null;
  if (!removed) return null;
  await saveRoutingRules(
    store,
    rules.filter((r) => r.id !== id),
  );
  return removed;
}

// ─── Matching ────────────────────────────────────────────────────

/** Uppercase + strip spaces so "d15 xy23" and "D15" compare cleanly. */
export function normalizeEircode(value: string): string {
  return String(value ?? "").toUpperCase().replace(/\s+/g, "");
}

function ruleMatches(rule: RoutingRule, ctx: RouteLeadContext): boolean {
  if (rule.enabled === false) return false;
  const m = rule.match;
  if (m.eircodePrefixes && m.eircodePrefixes.length > 0) {
    const eircode = normalizeEircode(ctx.eircode ?? "");
    if (!eircode) return false;
    if (!m.eircodePrefixes.some((p) => eircode.startsWith(normalizeEircode(p)))) return false;
  }
  if (m.country && String(ctx.country ?? "").trim().toLowerCase() !== m.country) return false;
  if (m.source && String(ctx.source ?? "").trim().toLowerCase() !== m.source) return false;
  if (m.tier && ctx.tier !== m.tier) return false;
  if (m.vertical && String(ctx.vertical ?? "").trim().toLowerCase() !== m.vertical) return false;
  return true;
}

export interface RouteLeadResult {
  rep: Rep;
  /** Null-ish when the policy default (first enabled rep) was used. */
  ruleId?: string;
}

/**
 * First matching enabled rule whose rep is enabled; else the policy default
 * (first enabled rep); else null (no bookable capacity — caller tags only).
 */
export async function routeLead(
  store: CallaStore,
  ctx: RouteLeadContext,
): Promise<RouteLeadResult | null> {
  const bs = new BookingStore(store);
  const reps = await bs.listReps();
  const enabledReps = reps.filter((r) => r.enabled);
  if (enabledReps.length === 0) return null;

  const rules = await listRoutingRules(store);
  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) continue;
    const rep = enabledReps.find((r) => r.id === rule.repId);
    if (rep) return { rep, ruleId: rule.id };
    // Rule points at a disabled/removed rep → keep scanning (never dead-end).
  }
  return { rep: enabledReps[0] };
}

// ─── Slot proposals (in-process availability) ────────────────────

export interface ProposedSlot extends Slot {
  /** true when computed from work hours only (calendar not connected). */
  provisional?: boolean;
}

export interface SlotProposal {
  /** Calendly reps: the scheduling link (slots stay empty). */
  link?: string;
  slots: ProposedSlot[];
  provisional: boolean;
  timezone: string;
}

/**
 * Next PROPOSED_SLOT_COUNT slots for a rep inside the today/tomorrow window:
 *  - calendly            → { link: schedulingLink } (no API availability);
 *  - google/microsoft connected → provider free-busy + shared slot finder;
 *  - not connected / provider failure → work-hours-only slots, provisional.
 * Never throws.
 */
export async function proposeSlotsForRep(
  store: CallaStore,
  rep: Rep,
  now: Date = new Date(),
): Promise<SlotProposal> {
  const bs = new BookingStore(store);
  const policy = await bs.getPolicy();
  const timezone = rep.timezone ?? policy.timezone ?? DEFAULT_TIMEZONE;
  const slotMinutes = rep.slotMinutes ?? policy.slotMinutes;
  const bufferMinutes = rep.bufferMinutes ?? policy.bufferMinutes;
  const workHours = rep.workHours ?? policy.workHours;
  const from = now.toISOString();
  const to = new Date(now.getTime() + PROPOSAL_WINDOW_MS).toISOString();

  if (rep.provider === "calendly") {
    return {
      ...(rep.schedulingLink ? { link: rep.schedulingLink } : {}),
      slots: [],
      provisional: false,
      timezone,
    };
  }

  const slotInput = {
    from,
    to,
    workHours,
    slotMinutes,
    bufferMinutes,
    timezone,
    maxPerDay: policy.maxBookingsPerDay,
  };

  if (rep.accountId) {
    try {
      const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
      if (fresh.ok) {
        const cfg = readBookingConfig();
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
                slotMinutes,
              );
        const slots = findAvailableSlots({ ...slotInput, busy }).slice(0, PROPOSED_SLOT_COUNT);
        return { slots, provisional: false, timezone };
      }
    } catch (err) {
      console.warn(
        `[booking:routing] provider availability failed for rep "${rep.id}" — proposing provisional slots:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  // Not connected (or provider error) → work-hours-only, flagged provisional.
  const slots = findAvailableSlots({ ...slotInput, busy: [] })
    .slice(0, PROPOSED_SLOT_COUNT)
    .map((s) => ({ ...s, provisional: true }));
  return { slots, provisional: true, timezone };
}

/** Human slot label in the rep's timezone, e.g. "Tue 14 Oct, 14:30". */
export function formatSlotLocal(startIso: string, timezone: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(startIso));
  } catch {
    return startIso;
  }
}

/**
 * Build the conversational booking proposal for a routed lead.
 *  - calendly link → "…book a time that suits here: <link>"
 *  - ≥2 slots      → "Would <slot1> or <slot2> suit?" (slots marked
 *                    provisional internally; the text stays the same — the
 *                    human confirms before POST /flows/runs/:id/book)
 *  - 0 slots       → advisor-will-be-in-touch fallback.
 */
export function buildBookingProposalText(proposal: SlotProposal, repName?: string): string {
  const who = repName ? ` with ${repName}` : "";
  if (proposal.link) {
    return `Great news — we can arrange your survey${who}. Book a time that suits you here: ${proposal.link}`;
  }
  const labels = proposal.slots.map((s) => formatSlotLocal(s.start, proposal.timezone));
  if (labels.length >= 2) {
    return `Great news — we can arrange your survey${who}. Would ${labels[0]} or ${labels[1]} suit?`;
  }
  if (labels.length === 1) {
    return `Great news — we can arrange your survey${who}. Would ${labels[0]} suit?`;
  }
  return `Thanks — that's everything we need. One of our surveyors${who ? ` (${repName})` : ""} will be in touch shortly to arrange your survey.`;
}
