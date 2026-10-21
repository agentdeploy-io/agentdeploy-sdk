/**
 * Meta Lead Forms (Facebook / Instagram Lead Ads) — webhook ingestion.
 *
 * WAVE-2: leadgen webhooks become pipeline leads + qualification-flow runs.
 * Mounted by app.ts at GET|POST /channels/facebook/webhook (auth-exempt;
 * platform-native verification instead):
 *
 *   • GET  — Meta handshake: echo hub.challenge when hub.mode === "subscribe"
 *     and hub.verify_token === FACEBOOK_VERIFY_TOKEN.
 *   • POST — X-Hub-Signature-256 = HMAC-sha256(rawBody, FACEBOOK_APP_SECRET),
 *     compared with timingSafeEqual (accepted-but-warned when the secret is
 *     unset, matching the WhatsApp/Instagram adapters).
 *
 * Processing pipeline (per entry[].changes[] where field === "leadgen"):
 *   1. audit "leadform.received" {leadgenId, pageId};
 *   2. dedupe guard — Meta retries webhooks, and bi-edge upsertLead is
 *      INSERT OR REPLACE (a whole-row overwrite): a redelivery must NEVER
 *      re-sync an already-captured lead back to raw/pending_review. Seen ids
 *      live at cache "leadform:seen:<leadgen_id>" (TTL 24h).
 *   3. fetch the FULL lead: GET {FB_GRAPH_BASE}/{leadgen_id}?access_token=…
 *      (default base https://graph.facebook.com/v21.0; env-overridable for
 *      mocks). When FACEBOOK_ACCESS_TOKEN is unset the fetch is SKIPPED
 *      gracefully — audit "leadform.error" + a 501-style note in the response,
 *      but the webhook still returns 200 to Meta (no retry storms).
 *      Response shape: {id, created_time, field_data:[{name, values[]}]}.
 *   4. map field_data → {fullName, email, phone, answers} (full_name / email /
 *      phone_number are contact fields; everything else is an answer);
 *   5. lead capture via lib/engine-client syncLeads: key `FB:<leadgen_id>`,
 *      name fullName, country FB_LEAD_COUNTRY (default IE), source "facebook",
 *      stage "raw", status "pending_review", emails/phones in the bi-edge JSON
 *      convention, research {origin:"leadform", form, created_time, answers};
 *      audit "leadform.captured";
 *   6. flow start (FACEBOOK_LEADGEN_FLOW, default
 *      "retrofit-solar-qualification"; "none" disables): answers are mapped
 *      onto flow field names via the field map (cache "leadform:fieldmap",
 *      seeded + FACEBOOK_FIELD_MAP env override) and passed as
 *      initialAnswers to startFlow({channel:"leadform",
 *      chatRef:`leadform:<leadgen_id>`}). Fully/mostly-prefilled runs
 *      complete immediately → scoring/routing/booking proposal land in
 *      run.routing + the standard flow.* audits. Unmatched answers stay in
 *      the lead's research blob.
 *
 * The webhook NEVER fails: every stage is best-effort and the POST response
 * is always 200 {ok:true, processed, …} so Meta does not retry-storm.
 *
 * ── Meta app setup ─────────────────────────────────────────────────────────
 * Subscribe the app webhook to the **leadgen** field (App Dashboard →
 * Webhooks → subscribe `leadgen` for the Page's app), grant the
 * `leads_retrieval` permission (App Review for production pages), and use a
 * Page/system-user token with that permission as FACEBOOK_ACCESS_TOKEN.
 * See channels/README.md → "Meta Lead Forms + website widget".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallaStore } from "../store/types.js";
import { syncLeads } from "../lib/engine-client.js";
import { startFlow } from "../flows/runner.js";
import { errorMessage, truncate } from "./util.js";

// ─── Config ──────────────────────────────────────────────────────

const DEFAULT_FB_GRAPH_BASE = "https://graph.facebook.com/v21.0";
const DEFAULT_LEADGEN_FLOW = "retrofit-solar-qualification";
const DEFAULT_LEAD_COUNTRY = "IE";

/** agentId for every lead-form cache row + audit entry. */
export const LEADFORM_CACHE_AGENT = "leadform";

/** Persisted form-question → flow-field map (JSON, no TTL). */
export const LEADFORM_FIELD_MAP_KEY = "leadform:fieldmap";

/** Redelivery dedupe guard (Meta retries webhooks; never re-sync a lead). */
export const LEADFORM_SEEN_PREFIX = "leadform:seen:";
export const LEADFORM_SEEN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Seeded mapping for the builtin retrofit flow's typical Lead-Ad questions.
 * Keys are the form question NAMES as configured in Meta Ads Manager (matched
 * case/space-insensitively at lookup). NOTE: the seeded targets use the
 * builtin flow's ACTUAL field names (monthly_spend / has_solar / has_ev) so
 * prefills really land; override anything via FACEBOOK_FIELD_MAP.
 */
export const SEEDED_LEADFORM_FIELD_MAP: Record<string, string> = {
  "Are you a homeowner?": "homeowner_or_tenant",
  "Homeowner or tenant": "homeowner_or_tenant",
  "Property type": "property_type",
  "Eircode": "eircode",
  "Monthly electricity spend": "monthly_spend",
  "Do you have solar?": "has_solar",
  "Existing solar": "has_solar",
  "Battery interest": "battery_interest",
  "EV": "has_ev",
  "When are you looking to install?": "timeframe",
  "Timeframe": "timeframe",
};

export interface FacebookConfig {
  /** FACEBOOK_VERIFY_TOKEN — GET handshake echo. */
  verifyToken?: string;
  /** FACEBOOK_APP_SECRET — POST HMAC verification (unset → accept + WARN). */
  appSecret?: string;
  /** FACEBOOK_ACCESS_TOKEN — leads_retrieval token for the full-lead fetch. */
  accessToken?: string;
  /** FB_GRAPH_BASE (mock-overridable Graph base). */
  graphBase: string;
  /** FACEBOOK_LEADGEN_FLOW; null when "none" (flow start disabled). */
  leadgenFlow: string | null;
  /** FB_LEAD_COUNTRY (lead row country; default IE). */
  country: string;
  /** FACEBOOK_FIELD_MAP — parsed JSON override merged over the cached/seeded map. */
  fieldMapOverride?: Record<string, string>;
}

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Read + normalize the Lead Forms config from the environment (pure). */
export function readFacebookConfig(env: NodeJS.ProcessEnv = process.env): FacebookConfig {
  const flowRaw = clean(env.FACEBOOK_LEADGEN_FLOW);
  const flow =
    flowRaw == null
      ? DEFAULT_LEADGEN_FLOW
      : flowRaw.toLowerCase() === "none"
        ? null
        : flowRaw;

  let fieldMapOverride: Record<string, string> | undefined;
  const mapRaw = clean(env.FACEBOOK_FIELD_MAP);
  if (mapRaw) {
    try {
      const parsed = JSON.parse(mapRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        fieldMapOverride = {};
        for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof v === "string" && v.trim()) fieldMapOverride[k] = v.trim();
        }
      } else {
        console.warn("[channels:facebook] FACEBOOK_FIELD_MAP must be a JSON object — ignored");
      }
    } catch (err) {
      console.warn("[channels:facebook] FACEBOOK_FIELD_MAP is not valid JSON — ignored:", errorMessage(err));
    }
  }

  return {
    verifyToken: clean(env.FACEBOOK_VERIFY_TOKEN),
    appSecret: clean(env.FACEBOOK_APP_SECRET),
    accessToken: clean(env.FACEBOOK_ACCESS_TOKEN),
    graphBase: stripTrailingSlash(clean(env.FB_GRAPH_BASE) ?? DEFAULT_FB_GRAPH_BASE),
    leadgenFlow: flow,
    country: clean(env.FB_LEAD_COUNTRY) ?? DEFAULT_LEAD_COUNTRY,
    ...(fieldMapOverride ? { fieldMapOverride } : {}),
  };
}

// ─── Webhook verification ────────────────────────────────────────

/**
 * GET verification: echo hub.challenge when hub.mode === "subscribe" and
 * hub.verify_token matches FACEBOOK_VERIFY_TOKEN; otherwise null. Accepts
 * both flat ("hub.mode") and bracket ("hub[mode]") query keys.
 */
export function verifyFacebookWebhook(
  query: Record<string, string | undefined>,
  config: FacebookConfig,
): string | null {
  const mode = query["hub.mode"] ?? query["hub[mode]"];
  const token = query["hub.verify_token"] ?? query["hub[verify_token]"];
  const challenge = query["hub.challenge"] ?? query["hub[challenge]"];
  if (mode === "subscribe" && config.verifyToken && token === config.verifyToken) {
    return challenge ?? null;
  }
  return null;
}

/**
 * POST signature check: sha256 HMAC of the raw body with FACEBOOK_APP_SECRET
 * vs X-Hub-Signature-256 (timingSafeEqual). Secret unset → accept + WARN
 * (same dev convenience as the WhatsApp/Instagram adapters).
 */
export function validateFacebookSignature(
  rawBody: string,
  signatureHeader: string | undefined,
  config: FacebookConfig,
): { ok: boolean; warned: boolean } {
  if (!config.appSecret) {
    console.warn(
      "[channels:facebook] FACEBOOK_APP_SECRET unset — accepting webhook WITHOUT HMAC verification",
    );
    return { ok: true, warned: true };
  }
  if (!signatureHeader) return { ok: false, warned: false };
  const expected = `sha256=${createHmac("sha256", config.appSecret)
    .update(rawBody, "utf8")
    .digest("hex")}`;
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(signatureHeader.trim(), "utf8");
  if (a.length !== b.length) return { ok: false, warned: false };
  return { ok: timingSafeEqual(a, b), warned: false };
}

// ─── Field map (seeded cache + env override) ─────────────────────

function normQuestion(name: string): string {
  return String(name ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Load the form-question → flow-field map: the cache row at
 * "leadform:fieldmap" (seeded with SEEDED_LEADFORM_FIELD_MAP on first use),
 * with the FACEBOOK_FIELD_MAP env override merged on top. Lookups are
 * case/space-insensitive.
 */
export async function loadLeadFormFieldMap(
  store: CallaStore,
  config: FacebookConfig,
): Promise<Map<string, string>> {
  let stored: Record<string, string> | null = null;
  try {
    const raw = await store.cacheGet<unknown>(LEADFORM_FIELD_MAP_KEY, LEADFORM_CACHE_AGENT);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      stored = raw as Record<string, string>;
    }
  } catch (err) {
    console.warn("[channels:facebook] field-map cache read failed (using seed):", errorMessage(err));
  }
  if (!stored) {
    stored = SEEDED_LEADFORM_FIELD_MAP;
    await store
      .cacheSet(LEADFORM_FIELD_MAP_KEY, LEADFORM_CACHE_AGENT, SEEDED_LEADFORM_FIELD_MAP, null)
      .catch(() => {});
  }
  const merged = { ...stored, ...(config.fieldMapOverride ?? {}) };
  const lookup = new Map<string, string>();
  for (const [q, f] of Object.entries(merged)) {
    if (typeof f === "string" && f.trim()) lookup.set(normQuestion(q), f.trim());
  }
  return lookup;
}

// ─── Lead payload mapping ────────────────────────────────────────

export interface LeadgenFieldData {
  name?: string;
  values?: unknown[];
}

export interface LeadgenLead {
  id?: string;
  created_time?: string;
  field_data?: LeadgenFieldData[];
}

export interface MappedLeadgen {
  fullName?: string;
  email?: string;
  phone?: string;
  /** Every non-contact answer, keyed by the form question name. */
  answers: Record<string, string>;
  /** All field names present on the form (research trail). */
  form: string[];
}

/** Contact-ish field names that never become flow answers. */
const CONTACT_FIELDS = new Set(["full_name", "email", "email_address", "phone_number"]);

/** Map Graph field_data → contact fields + question answers. */
export function mapLeadgenFieldData(fieldData: LeadgenFieldData[] | undefined): MappedLeadgen {
  const out: MappedLeadgen = { answers: {}, form: [] };
  for (const field of fieldData ?? []) {
    const name = String(field?.name ?? "").trim();
    if (!name) continue;
    out.form.push(name);
    const value = Array.isArray(field?.values) ? String(field.values[0] ?? "").trim() : "";
    const key = name.toLowerCase().replace(/[\s-]+/g, "_");
    if (CONTACT_FIELDS.has(key)) {
      if (!value) continue;
      if (key === "full_name") out.fullName = value;
      else if (key === "phone_number") out.phone = value;
      else out.email = value.toLowerCase();
      continue;
    }
    if (value) out.answers[name] = value;
  }
  return out;
}

// ─── Full-lead fetch ─────────────────────────────────────────────

async function fetchLeadgen(
  config: FacebookConfig,
  leadgenId: string,
): Promise<{ lead?: LeadgenLead; error?: string }> {
  const url =
    `${config.graphBase}/${encodeURIComponent(leadgenId)}` +
    `?access_token=${encodeURIComponent(config.accessToken ?? "")}`;
  try {
    const res = await fetch(url);
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return { error: `graph fetch failed ${res.status}: ${truncate(text, 200)}` };
    }
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      return { error: `graph fetch returned non-JSON: ${truncate(text, 120)}` };
    }
    if (!json || typeof json !== "object") return { error: "graph fetch returned an empty body" };
    return { lead: json as LeadgenLead };
  } catch (err) {
    return { error: errorMessage(err) };
  }
}

// ─── Webhook processing ──────────────────────────────────────────

export interface LeadgenWebhookDeps {
  store: CallaStore;
  config: FacebookConfig;
}

export interface LeadgenResult {
  leadgenId: string;
  pageId?: string;
  leadKey?: string;
  captured?: boolean;
  runId?: string;
  runStatus?: string;
  done?: boolean;
  tier?: string;
  prefilled?: number;
  unmatched?: string[];
  note?: string;
}

export interface LeadgenWebhookResult {
  processed: number;
  captured: number;
  flowsStarted: number;
  duplicates: number;
  results: LeadgenResult[];
}

async function audit(
  store: CallaStore,
  kind: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await store.appendAudit({ agentId: LEADFORM_CACHE_AGENT, kind, entry });
  } catch (err) {
    console.warn(`[channels:facebook] appendAudit(${kind}) failed:`, errorMessage(err));
  }
}

/**
 * Process a (signature-verified) leadgen webhook body. Best-effort end to
 * end: individual lead failures are audited + noted, never thrown. The
 * caller always responds 200 to Meta.
 */
export async function handleFacebookLeadgenWebhook(
  body: unknown,
  deps: LeadgenWebhookDeps,
): Promise<LeadgenWebhookResult> {
  const { store, config } = deps;
  const result: LeadgenWebhookResult = {
    processed: 0,
    captured: 0,
    flowsStarted: 0,
    duplicates: 0,
    results: [],
  };

  const changes: { leadgenId: string; pageId?: string }[] = [];
  try {
    const entries = (body as { entry?: unknown })?.entry;
    if (Array.isArray(entries)) {
      for (const entry of entries) {
        const list = (entry as { changes?: unknown })?.changes;
        if (!Array.isArray(list)) continue;
        for (const change of list as Record<string, any>[]) {
          if (String(change?.field ?? "") !== "leadgen") continue;
          const value = (change?.value ?? {}) as Record<string, unknown>;
          const leadgenId = String(value.leadgen_id ?? "").trim();
          if (!leadgenId) continue;
          const pageId = value.page_id != null ? String(value.page_id) : undefined;
          changes.push({ leadgenId, ...(pageId ? { pageId } : {}) });
        }
      }
    }
  } catch (err) {
    console.warn("[channels:facebook] webhook parse failed:", errorMessage(err));
    return result;
  }

  if (!changes.length) return result;
  const fieldMap = await loadLeadFormFieldMap(store, config);

  for (const { leadgenId, pageId } of changes) {
    result.processed += 1;
    const entry: LeadgenResult = { leadgenId, ...(pageId ? { pageId } : {}) };
    result.results.push(entry);
    await audit(store, "leadform.received", {
      leadgenId,
      pageId: pageId ?? null,
    });

    try {
      // Dedupe: Meta redelivers webhooks; a re-sync would clobber the lead row.
      const seenKey = `${LEADFORM_SEEN_PREFIX}${leadgenId}`;
      const seen = await store
        .cacheGet<unknown>(seenKey, LEADFORM_CACHE_AGENT)
        .catch(() => null);
      if (seen) {
        result.duplicates += 1;
        entry.note = "duplicate delivery — already processed (skipped)";
        continue;
      }

      if (!config.accessToken) {
        entry.note =
          "FACEBOOK_ACCESS_TOKEN unset — full-lead fetch skipped (501-style: acknowledged, not processable)";
        await audit(store, "leadform.error", {
          leadgenId,
          pageId: pageId ?? null,
          stage: "fetch",
          error: "FACEBOOK_ACCESS_TOKEN unset — cannot fetch lead field_data",
        });
        continue;
      }

      const fetched = await fetchLeadgen(config, leadgenId);
      if (!fetched.lead) {
        entry.note = `lead fetch failed: ${fetched.error}`;
        await audit(store, "leadform.error", {
          leadgenId,
          pageId: pageId ?? null,
          stage: "fetch",
          error: fetched.error ?? "unknown",
        });
        continue;
      }
      const lead = fetched.lead;
      const mapped = mapLeadgenFieldData(lead.field_data);
      const leadKey = `FB:${leadgenId}`;
      entry.leadKey = leadKey;

      // ── Lead capture (bi-edge sync convention) ────────────────────
      const research: Record<string, unknown> = {
        origin: "leadform",
        pageId: pageId ?? null,
        form: mapped.form,
        created_time: lead.created_time ?? null,
        answers: mapped.answers,
      };
      const syncRes = await syncLeads([
        {
          key: leadKey,
          name: mapped.fullName || "Lead form enquiry",
          country: config.country,
          source: "facebook",
          stage: "raw",
          status: "pending_review",
          emails: mapped.email
            ? JSON.stringify([{ addr: mapped.email, mx_ok: true }])
            : null,
          phones: mapped.phone ? JSON.stringify([mapped.phone]) : null,
          research: JSON.stringify(research),
        },
      ]);
      if (syncRes.ok) {
        result.captured += 1;
        entry.captured = true;
        await store
          .cacheSet(seenKey, LEADFORM_CACHE_AGENT, { at: new Date().toISOString() }, LEADFORM_SEEN_TTL_MS)
          .catch(() => {});
        await audit(store, "leadform.captured", {
          leadgenId,
          pageId: pageId ?? null,
          key: leadKey,
          hasEmail: Boolean(mapped.email),
          hasPhone: Boolean(mapped.phone),
          answers: Object.keys(mapped.answers).length,
        });
      } else {
        entry.note = `lead sync failed: ${syncRes.error ?? `HTTP ${syncRes.status}`}`;
        await audit(store, "leadform.error", {
          leadgenId,
          pageId: pageId ?? null,
          stage: "capture",
          key: leadKey,
          error: syncRes.error ?? `HTTP ${syncRes.status}`,
        });
      }

      // ── Qualification flow (prefilled → completes immediately) ────
      if (config.leadgenFlow) {
        const initialAnswers: Record<string, string> = {};
        const unmatched: string[] = [];
        for (const [question, value] of Object.entries(mapped.answers)) {
          const field = fieldMap.get(normQuestion(question));
          if (field) initialAnswers[field] = value;
          else unmatched.push(question);
        }
        entry.unmatched = unmatched;
        entry.prefilled = Object.keys(initialAnswers).length;
        try {
          const step = await startFlow(store, {
            flowId: config.leadgenFlow,
            leadKey,
            channel: "leadform",
            chatRef: `leadform:${leadgenId}`,
            ...(entry.prefilled ? { initialAnswers } : {}),
          });
          if (step.error !== undefined) {
            entry.note = [entry.note, `flow start failed: ${step.error}`].filter(Boolean).join("; ");
            await audit(store, "leadform.error", {
              leadgenId,
              pageId: pageId ?? null,
              stage: "flow",
              flowId: config.leadgenFlow,
              error: step.error,
            });
          } else {
            result.flowsStarted += 1;
            entry.runId = step.run.id;
            entry.runStatus = step.run.status;
            entry.done = Boolean(step.done);
            entry.tier = step.run.tier ?? undefined;
          }
        } catch (err) {
          entry.note = [entry.note, `flow start threw: ${errorMessage(err)}`].filter(Boolean).join("; ");
          await audit(store, "leadform.error", {
            leadgenId,
            pageId: pageId ?? null,
            stage: "flow",
            flowId: config.leadgenFlow,
            error: errorMessage(err),
          });
        }
      }
    } catch (err) {
      entry.note = `processing failed: ${errorMessage(err)}`;
      await audit(store, "leadform.error", {
        leadgenId,
        pageId: pageId ?? null,
        stage: "process",
        error: errorMessage(err),
      });
    }
  }

  return result;
}
