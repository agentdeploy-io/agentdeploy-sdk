/**
 * Flow persistence — built ONLY on CallaStore.cacheGet/cacheSet (+
 * appendAudit), following the booking/store.ts pattern. The cache has no
 * scan, so listable collections live under their own keys.
 *
 * Cache keys (agentId "flows"):
 *   flows:defs                        -> Record<id, FlowDefinition>  (CUSTOM defs only;
 *                                          builtins are versioned in code and merged on read)
 *   flow:run:<id>                     -> FlowRun                     (no TTL)
 *   flow:runs:index                   -> FlowRunIndexEntry[]         (capped 200, newest first)
 *   flow:active:<channel>:<chatRef>   -> runId                       (TTL 48h; cleared on
 *                                          complete/cancel — routes subsequent channel
 *                                          messages into the runner)
 *
 * Audit kinds (hash-chained, agentId "flows"):
 *   flow.started / flow.completed / flow.abandoned / flow.urgent /
 *   flow.routed / flow.booked / flow.definition_created /
 *   flow.definition_updated / flow.definition_deleted / flow.routing_rule_*
 */
import { randomBytes } from "node:crypto";
import type { CallaStore } from "../store/types.js";
import { BUILTIN_FLOWS, BUILTIN_FLOW_IDS } from "./definitions.js";
import type {
  FlowDefinition,
  FlowField,
  FlowRun,
  FlowRunIndexEntry,
  FlowScoreRule,
} from "./types.js";

/** All flow cache rows share this agentId (cache PK is (key, agentId)). */
export const FLOWS_CACHE_AGENT = "flows";

const DEFS_KEY = "flows:defs";
const RUN_PREFIX = "flow:run:";
const RUNS_INDEX_KEY = "flow:runs:index";
const ACTIVE_PREFIX = "flow:active:";

/** Active-run lookups expire after 48h (a stalled chat is abandoned). */
export const ACTIVE_RUN_TTL_MS = 48 * 60 * 60 * 1000;
export const RUNS_INDEX_CAP = 200;

export const FLOW_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const FIELD_NAME_RE = /^[a-z0-9][a-z0-9_]{0,63}$/;

const FIELD_TYPES = ["choice", "yesno", "text", "number", "email", "eircode"] as const;
const VERTICALS = ["retrofit", "property", "generic"] as const;

export type FlowAuditKind =
  | "flow.started"
  | "flow.completed"
  | "flow.abandoned"
  | "flow.urgent"
  | "flow.routed"
  | "flow.booked"
  | "flow.definition_created"
  | "flow.definition_updated"
  | "flow.definition_deleted"
  | "flow.routing_rule_created"
  | "flow.routing_rule_deleted"
  | "flow.error";

// ─── Validation helpers ──────────────────────────────────────────

function isField(raw: unknown): raw is FlowField {
  return Boolean(raw && typeof raw === "object");
}

/**
 * Validate/normalize a flow definition payload (custom flows + builtin
 * re-validation on read). Returns the FlowDefinition or an error string.
 */
export function validateFlowDefinition(raw: unknown): FlowDefinition | string {
  if (!raw || typeof raw !== "object") return "definition must be a JSON object";
  const b = raw as Record<string, any>;

  const id = String(b.id ?? "").trim();
  if (!FLOW_ID_RE.test(id)) {
    return `invalid flow id "${id}": lowercase letters, numbers and hyphens only (≤64)`;
  }
  const name = String(b.name ?? "").trim();
  if (!name || name.length > 120) return "name is required (≤120 chars)";
  const description = String(b.description ?? "").trim();
  if (description.length > 1000) return "description must be ≤1000 chars";
  const vertical = b.vertical ?? "generic";
  if (!(VERTICALS as readonly string[]).includes(String(vertical))) {
    return `vertical must be one of ${VERTICALS.join(", ")}`;
  }

  if (!Array.isArray(b.fields) || b.fields.length === 0 || b.fields.length > 40) {
    return "fields must be a non-empty array (≤40)";
  }
  const fields: FlowField[] = [];
  const seenFields = new Set<string>();
  for (const rawField of b.fields) {
    if (!isField(rawField)) return "each field must be an object";
    const f = rawField as Record<string, any>;
    const fname = String(f.name ?? "").trim();
    if (!FIELD_NAME_RE.test(fname)) {
      return `invalid field name "${fname}": lowercase letters, numbers and underscores only`;
    }
    if (seenFields.has(fname)) return `duplicate field name: ${fname}`;
    seenFields.add(fname);
    const type = String(f.type ?? "");
    if (!(FIELD_TYPES as readonly string[]).includes(type)) {
      return `field "${fname}": type must be one of ${FIELD_TYPES.join(", ")}`;
    }
    const question = String(f.question ?? "").trim();
    if (!question || question.length > 500) return `field "${fname}": question is required (≤500 chars)`;

    const field: FlowField = { name: fname, question, type: type as FlowField["type"] };
    if (type === "choice") {
      if (!Array.isArray(f.options) || f.options.length < 2 || f.options.length > 12) {
        return `field "${fname}": choice type requires 2-12 string options`;
      }
      const options = f.options.map((o: unknown) => String(o).trim()).filter(Boolean);
      if (options.length < 2) return `field "${fname}": options must be non-empty strings`;
      field.options = options;
    }
    if (f.required !== undefined) field.required = Boolean(f.required);
    if (f.optionalHint != null) field.optionalHint = String(f.optionalHint).slice(0, 200);
    if (f.skipIf != null) {
      if (typeof f.skipIf !== "object" || typeof f.skipIf.field !== "string" || typeof f.skipIf.equals !== "string") {
        return `field "${fname}": skipIf must be { field, equals } with string values`;
      }
      field.skipIf = { field: String(f.skipIf.field), equals: String(f.skipIf.equals) };
    }
    fields.push(field);
  }
  // skipIf targets must exist and appear EARLIER (no forward references).
  for (let i = 0; i < fields.length; i++) {
    const skipIf = fields[i].skipIf;
    if (!skipIf) continue;
    const target = fields.findIndex((f) => f.name === skipIf.field);
    if (target < 0 || target >= i) {
      return `field "${fields[i].name}": skipIf.field must reference an earlier field`;
    }
  }

  const scoring: FlowScoreRule[] = [];
  if (b.scoring !== undefined) {
    if (!Array.isArray(b.scoring) || b.scoring.length > 60) {
      return "scoring must be an array (≤60 rules)";
    }
    for (const rawRule of b.scoring) {
      if (!rawRule || typeof rawRule !== "object") return "each scoring rule must be an object";
      const r = rawRule as Record<string, any>;
      const field = String(r.field ?? "");
      if (!seenFields.has(field)) return `scoring rule references unknown field "${field}"`;
      const weight = Number(r.weight);
      if (!Number.isFinite(weight)) return `scoring rule for "${field}": weight must be a number`;
      const rule: FlowScoreRule = { field, weight };
      const hasEq = r.equals !== undefined;
      const hasIn = Array.isArray(r.in);
      const hasMin = r.min !== undefined;
      if (!hasEq && !hasIn && !hasMin) {
        return `scoring rule for "${field}": one of equals/in/min is required`;
      }
      if (hasEq) rule.equals = typeof r.equals === "number" ? r.equals : String(r.equals);
      if (hasIn) rule.in = r.in.map((v: unknown) => (typeof v === "number" ? v : String(v)));
      if (hasMin) {
        const min = Number(r.min);
        if (!Number.isFinite(min)) return `scoring rule for "${field}": min must be a number`;
        rule.min = min;
      }
      scoring.push(rule);
    }
  }

  const tiers = {
    hot: Number(b.tiers?.hot ?? 60),
    warm: Number(b.tiers?.warm ?? 35),
  };
  if (!Number.isFinite(tiers.hot) || !Number.isFinite(tiers.warm) || tiers.hot <= tiers.warm) {
    return "tiers must be { hot, warm } numbers with hot > warm";
  }

  if (!b.outcome || typeof b.outcome !== "object") return "outcome is required";
  const onComplete = String(b.outcome.onComplete ?? "tag");
  if (onComplete !== "route" && onComplete !== "tag") {
    return 'outcome.onComplete must be "route" or "tag"';
  }
  const outcome: FlowDefinition["outcome"] = { onComplete };
  if (b.outcome.bookingIntent != null) {
    const bi = b.outcome.bookingIntent;
    if (typeof bi !== "object" || typeof bi.field !== "string" || bi.equals === undefined) {
      return "outcome.bookingIntent must be { field, equals }";
    }
    if (!seenFields.has(String(bi.field))) {
      return `outcome.bookingIntent references unknown field "${bi.field}"`;
    }
    outcome.bookingIntent = {
      field: String(bi.field),
      equals: typeof bi.equals === "number" ? bi.equals : String(bi.equals),
    };
  }
  if (b.outcome.sequenceTag != null) {
    outcome.sequenceTag = String(b.outcome.sequenceTag).slice(0, 80);
  }

  const triggerKeywords = Array.isArray(b.triggerKeywords)
    ? b.triggerKeywords.map((k: unknown) => String(k)).slice(0, 20)
    : undefined;

  const def: FlowDefinition = {
    id,
    name,
    vertical: vertical as FlowDefinition["vertical"],
    description,
    ...(triggerKeywords ? { triggerKeywords } : {}),
    fields,
    scoring,
    tiers,
    outcome,
  };
  return def;
}

function isRunShape(raw: unknown): raw is FlowRun {
  const r = raw as FlowRun | null;
  return Boolean(
    r &&
      typeof r === "object" &&
      typeof r.id === "string" &&
      typeof r.flowId === "string" &&
      typeof r.status === "string" &&
      r.answers &&
      typeof r.answers === "object",
  );
}

/** Short random run id (hex, node:crypto). */
export function newRunId(): string {
  return randomBytes(8).toString("hex");
}

// ─── Store ───────────────────────────────────────────────────────

export class FlowStore {
  constructor(private readonly store: CallaStore) {}

  // ── Definitions (builtins in code + customs in cache) ─────────

  private async customDefs(): Promise<Record<string, FlowDefinition>> {
    const raw = await this.store
      .cacheGet<Record<string, FlowDefinition>>(DEFS_KEY, FLOWS_CACHE_AGENT)
      .catch(() => null);
    return raw && typeof raw === "object" ? raw : {};
  }

  private async saveCustomDefs(defs: Record<string, FlowDefinition>): Promise<void> {
    await this.store.cacheSet(DEFS_KEY, FLOWS_CACHE_AGENT, defs, null);
  }

  /** Idempotent bootstrap seed: ensures the custom-defs key exists. */
  async seed(): Promise<void> {
    await this.store
      .cacheGet<unknown>(DEFS_KEY, FLOWS_CACHE_AGENT)
      .catch(() => null)
      .then(async (raw) => {
        if (!raw) await this.saveCustomDefs({});
      });
  }

  /** Builtins first (code-versioned), then customs in insertion order. */
  async listDefinitions(): Promise<FlowDefinition[]> {
    const customs = await this.customDefs();
    return [...BUILTIN_FLOWS, ...Object.values(customs)];
  }

  async getDefinition(id: string): Promise<FlowDefinition | null> {
    const builtin = BUILTIN_FLOWS.find((f) => f.id === id);
    if (builtin) return builtin;
    const customs = await this.customDefs();
    const custom = customs[id];
    if (!custom) return null;
    // Re-validate on read: a hand-edited/legacy row must never crash the runner.
    const checked = validateFlowDefinition(custom);
    return typeof checked === "string" ? null : checked;
  }

  static isBuiltin(id: string): boolean {
    return BUILTIN_FLOW_IDS.has(id);
  }

  /** Create a custom definition; "duplicate" | "builtin" errors are strings. */
  async createDefinition(raw: unknown): Promise<[FlowDefinition | null, string | null]> {
    const def = validateFlowDefinition(raw);
    if (typeof def === "string") return [null, def];
    if (BUILTIN_FLOW_IDS.has(def.id)) {
      return [null, `duplicate: "${def.id}" is a builtin flow (versioned in code)`];
    }
    const customs = await this.customDefs();
    if (customs[def.id]) return [null, `duplicate: flow "${def.id}" already exists (PUT to update)`];
    customs[def.id] = def;
    await this.saveCustomDefs(customs);
    return [def, null];
  }

  /** Update a custom definition; builtins are code-versioned (error string). */
  async updateDefinition(
    id: string,
    raw: unknown,
  ): Promise<[FlowDefinition | null, string | null]> {
    if (BUILTIN_FLOW_IDS.has(id)) return [null, "builtin flows are versioned in code"];
    const customs = await this.customDefs();
    if (!customs[id]) return [null, `not-found: unknown flow "${id}"`];
    const body = (raw && typeof raw === "object" ? { ...(raw as object) } : {}) as Record<string, unknown>;
    const def = validateFlowDefinition({ ...customs[id], ...body, id });
    if (typeof def === "string") return [null, def];
    customs[id] = def;
    await this.saveCustomDefs(customs);
    return [def, null];
  }

  async deleteDefinition(id: string): Promise<[FlowDefinition | null, string | null]> {
    if (BUILTIN_FLOW_IDS.has(id)) return [null, "builtin flows are versioned in code"];
    const customs = await this.customDefs();
    const removed = customs[id];
    if (!removed) return [null, `not-found: unknown flow "${id}"`];
    delete customs[id];
    await this.saveCustomDefs(customs);
    return [removed, null];
  }

  // ── Runs ──────────────────────────────────────────────────────

  private runKey(runId: string): string {
    return `${RUN_PREFIX}${runId}`;
  }

  async getRun(runId: string): Promise<FlowRun | null> {
    const raw = await this.store
      .cacheGet<unknown>(this.runKey(runId), FLOWS_CACHE_AGENT)
      .catch(() => null);
    return isRunShape(raw) ? raw : null;
  }

  async saveRun(run: FlowRun): Promise<void> {
    await this.store.cacheSet(this.runKey(run.id), FLOWS_CACHE_AGENT, run, null);
    await this.touchIndex(run);
  }

  /** Newest-first capped index of run summaries (list route reads this only). */
  private async touchIndex(run: FlowRun): Promise<void> {
    const index = await this.listIndex();
    const entry: FlowRunIndexEntry = {
      id: run.id,
      flowId: run.flowId,
      status: run.status,
      ...(run.leadKey ? { leadKey: run.leadKey } : {}),
      ...(run.chatRef ? { chatRef: run.chatRef } : {}),
      updatedAt: run.updatedAt,
    };
    const next = [entry, ...index.filter((e) => e.id !== run.id)].slice(0, RUNS_INDEX_CAP);
    await this.store.cacheSet(RUNS_INDEX_KEY, FLOWS_CACHE_AGENT, next, null);
  }

  async listIndex(): Promise<FlowRunIndexEntry[]> {
    const raw = await this.store
      .cacheGet<unknown>(RUNS_INDEX_KEY, FLOWS_CACHE_AGENT)
      .catch(() => null);
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is FlowRunIndexEntry =>
        Boolean(e && typeof e === "object" && typeof (e as any).id === "string"),
    );
  }

  // ── Active-run lookup (channel → runner handoff) ──────────────

  private activeKey(channel: string, chatRef: string): string {
    return `${ACTIVE_PREFIX}${channel}:${chatRef}`;
  }

  async setActive(channel: string, chatRef: string, runId: string): Promise<void> {
    await this.store.cacheSet(
      this.activeKey(channel, chatRef),
      FLOWS_CACHE_AGENT,
      runId,
      ACTIVE_RUN_TTL_MS,
    );
  }

  async getActiveRunId(channel: string, chatRef: string): Promise<string | null> {
    const raw = await this.store
      .cacheGet<unknown>(this.activeKey(channel, chatRef), FLOWS_CACHE_AGENT)
      .catch(() => null);
    return typeof raw === "string" && raw ? raw : null;
  }

  async clearActive(channel: string, chatRef: string): Promise<void> {
    await this.store
      .cacheSet(this.activeKey(channel, chatRef), FLOWS_CACHE_AGENT, null, 1)
      .catch(() => {});
  }

  // ── Audit (hash-chained) ──────────────────────────────────────

  async audit(kind: FlowAuditKind | string, entry: Record<string, unknown>): Promise<void> {
    await this.store
      .appendAudit({ agentId: FLOWS_CACHE_AGENT, kind, entry })
      .catch((err) => console.error(`[flows] audit ${kind} failed:`, err));
  }
}
