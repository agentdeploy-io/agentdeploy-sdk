/**
 * Social reply-automation engine — the ManyChat-style brain for Instagram +
 * TikTok business messaging + WhatsApp CUSTOMER conversations (unbound chats
 * on the business line; see channels/whatsapp.ts for the operator/customer
 * routing).
 *
 * handleSocialInbound(msg, deps) is the single entry point every webhook (and
 * the /social/test QA route) funnels normalized events through. Pipeline:
 *
 *   (a) mark the platform reply window (IG 24h) + audit "social.received";
 *   (a2) CONVERSATION-THREAD RECORDING (additive) — the normalized inbound is
 *       appended to the operator console's thread store
 *       (src/conversations/store.ts, `conv:thread:<platform>:<userId>`) and
 *       EVERY outbound the engine produces is recorded too, tagged with its
 *       kind (static | persona | flow_prompt | system) + auto:true, so
 *       GET /conversations shows the whole exchange;
 *   (b) LEAD CAPTURE (capture-by-default) — EVERY dm | comment | story_mention
 *       inbound becomes a pipeline lead (founder directive: "if queries for this
 *       business come from socials we should be capturing them as leads"), not
 *       only when an email/@handle is regex-extracted. FIRST contact POSTs a full
 *       lead to the bi-edge sync endpoint (SOCIAL_ENGINE_SYNC_URL, header
 *       X-AD-Sync) + audit "social.lead_captured"; SUBSEQUENT contacts PATCH the
 *       engine data-plane ({SOCIAL_ENGINE_DATA_URL}/cmd/data/row) with merged
 *       research (+ emails when newly found) + audit "social.lead_updated" — they
 *       NEVER full-re-sync, because bi-edge upsertLead is `INSERT OR REPLACE`
 *       (a whole-row overwrite that would downgrade an approved/sent lead back to
 *       raw/pending_review and wipe its pitch). Per-lead state lives in the store
 *       cache at "social:lead:<key>" (no TTL). Rapid-fire contacts (<60s) only
 *       bump messageCount. Capture is best-effort: on an unreachable engine it
 *       retries once (2s), then audits "social.error" {stage:"lead_capture"} and
 *       CONTINUES — the reply flow is never blocked and the lead is re-capturable
 *       on the next contact. Gated by SOCIAL_LEAD_CAPTURE (default true).
 *   (b2) TAKEOVER GATE (additive) — when an operator paused THIS thread
 *       (POST /conversations/:id/takeover {on:true}) lead capture + inbound
 *       recording still run, but NOTHING automatic is sent and no flow starts
 *       or advances: audit "social.takeover_skipped" + return. Manual operator
 *       replies (POST /conversations/:id/message) are unaffected.
 *   (c) TRIGGER MATCH (specific rules before the per-platform fallback):
 *         reply → static text · agent → persona agent.generate() ·
 *         capture/none → no reply · flow → start a qualification flow
 *         (src/flows runner) and send its first prompt. BEFORE any draft
 *         handling, an ACTIVE flow run for the chatRef
 *         `<platform>:<externalUserId>` (channel "social") consumes the
 *         message: it is fed to answerFlow() and the next prompt is sent
 *         under the same policy (auto within the reply window, otherwise an
 *         approval card containing the prompt text) — no persona reply;
 *   (d) SEND POLICY — mode "auto" AND inside the reply window AND no LLM error
 *       → adapter send + audit "social.sent" {auto:true}; otherwise record a
 *       HITL approval (source "mastra", toolName `social-<platform>-<kind>`,
 *       risk comment→high / dm→medium, args carry the derived `leadKey`), register
 *       a social DecisionContext so the EXISTING Telegram/WhatsApp approval cards
 *       can decide it, and best-effort relay a calla:approval:request frame to
 *       {CALLA_EDGE_URL}/events/ingest so the web UI inbox sees it live.
 *
 * LLM failures NEVER crash: they degrade to an approval whose draft is the raw
 * inbound text, with an audit "social.error". Everything store/network related
 * is wrapped and logged.
 *
 * Replies are generated via resolveDynamicAgent(...).generate so the tenant's
 * EDITABLE persona (e.g. the builtin "miles" for gradient3.io) drives tone.
 */
import { CALLA_EVENTS, callaFrame, type ApprovalRequest } from "@calla/shared";
import {
  patchLead as enginePatchLead,
  syncLeads as engineSyncLeads,
} from "../../lib/engine-client.js";
import {
  ConversationStore,
  conversationId,
  type ConversationMessageKind,
} from "../../conversations/store.js";
import {
  answerFlow,
  formatPromptText,
  getActiveRun,
  startFlow,
} from "../../flows/runner.js";
import type { FlowChannel } from "../../flows/types.js";
import { rowToApprovalRequest } from "../decisions.js";
import { errorMessage, maskChatId, stripMarkdown, truncate } from "../util.js";
import { enqueueSocialSend } from "./queue.js";
import {
  SOCIAL_CACHE_AGENT,
  SOCIAL_LEAD_DEDUPE_MS,
  SOCIAL_LEAD_PREFIX,
  SOCIAL_TRIGGERS_KEY,
} from "./keys.js";
import type {
  SocialAdapter,
  SocialDeps,
  SocialFallback,
  SocialInbound,
  SocialKind,
  SocialPlatform,
  SocialTrigger,
  TriggersConfig,
} from "./types.js";

/** A specific trigger or the per-platform fallback (they share these fields). */
type ResolvedTrigger = SocialTrigger | SocialFallback;

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// @handle NOT part of an email (must start the string or follow space/paren).
const HANDLE_RE = /(?:^|[\s(])@([A-Za-z0-9._]{1,30})/g;
const MAX_REPLY_CHARS = 300;

const ACTIONS = ["reply", "agent", "capture", "none", "flow"] as const;
const SCOPES = ["dm", "comment", "any"] as const;
const MATCHES = ["keyword", "regex", "any"] as const;

// ─── Audit helper ────────────────────────────────────────────────

async function audit(
  deps: SocialDeps,
  kind: string,
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await deps.store.appendAudit({ agentId: SOCIAL_CACHE_AGENT, kind, entry });
  } catch (err) {
    console.warn(`[channels:social] appendAudit(${kind}) failed:`, errorMessage(err));
  }
}

// ─── Conversation-thread recording (operator console) ────────────

/**
 * Thread-store handle (src/conversations/store.ts). Cheap to construct — it
 * only closes over deps.store — and every method is best-effort, so recording
 * can never break (or slow down) a reply.
 */
function conversations(deps: SocialDeps): ConversationStore {
  return new ConversationStore(deps.store);
}

/** Thread id for one normalized inbound event: `<platform>:<externalUserId>`. */
function threadId(msg: SocialInbound): string {
  return conversationId(msg.platform, msg.externalUserId);
}

/** Outbound kind for a trigger-driven reply (canned text vs persona agent). */
function replyKind(trigger: ResolvedTrigger): "static" | "persona" {
  return trigger.action === "reply" ? "static" : "persona";
}

/**
 * Record one engine-produced OUTBOUND entry in the thread (always auto:true).
 * kind "system" marks entries that were NOT delivered to the customer (a
 * pending/failed approval) — the UI renders them as thread notices. Timestamps
 * are the send time (the store defaults to now).
 */
async function recordOut(
  deps: SocialDeps,
  msg: SocialInbound,
  text: string,
  kind: ConversationMessageKind,
  approvalId?: string,
): Promise<void> {
  await conversations(deps)
    .recordOutbound({
      platform: msg.platform,
      externalUserId: msg.externalUserId,
      ...(msg.username ? { username: msg.username } : {}),
      text,
      kind,
      auto: true,
      ...(approvalId ? { approvalId } : {}),
    })
    .catch((err) =>
      console.warn("[channels:social] conversation recordOutbound failed:", errorMessage(err)),
    );
}

// ─── Trigger defaults / validation / persistence ─────────────────

/**
 * Safety-first seed defaults (Calla HITL doctrine):
 *   • Instagram comment "ai" keyword → agent reply, but REQUIRE approval
 *     (public-facing comment replies are high-risk).
 *   • Instagram DM fallback → agent, auto (inside the 24h window; low-risk,
 *     user-initiated 1:1).
 *   • TikTok DM fallback → agent, APPROVAL (automation only in user-initiated
 *     conversations + region-gated comment-to-message; keep a human in the loop).
 *   • WhatsApp customer fallback → agent, auto (user-initiated 1:1 on the
 *     business line, inside the 24h customer-service window — same risk class
 *     as Instagram DMs; LLM failures still degrade to approval, and
 *     WHATSAPP_CUSTOMER_MODE=false disables the inbound path entirely).
 */
export function defaultTriggers(): TriggersConfig {
  return {
    instagram: [
      {
        id: "ig-comment-ai",
        scope: "comment",
        match: "keyword",
        value: "ai",
        action: "agent",
        mode: "approval",
      },
    ],
    tiktok: [],
    whatsapp: [],
    // Reddit is PUBLIC: every thread reply is visible forever, so the safety
    // default is approval-gated persona replies (flip to "auto" per-trigger
    // or fallback once the voice is trusted).
    reddit: [],
    fallback: {
      instagram: { action: "agent", mode: "auto" },
      tiktok: { action: "agent", mode: "approval" },
      whatsapp: { action: "agent", mode: "auto" },
      reddit: { action: "agent", mode: "approval" },
    },
  };
}

function isAction(v: unknown): v is SocialTrigger["action"] {
  return typeof v === "string" && (ACTIONS as readonly string[]).includes(v);
}
function isScope(v: unknown): v is SocialTrigger["scope"] {
  return typeof v === "string" && (SCOPES as readonly string[]).includes(v);
}
function isMatch(v: unknown): v is SocialTrigger["match"] {
  return typeof v === "string" && (MATCHES as readonly string[]).includes(v);
}

/** Normalize one raw trigger; null when it is structurally invalid. */
function sanitizeTrigger(raw: unknown): SocialTrigger | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  if (!isAction(b.action)) return null;

  // Safety default: unspecified mode → approval.
  const mode: SocialTrigger["mode"] = b.mode === "auto" ? "auto" : "approval";
  const scope: SocialTrigger["scope"] = isScope(b.scope) ? b.scope : "any";
  const match: SocialTrigger["match"] = isMatch(b.match)
    ? b.match
    : b.value != null
      ? "keyword"
      : "any";

  const t: SocialTrigger = { scope, match, action: b.action, mode };
  if (b.id != null) t.id = String(b.id);
  if (b.value != null) t.value = String(b.value);
  if (b.reply != null) t.reply = String(b.reply);
  if (b.agentId != null) t.agentId = String(b.agentId);
  if (b.flowId != null) t.flowId = String(b.flowId);
  if (b.captureLead != null) t.captureLead = Boolean(b.captureLead);

  // A static-reply rule with no text is useless → reject.
  if (t.action === "reply" && !t.reply) return null;
  // A flow rule with no flowId cannot start anything → reject.
  if (t.action === "flow" && !t.flowId) return null;
  // keyword/regex matching requires a value.
  if ((t.match === "keyword" || t.match === "regex") && !t.value) return null;
  return t;
}

function sanitizeFallback(raw: unknown, dflt: SocialFallback): SocialFallback {
  if (!raw || typeof raw !== "object") return dflt;
  const b = raw as Record<string, any>;
  // "flow" is NOT a valid fallback (no flowId slot) — degrade to the default.
  const action = isAction(b.action) && b.action !== "flow" ? b.action : dflt.action;
  const mode: SocialFallback["mode"] =
    b.mode === "auto" ? "auto" : b.mode === "approval" ? "approval" : dflt.mode;
  const f: SocialFallback = { action, mode };
  if (b.reply != null) f.reply = String(b.reply);
  if (b.agentId != null) f.agentId = String(b.agentId);
  if (b.captureLead != null) f.captureLead = Boolean(b.captureLead);
  return f;
}

/** Validate a PUT body into a full TriggersConfig (fills defaults when partial). */
export function validateTriggersConfig(
  input: unknown,
): { ok: true; config: TriggersConfig } | { ok: false; error: string } {
  if (!input || typeof input !== "object") {
    return { ok: false, error: "body must be a JSON object" };
  }
  const b = input as Record<string, any>;
  const defaults = defaultTriggers();

  const ig = Array.isArray(b.instagram) ? b.instagram : defaults.instagram;
  const tt = Array.isArray(b.tiktok) ? b.tiktok : defaults.tiktok;
  const wa = Array.isArray(b.whatsapp) ? b.whatsapp : defaults.whatsapp;
  const rd = Array.isArray(b.reddit) ? b.reddit : defaults.reddit;

  const instagram: SocialTrigger[] = [];
  for (const raw of ig) {
    const t = sanitizeTrigger(raw);
    if (!t) return { ok: false, error: `invalid instagram trigger: ${truncate(JSON.stringify(raw) ?? "", 120)}` };
    instagram.push(t);
  }
  const tiktok: SocialTrigger[] = [];
  for (const raw of tt) {
    const t = sanitizeTrigger(raw);
    if (!t) return { ok: false, error: `invalid tiktok trigger: ${truncate(JSON.stringify(raw) ?? "", 120)}` };
    tiktok.push(t);
  }
  const whatsapp: SocialTrigger[] = [];
  for (const raw of wa) {
    const t = sanitizeTrigger(raw);
    if (!t) return { ok: false, error: `invalid whatsapp trigger: ${truncate(JSON.stringify(raw) ?? "", 120)}` };
    whatsapp.push(t);
  }
  const reddit: SocialTrigger[] = [];
  for (const raw of rd) {
    const t = sanitizeTrigger(raw);
    if (!t) return { ok: false, error: `invalid reddit trigger: ${truncate(JSON.stringify(raw) ?? "", 120)}` };
    reddit.push(t);
  }

  const fb = b.fallback && typeof b.fallback === "object" ? b.fallback : {};
  return {
    ok: true,
    config: {
      instagram,
      tiktok,
      whatsapp,
      reddit,
      fallback: {
        instagram: sanitizeFallback(fb.instagram, defaults.fallback.instagram),
        tiktok: sanitizeFallback(fb.tiktok, defaults.fallback.tiktok),
        whatsapp: sanitizeFallback(fb.whatsapp, defaults.fallback.whatsapp),
        reddit: sanitizeFallback(fb.reddit, defaults.fallback.reddit),
      },
    },
  };
}

/** Load persisted triggers, falling back to the safety-first defaults. */
export async function loadTriggers(deps: SocialDeps): Promise<TriggersConfig> {
  const stored = await deps.store
    .cacheGet<unknown>(SOCIAL_TRIGGERS_KEY, SOCIAL_CACHE_AGENT)
    .catch(() => null);
  if (stored) {
    const v = validateTriggersConfig(stored);
    if (v.ok) return v.config;
  }
  return defaultTriggers();
}

/** Validate + persist a TriggersConfig (no TTL). */
export async function saveTriggers(
  deps: SocialDeps,
  input: unknown,
): Promise<{ ok: true; config: TriggersConfig } | { ok: false; error: string }> {
  const v = validateTriggersConfig(input);
  if (!v.ok) return v;
  await deps.store.cacheSet(SOCIAL_TRIGGERS_KEY, SOCIAL_CACHE_AGENT, v.config, null);
  return { ok: true, config: v.config };
}

function scopeMatches(scope: SocialTrigger["scope"], kind: SocialInbound["kind"]): boolean {
  if (scope === "any") return true;
  if (scope === "comment") return kind === "comment";
  return kind === "dm" || kind === "postback" || kind === "story_mention";
}

function valueMatches(trigger: SocialTrigger, text: string): boolean {
  if (trigger.match === "any") return true;
  const value = trigger.value;
  if (!value) return false;
  if (trigger.match === "keyword") {
    return text.toLowerCase().includes(value.toLowerCase());
  }
  try {
    return new RegExp(value, "i").test(text);
  } catch {
    return false; // invalid regex → no match (never throw)
  }
}

/** Specific rules first (in order), then the per-platform fallback. */
export function matchTrigger(
  config: TriggersConfig,
  msg: SocialInbound,
): { trigger: ResolvedTrigger; specific: boolean } {
  const list =
    msg.platform === "instagram"
      ? config.instagram
      : msg.platform === "tiktok"
        ? config.tiktok
        : msg.platform === "reddit"
          ? config.reddit
          : config.whatsapp;
  for (const t of list) {
    if (scopeMatches(t.scope, msg.kind) && valueMatches(t, msg.text)) {
      return { trigger: t, specific: true };
    }
  }
  const fb =
    msg.platform === "instagram"
      ? config.fallback.instagram
      : msg.platform === "tiktok"
        ? config.fallback.tiktok
        : msg.platform === "reddit"
          ? config.fallback.reddit
          : config.fallback.whatsapp;
  return { trigger: fb, specific: false };
}

// ─── Lead capture (capture-by-default) ───────────────────────────

function extractContacts(text: string): { emails: string[]; handles: string[] } {
  const emails = [...new Set((text.match(EMAIL_RE) ?? []).map((e) => e.toLowerCase()))];
  const handles: string[] = [];
  const re = new RegExp(HANDLE_RE.source, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1]) handles.push(m[1]);
  }
  return { emails, handles: [...new Set(handles)] };
}

function leadPrefix(platform: SocialPlatform): string {
  if (platform === "instagram") return "IG";
  if (platform === "tiktok") return "TT";
  if (platform === "reddit") return "RD";
  return "WA";
}

/**
 * Stable dedupe identity for a social contact: `IG:<username|id>` /
 * `TT:<username|id>` / `WA:<phone>`. WhatsApp keys ALWAYS use the phone
 * (externalUserId) — the profile name (`username`) is display-only and not a
 * stable identity.
 */
export function socialLeadKey(msg: SocialInbound): string {
  const id =
    msg.platform === "whatsapp"
      ? msg.externalUserId
      : msg.username || msg.externalUserId;
  return `${leadPrefix(msg.platform)}:${id}`;
}

/** Per-lead capture state cached at "social:lead:<key>" (agentId "social", no TTL). */
interface SocialLeadState {
  firstCapturedAt: string; // ISO
  lastSeenAt: string; // ISO
  messageCount: number;
  emailCaptured: boolean;
  syncedStage: "raw";
  /** Kept so a later research PATCH can merge first↔last message context. */
  firstMessage: string;
  firstKind: SocialKind;
}

function emailsJson(emails: string[]): string {
  return JSON.stringify(emails.map((addr) => ({ addr, mx_ok: true })));
}

/** Profile-ish source_url when a public handle is derivable. */
function deriveSourceUrl(msg: SocialInbound): string | undefined {
  if (msg.platform === "whatsapp") {
    // Phone identity → wa.me click-to-chat link (no public profile).
    return msg.externalUserId ? `https://wa.me/${msg.externalUserId}` : undefined;
  }
  if (!msg.username) return undefined;
  if (msg.platform === "instagram") return `https://instagram.com/${msg.username}`;
  if (msg.platform === "reddit") return `https://reddit.com/user/${msg.username.replace(/^\/?u\//, "")}`;
  return `https://tiktok.com/@${msg.username}`;
}

/** research blob for a FIRST contact (full sync). */
function firstResearch(msg: SocialInbound, capturedAt: string): Record<string, unknown> {
  return {
    origin: "social",
    kind: msg.kind,
    firstMessage: msg.text.slice(0, 500),
    capturedAt,
  };
}

/** research blob for a SUBSEQUENT contact (merged first↔last, patched). */
function mergedResearch(msg: SocialInbound, state: SocialLeadState): Record<string, unknown> {
  return {
    origin: "social",
    kind: state.firstKind,
    firstMessage: state.firstMessage,
    firstCapturedAt: state.firstCapturedAt,
    lastKind: msg.kind,
    lastMessage: msg.text.slice(0, 500),
    lastSeenAt: state.lastSeenAt,
    messageCount: state.messageCount,
  };
}

/** Engine-client options pinned to the startup config snapshot (SocialDeps). */
function engineOpts(deps: SocialDeps) {
  return {
    syncUrl: deps.config.engineSyncUrl,
    dataUrl: deps.config.engineDataUrl,
    secret: deps.config.engineSyncSecret,
  };
}

/**
 * FIRST contact (or a re-capture when a later PATCH reports the row vanished):
 * POST the full lead to bi-edge /inbound/sync. Returns true on 2xx.
 *   body { leads:[{ key, name, country:"--", source:<platform>, stage:"raw",
 *                   status:"pending_review", emails|null, socials, source_url?,
 *                   research }] }
 */
async function fullSyncLead(
  deps: SocialDeps,
  msg: SocialInbound,
  contacts: { emails: string[]; handles: string[] },
  leadKey: string,
  state: SocialLeadState | null,
): Promise<boolean> {
  if (!deps.config.engineSyncUrl) return false; // nowhere to sync
  const capturedAt = new Date().toISOString();
  const research = state ? mergedResearch(msg, state) : firstResearch(msg, capturedAt);
  const sourceUrl = deriveSourceUrl(msg);
  const lead: Record<string, unknown> = {
    key: leadKey,
    name: msg.username || "Social enquiry",
    country: "--",
    source: msg.platform,
    stage: "raw",
    status: "pending_review",
    emails: contacts.emails.length ? emailsJson(contacts.emails) : null,
    socials: JSON.stringify([
      { platform: msg.platform, id: msg.externalUserId, username: msg.username ?? null },
    ]),
    research: JSON.stringify(research),
  };
  if (sourceUrl) lead.source_url = sourceUrl;

  const res = await engineSyncLeads([lead], engineOpts(deps));
  if (!res.ok) {
    console.warn("[channels:social] lead full-sync failed:", res.error ?? res.status);
  }
  return res.ok;
}

/**
 * SUBSEQUENT contact: partial PATCH to the engine data-plane /cmd/data/row so an
 * already-advanced lead is NEVER downgraded (bi-edge updateLead only sets the
 * patched columns). Returns { ok } on success, { missing } when the row is gone
 * (404 or {updated:false}) → caller falls back to a full re-capture.
 */
async function patchLead(
  deps: SocialDeps,
  leadKey: string,
  patch: Record<string, unknown>,
): Promise<{ ok: boolean; missing: boolean }> {
  // Shared engine data-plane client (lib/engine-client.ts): POST /cmd/data/row
  // with one retry; {missing} on 404/{updated:false}; {ok:false} (never
  // clobber via full-sync) when no data URL is configured.
  const res = await enginePatchLead(leadKey, patch, engineOpts(deps));
  if (!res.ok && !res.missing) {
    console.warn("[channels:social] lead patch failed:", res.error ?? "unknown");
  }
  return { ok: res.ok, missing: res.missing };
}

/**
 * Capture-by-default entry point. Creates a lead on FIRST contact (full sync) or
 * updates it on SUBSEQUENT contacts (data-plane PATCH, never a clobbering
 * re-sync). Best-effort + fully guarded: never throws, never blocks the reply.
 *
 * WHY first-vs-subsequent matters (verified in bi-edge src/db):
 *   upsertSyncBatch → upsertLead runs `INSERT OR REPLACE INTO leads (...)`, a
 *   WHOLE-ROW overwrite (leads.ts). A re-sync of an existing key would reset
 *   stage→raw, status→pending_review and NULL pitch_subject/pitch_body/
 *   classification. The PATCH path (updateLead, `UPDATE leads SET <patched
 *   cols>, updated_at=now WHERE key=?`) preserves every other column, so an
 *   approved/sent lead is never downgraded when the same person DMs again.
 */
async function captureOrUpdateLead(
  deps: SocialDeps,
  msg: SocialInbound,
  contacts: { emails: string[]; handles: string[] },
  leadKey: string,
): Promise<void> {
  const cacheKey = `${SOCIAL_LEAD_PREFIX}${leadKey}`;
  const state = await deps.store
    .cacheGet<SocialLeadState>(cacheKey, SOCIAL_CACHE_AGENT)
    .catch(() => null);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const emailsPresent = contacts.emails.length > 0;

  const writeCache = (s: SocialLeadState) =>
    deps.store.cacheSet(cacheKey, SOCIAL_CACHE_AGENT, s, null).catch(() => {});

  // ── FIRST contact → full sync (create the lead). ─────────────────
  if (!state) {
    const newState: SocialLeadState = {
      firstCapturedAt: nowIso,
      lastSeenAt: nowIso,
      messageCount: 1,
      emailCaptured: emailsPresent,
      syncedStage: "raw",
      firstMessage: msg.text.slice(0, 500),
      firstKind: msg.kind,
    };
    const ok = await fullSyncLead(deps, msg, contacts, leadKey, null);
    if (ok) {
      await writeCache(newState);
      await audit(deps, "social.lead_captured", {
        key: leadKey,
        platform: msg.platform,
        kind: msg.kind,
        username: msg.username ?? null,
        messageCount: 1,
        emailCaptured: emailsPresent,
      });
    } else {
      // Engine unreachable/failed → do NOT write cache so the next contact
      // re-attempts a first-capture. Reply flow continues unaffected.
      await audit(deps, "social.error", {
        stage: "lead_capture",
        platform: msg.platform,
        key: leadKey,
        error: "full sync failed after retry (lead is re-capturable on next contact)",
      });
    }
    return;
  }

  // ── SUBSEQUENT contact ───────────────────────────────────────────
  const messageCount = state.messageCount + 1;
  const withinWindow = now - Date.parse(state.lastSeenAt) < SOCIAL_LEAD_DEDUPE_MS;
  const newEmail = emailsPresent && !state.emailCaptured;

  // Rapid-fire debounce: repeat contact inside the window only bumps the count
  // (cache read/write, NO second HTTP call). A newly-found email still defers to
  // the next out-of-window contact so we never clobber with a burst of patches.
  if (withinWindow && !newEmail) {
    await writeCache({ ...state, lastSeenAt: nowIso, messageCount });
    await audit(deps, "social.lead_updated", {
      key: leadKey,
      platform: msg.platform,
      kind: msg.kind,
      username: msg.username ?? null,
      messageCount,
      emailCaptured: state.emailCaptured,
      deduped: true,
    });
    return;
  }

  const updatedState: SocialLeadState = {
    ...state,
    lastSeenAt: nowIso,
    messageCount,
    emailCaptured: state.emailCaptured || newEmail,
  };
  const patch: Record<string, unknown> = {
    research: JSON.stringify(mergedResearch(msg, updatedState)),
  };
  if (newEmail) patch.emails = emailsJson(contacts.emails);

  const result = await patchLead(deps, leadKey, patch);

  if (result.missing) {
    // Row vanished (deleted / never persisted) → fall back to a full re-capture.
    const ok = await fullSyncLead(deps, msg, contacts, leadKey, updatedState);
    if (ok) {
      await writeCache(updatedState);
      await audit(deps, "social.lead_updated", {
        key: leadKey,
        platform: msg.platform,
        kind: msg.kind,
        username: msg.username ?? null,
        messageCount,
        emailCaptured: updatedState.emailCaptured,
        recaptured: true,
      });
    } else {
      await audit(deps, "social.error", {
        stage: "lead_capture",
        platform: msg.platform,
        key: leadKey,
        error: "re-capture full sync failed after retry",
      });
    }
    return;
  }

  if (result.ok) {
    await writeCache(updatedState);
    await audit(deps, "social.lead_updated", {
      key: leadKey,
      platform: msg.platform,
      kind: msg.kind,
      username: msg.username ?? null,
      messageCount,
      emailCaptured: updatedState.emailCaptured,
    });
    return;
  }

  // Patch failed (transient) → keep the existing cache state untouched so the
  // next contact retries cleanly; audit + continue (reply flow unaffected).
  await audit(deps, "social.error", {
    stage: "lead_capture",
    platform: msg.platform,
    key: leadKey,
    error: "data-row patch failed after retry",
  });
}


// ─── Draft generation ────────────────────────────────────────────

function buildPrompt(msg: SocialInbound): string {
  const who = msg.username ? `@${msg.username}` : `user ${msg.externalUserId}`;
  return [
    `You are the business account's social assistant. Reply to a ${msg.platform} ${msg.kind}.`,
    `Message from ${who}:`,
    msg.text,
    "",
    `Reply in persona: warm, helpful, and under ${MAX_REPLY_CHARS} characters. Plain text only (no markdown, no hashtags).`,
  ].join("\n");
}

/** Extract a plain string from a Mastra agent generate() result. */
function extractAgentText(out: unknown): string {
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    const o = out as { text?: unknown; error?: unknown };
    if (o.error) return `Error: ${errorMessage(o.error)}`;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

/**
 * Produce the reply draft for a matched trigger. `llmError` forces the approval
 * path (degrade-to-human) even when the trigger mode is "auto".
 */
async function resolveDraft(
  deps: SocialDeps,
  msg: SocialInbound,
  trigger: ResolvedTrigger,
): Promise<{ draft?: string; llmError: boolean }> {
  if (trigger.action === "reply") {
    return { draft: trigger.reply ?? "", llmError: false };
  }
  if (trigger.action === "agent") {
    const agentId = trigger.agentId ?? deps.config.replyAgent ?? "miles";
    try {
      const agent = await deps.resolveAgent(agentId);
      if (!agent || typeof agent.generate !== "function") {
        throw new Error(`agent "${agentId}" is not available`);
      }
      const out = await agent.generate([{ role: "user", content: buildPrompt(msg) }]);
      const text = stripMarkdown(extractAgentText(out)).trim();
      if (!text) throw new Error("agent returned an empty reply");
      return { draft: truncate(text, MAX_REPLY_CHARS), llmError: false };
    } catch (err) {
      // Degrade: never crash — hand the raw inbound text to a human as the draft.
      await audit(deps, "social.error", {
        stage: "agent",
        agentId,
        platform: msg.platform,
        error: errorMessage(err),
      });
      return { draft: msg.text, llmError: true };
    }
  }
  // action "capture" | "none" → no reply.
  return { llmError: false };
}

// ─── Send + approval routing ─────────────────────────────────────

/** Deliver a reply through the shared per-platform rate-limited queue. */
async function sendReply(
  msg: SocialInbound,
  adapter: SocialAdapter,
  draft: string,
): Promise<void> {
  await enqueueSocialSend(msg.platform, () =>
    msg.commentId && adapter.sendPrivateReply
      ? adapter.sendPrivateReply(msg.commentId, draft)
      : adapter.sendText(msg.externalUserId, draft),
  );
}

/** Best-effort relay of the approval to the edge /events/ingest (web UI inbox). */
async function relayApproval(deps: SocialDeps, req: ApprovalRequest): Promise<void> {
  const base = deps.config.edgeEventsUrl.replace(/\/+$/, "");
  try {
    const frame = callaFrame(CALLA_EVENTS.approvalRequest, req);
    await fetch(`${base}/events/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frame),
    });
  } catch (err) {
    // Non-fatal: the notifier's 15s Mastra poll still surfaces the approval.
    console.warn("[channels:social] approval relay failed:", errorMessage(err));
  }
}

/** Record the HITL approval + register the social decision context + relay. */
async function routeToApproval(
  deps: SocialDeps,
  msg: SocialInbound,
  draft: string,
  leadKey?: string,
  note?: string,
): Promise<void> {
  const risk = msg.kind === "comment" ? "high" : "medium";
  const toolName = `social-${msg.platform}-${msg.kind}`;
  const identity = msg.username || msg.externalUserId;

  let row;
  try {
    row = await deps.store.recordApproval({
      source: "mastra",
      agentId: SOCIAL_CACHE_AGENT,
      toolName,
      args: {
        platform: msg.platform,
        externalUserId: msg.externalUserId,
        username: msg.username ?? null,
        text: msg.text,
        draft,
        commentId: msg.commentId ?? null,
        // Additive: expose the dedupe lead identity so an approver (or a later
        // data-plane action) can link the reply back to the captured lead.
        // decisions.contextFromApproval() ignores unknown args → routing is
        // byte-compatible.
        ...(leadKey ? { leadKey } : {}),
      },
      risk,
      summary: `Reply to @${identity} on ${msg.platform}`,
      status: "pending",
    });
  } catch (err) {
    console.warn("[channels:social] recordApproval failed:", errorMessage(err));
    await audit(deps, "social.error", {
      stage: "approval",
      platform: msg.platform,
      error: errorMessage(err),
    });
    return;
  }

  // Register the full context so a pressed Approve/Decline button (from any
  // existing Telegram/WhatsApp card) routes back to the platform adapter.
  try {
    deps.registry.register({
      source: "social",
      approvalId: row.id,
      agentId: row.agentId,
      toolName,
      createdAt: Date.now(),
      platform: msg.platform,
      externalUserId: msg.externalUserId,
      ...(msg.username ? { username: msg.username } : {}),
      draft,
      ...(msg.commentId ? { commentId: msg.commentId } : {}),
    });
  } catch (err) {
    console.warn("[channels:social] registry.register failed:", errorMessage(err));
  }

  await relayApproval(deps, rowToApprovalRequest(row));
  await audit(deps, "social.approval_created", {
    approvalId: row.id,
    platform: msg.platform,
    kind: msg.kind,
    risk,
    externalUserId: maskChatId(msg.externalUserId),
  });

  // Conversation thread: an approval is NOT a delivery, so it is recorded as a
  // "system" notice (kind "system" + approvalId) — the draft itself lives in
  // the approval row and is recorded as "approval_result" once approved
  // (channels/decisions.ts) or as a declined notice when it is not.
  await recordOut(
    deps,
    msg,
    `(awaiting operator approval — nothing sent${note ? `: ${note}` : ""})`,
    "system",
    row.id,
  );
}

// ─── Qualification-flow handoff (src/flows runner) ───────────────

/**
 * Conversation identity used for the flows active-run lookup: the SAME
 * chatRef startFlow() stores, so subsequent messages from this social user
 * are routed into the runner (channel "social").
 */
export function socialChatRef(msg: SocialInbound): string {
  return `${msg.platform}:${msg.externalUserId}`;
}

/**
 * Flow-run channel per platform: WhatsApp customer runs are recorded with
 * channel "whatsapp" (chatRef `whatsapp:<phone>`) so REST-started runs and
 * webhook-started runs share ONE active-run identity; IG/TikTok keep the
 * existing channel "social".
 */
export function socialFlowChannel(platform: SocialPlatform): FlowChannel {
  return platform === "whatsapp" ? "whatsapp" : "social";
}

/**
 * Send a flow prompt/closing message under the social send policy:
 * mode "auto" AND inside the platform reply window → adapter send (audited
 * {auto:true, flow:true}); window closed, approval mode, or a failed send →
 * the EXISTING HITL approval card path with the prompt text as the draft.
 */
async function sendFlowMessage(
  deps: SocialDeps,
  msg: SocialInbound,
  text: string,
  mode: SocialTrigger["mode"],
  leadKey?: string,
): Promise<void> {
  const adapter = deps.adapters[msg.platform];
  if (!adapter || !adapter.enabled) {
    await routeToApproval(deps, msg, text, leadKey, `${msg.platform} adapter unavailable`);
    return;
  }
  let windowOk = true;
  try {
    windowOk = adapter.withinWindow
      ? await adapter.withinWindow(msg.externalUserId)
      : true;
  } catch {
    windowOk = false;
  }
  // Why this prompt needs a human (recorded on the thread's approval notice).
  let note = mode === "auto" ? "outside the platform reply window" : "approval mode";
  if (mode === "auto" && windowOk) {
    try {
      await sendReply(msg, adapter, text);
      await audit(deps, "social.sent", {
        auto: true,
        flow: true,
        platform: msg.platform,
        kind: msg.kind,
        externalUserId: maskChatId(msg.externalUserId),
        chars: text.length,
      });
      await recordOut(deps, msg, text, "flow_prompt");
      return;
    } catch (err) {
      await audit(deps, "social.error", {
        stage: "flow_send",
        platform: msg.platform,
        error: errorMessage(err),
      });
      note = "auto-send failed";
      // fall through — a failed auto-send still deserves a human retry.
    }
  }
  await routeToApproval(deps, msg, text, leadKey, note);
}

/** Feed one inbound message to an ACTIVE flow run; send the resulting prompt. */
async function handleFlowAnswer(
  deps: SocialDeps,
  msg: SocialInbound,
  runId: string,
  leadKey: string,
): Promise<void> {
  const result = await answerFlow(deps.store, runId, msg.text).catch((err) => {
    console.warn("[channels:social] answerFlow failed:", errorMessage(err));
    return null;
  });
  if (!result) return;
  if (result.error !== undefined) {
    await audit(deps, "social.error", {
      stage: "flow_answer",
      runId,
      platform: msg.platform,
      error: result.error,
    });
    return;
  }
  await audit(deps, "social.flow_step", {
    runId,
    platform: msg.platform,
    kind: msg.kind,
    matched: result.matched ?? null,
    done: Boolean(result.done),
    field: result.prompt?.field ?? null,
    score: result.summary?.score ?? null,
    tier: result.summary?.tier ?? null,
    externalUserId: maskChatId(msg.externalUserId),
  });
  const text = result.done
    ? result.summary?.message ?? null
    : result.prompt
      ? formatPromptText(result.prompt)
      : null;
  if (!text) return;
  // In-run messages follow the auto-within-window policy (the run itself was
  // started under the operator's configured trigger).
  await sendFlowMessage(deps, msg, text, "auto", leadKey);
}

/** Trigger action "flow": start the qualification run + send the first prompt. */
async function handleFlowStart(
  deps: SocialDeps,
  msg: SocialInbound,
  trigger: ResolvedTrigger,
  leadKey: string,
): Promise<void> {
  const flowId = (trigger as SocialTrigger).flowId;
  if (!flowId) {
    await audit(deps, "social.error", {
      stage: "flow_start",
      platform: msg.platform,
      error: "trigger action 'flow' has no flowId",
    });
    return;
  }
  const started = await startFlow(deps.store, {
    flowId,
    leadKey,
    channel: socialFlowChannel(msg.platform),
    chatRef: socialChatRef(msg),
  }).catch((err) => {
    console.warn("[channels:social] startFlow failed:", errorMessage(err));
    return null;
  });
  if (!started || started.error !== undefined) {
    await audit(deps, "social.error", {
      stage: "flow_start",
      flowId,
      platform: msg.platform,
      error: started?.error ?? "startFlow failed",
    });
    return;
  }
  await audit(deps, "social.flow_started", {
    runId: started.run.id,
    flowId,
    platform: msg.platform,
    kind: msg.kind,
    leadKey,
    externalUserId: maskChatId(msg.externalUserId),
  });
  // Conversation thread: link the run so GET /conversations/:id can enrich it
  // with flowRun {status, currentField, answers, score, tier, routing}.
  await conversations(deps).linkFlowRun(threadId(msg), started.run.id);
  const text = started.done
    ? started.summary?.message ?? null
    : started.prompt
      ? formatPromptText(started.prompt)
      : null;
  if (text) {
    await sendFlowMessage(deps, msg, text, trigger.mode ?? "approval", leadKey);
  }
}

// ─── Main entry point ────────────────────────────────────────────

/**
 * Process one normalized inbound social event end-to-end. Never throws — every
 * stage is guarded so a webhook always gets a 200 and the server never crashes.
 */
export async function handleSocialInbound(
  msg: SocialInbound,
  deps: SocialDeps,
): Promise<void> {
  const adapter = deps.adapters[msg.platform];

  // (a) reply window + received audit.
  try {
    if (adapter?.markWindow) await adapter.markWindow(msg.externalUserId);
  } catch {
    // window tracking is best-effort
  }
  await audit(deps, "social.received", {
    platform: msg.platform,
    kind: msg.kind,
    externalUserId: maskChatId(msg.externalUserId),
    username: msg.username ?? null,
    hasCommentId: Boolean(msg.commentId),
    chars: msg.text.length,
  });

  // (a2) CONVERSATION-THREAD RECORDING (additive). EVERY normalized inbound —
  // Instagram, TikTok and WhatsApp customer chats (they all funnel through
  // here) — is appended to the operator console's thread store BEFORE any
  // automation decision, so the console shows the customer's words even when
  // everything downstream is skipped (takeover, action "none", no adapter).
  const convs = conversations(deps);
  const convId = threadId(msg);
  await convs.recordInbound({
    platform: msg.platform,
    externalUserId: msg.externalUserId,
    ...(msg.username ? { username: msg.username } : {}),
    text: msg.text,
    ...(msg.ts ? { ts: msg.ts } : {}),
  });

  // Load triggers + match (specific before fallback).
  const config = await loadTriggers(deps);
  const { trigger, specific } = matchTrigger(config, msg);

  // (b) lead capture (capture-by-default). The dedupe identity is stable, so we
  // compute it up-front and thread it into the approval args below.
  const leadKey = socialLeadKey(msg);
  const contacts = extractContacts(msg.text);
  if (deps.config.leadCapture) {
    // EVERY dm | comment | story_mention becomes a lead; postbacks keep the
    // legacy opt-in gating (captureLead trigger or extracted contact info).
    const defaultCapture = msg.kind !== "postback";
    const legacyCapture =
      Boolean(trigger.captureLead) ||
      contacts.emails.length > 0 ||
      contacts.handles.length > 0;
    if (defaultCapture || legacyCapture) {
      await captureOrUpdateLead(deps, msg, contacts, leadKey);
      // Thread link (additive): the console shows which engine lead this chat
      // belongs to, whether the capture created or updated it.
      await convs.linkLead(convId, leadKey);
    }
  }

  // (b2) TAKEOVER GATE (additive). An operator can pause automation for ONE
  // thread (POST /conversations/:id/takeover {on:true}): lead capture and the
  // inbound recording above still run, but NOTHING automatic is sent and no
  // flow starts or advances (an active run stays as it is and resumes on the
  // next message after takeover is switched off, within its 48h TTL). Manual
  // operator replies via POST /conversations/:id/message are unaffected.
  if (await convs.isTakeover(convId)) {
    await audit(deps, "social.takeover_skipped", {
      platform: msg.platform,
      kind: msg.kind,
      conversationId: convId,
      leadKey,
      externalUserId: maskChatId(msg.externalUserId),
    });
    return;
  }

  // (c0) QUALIFICATION-FLOW HANDOFF (additive). An ACTIVE run on this
  // conversation identity (channel "social" — or "whatsapp" for WhatsApp
  // customers, so REST-started runs share the identity — chatRef
  // `<platform>:<externalUserId>`) consumes every subsequent message: it goes
  // into the flows runner instead of trigger/persona handling — NO persona
  // reply while a flow owns the chat. Capture-by-default still fired above,
  // so leads keep flowing to the engine while the qualification is in
  // progress.
  const chatRef = socialChatRef(msg);
  const activeRunId = await getActiveRun(
    deps.store,
    socialFlowChannel(msg.platform),
    chatRef,
  ).catch(() => null);
  if (activeRunId) {
    // Thread link (additive): keep flowRunId current for REST-started runs too.
    await convs.linkFlowRun(convId, activeRunId);
    await handleFlowAnswer(deps, msg, activeRunId, leadKey);
    return;
  }

  // (c1) trigger action "flow" → start the qualification run, send its first
  // prompt under the trigger's send policy (auto within window / approval).
  if (trigger.action === "flow") {
    await handleFlowStart(deps, msg, trigger, leadKey);
    return;
  }

  // (c) resolve the draft (reply/agent); capture/none stop here.
  if (trigger.action === "none" || trigger.action === "capture") {
    return;
  }
  const { draft, llmError } = await resolveDraft(deps, msg, trigger);
  if (draft == null) return;

  // (d) send policy.
  if (!adapter || !adapter.enabled) {
    // Platform disabled/unwired → surface to a human rather than drop silently.
    await routeToApproval(deps, msg, draft, leadKey, `${msg.platform} adapter unavailable`);
    return;
  }

  let windowOk = true;
  try {
    windowOk = adapter.withinWindow
      ? await adapter.withinWindow(msg.externalUserId)
      : true;
  } catch {
    windowOk = false;
  }

  const mode = trigger.mode ?? "approval";
  if (mode === "auto" && windowOk && !llmError) {
    try {
      await sendReply(msg, adapter, draft);
      await audit(deps, "social.sent", {
        auto: true,
        platform: msg.platform,
        kind: msg.kind,
        specific,
        externalUserId: maskChatId(msg.externalUserId),
        chars: draft.length,
      });
      await recordOut(deps, msg, draft, replyKind(trigger));
    } catch (err) {
      await audit(deps, "social.error", {
        stage: "send",
        platform: msg.platform,
        error: errorMessage(err),
      });
      // A failed auto-send still deserves a human retry.
      await routeToApproval(deps, msg, draft, leadKey, "auto-send failed");
    }
    return;
  }

  await routeToApproval(
    deps,
    msg,
    draft,
    leadKey,
    llmError
      ? "persona reply degraded to a human draft"
      : mode === "auto"
        ? "outside the platform reply window"
        : "approval mode",
  );
}
