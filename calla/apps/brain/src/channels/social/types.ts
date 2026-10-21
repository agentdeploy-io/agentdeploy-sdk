/**
 * Social messaging channels (Instagram + TikTok + WhatsApp customers) — shared types.
 *
 * This module is a ManyChat-style reply-automation add-on for BUSINESS social
 * accounts, built on the OFFICIAL platform APIs (Meta "Instagram API with
 * Instagram Login" and the TikTok Business Messaging API / Login Kit v2). It
 * follows the same self-contained, dependency-free discipline as the rest of
 * src/channels (global fetch + node:crypto only) and plugs into channels/app.ts
 * exactly like the Telegram/WhatsApp adapters.
 *
 * ── PLATFORM FACTS (verified 2026, keep in sync with README) ──────────────
 * Instagram — official API is the "Instagram API with Instagram Login":
 *   base https://graph.instagram.com/v21.0 (override IG_API_BASE for the legacy
 *   graph.facebook.com mode). Send DM: POST {base}/me/messages
 *   {recipient:{id}, message:{text}} with `Bearer IG_ACCESS_TOKEN`. Comment
 *   reply is a "private reply": POST {base}/{commentId}/private_replies
 *   {recipient:{comment_id}, message:{text}} — ONE per comment, within 7 days
 *   (path template configurable via IG_PRIVATE_REPLY_PATH). Webhooks: GET
 *   verification echoes hub.challenge when hub.verify_token === IG_VERIFY_TOKEN;
 *   POST bodies carry X-Hub-Signature-256 = HMAC-sha256(raw, IG_APP_SECRET).
 *   There is a 24h reply window from the last inbound message and a ~2 sends/sec
 *   rate limit (we space sends 600ms via the shared queue).
 *
 * TikTok — official API is the Business Messaging API (Login Kit v2 OAuth) and
 *   REQUIRES a Business account. Automation is only permitted in USER-INITIATED
 *   conversations. Comment-to-message is REGION-GATED (partial SEA rollout; NOT
 *   available in the EEA/UK/CH). The exact production endpoint paths cannot be
 *   verified without keys, so ALL paths are isolated in config with env
 *   overrides (TIKTOK_API_BASE, TIKTOK_SEND_PATH) and flagged with TODO comments
 *   to re-verify against the TikTok developer portal when keys arrive.
 */
import type { CallaStore } from "../../store/types.js";
import type { DecisionRegistry } from "../types.js";

// ─── Platforms & inbound normalization ───────────────────────────

/**
 * "whatsapp" (WAVE-2): CUSTOMER conversations on the business WhatsApp line.
 * The WhatsApp Cloud API webhook lives in channels/whatsapp.ts (operator
 * console first); messages from chats that are NOT bound operators are
 * normalized to SocialInbound {platform:"whatsapp", kind:"dm",
 * externalUserId:<wa_id phone, leading + stripped>} and funneled through
 * handleSocialInbound like any other platform. Lead keys are `WA:<phone>`,
 * flow runs use channel "whatsapp" (chatRef `whatsapp:<phone>`), and sends go
 * out as plain text messages via the existing Graph send (sendWhatsAppText).
 * WhatsApp Cloud API enforces a 24h customer-service window from the last
 * inbound message — tracked at "social:wa:window:<phone>" (same pattern as
 * IG). Outside the window auto-send is blocked → the approval-card path
 * handles it. TEMPLATE messages (window re-openers) are OUT OF SCOPE.
 */
export type SocialPlatform = "instagram" | "tiktok" | "whatsapp";

/** What surfaced the inbound event. */
export type SocialKind = "dm" | "comment" | "postback" | "story_mention";

/**
 * One normalized inbound social event. Every platform webhook parser folds its
 * native shape into this so the engine is transport-agnostic.
 */
export interface SocialInbound {
  platform: SocialPlatform;
  kind: SocialKind;
  /** Platform-scoped user id (IG sender.id / TikTok sender.user_id). */
  externalUserId: string;
  /** Public @handle when the platform provides one (IG comments do). */
  username?: string;
  /** Inbound text (message body, comment text, or postback payload). */
  text: string;
  /** IG comment id — required to send a private reply. */
  commentId?: string;
  /** Platform event timestamp (ms epoch) when present. */
  ts?: number;
  /** The untouched native event (audit/debug only). */
  raw?: unknown;
}

// ─── Trigger / automation model ──────────────────────────────────

/** Where a trigger applies. */
export type SocialScope = "dm" | "comment" | "any";
/** How a trigger's `value` is matched against the inbound text. */
export type SocialMatch = "keyword" | "regex" | "any";
/**
 * What to do on match. "flow" (additive) starts a qualification flow from
 * src/flows (see flows/runner.ts) and hands the conversation to the runner:
 * every subsequent inbound message from the same chatRef is fed to
 * answerFlow() until the run completes/cancels (or the 48h active-run TTL
 * lapses) — no persona replies while a flow owns the conversation.
 */
export type SocialAction = "reply" | "agent" | "capture" | "none" | "flow";
/** Send straight away, or gate behind a HITL approval. */
export type SocialMode = "auto" | "approval";

/**
 * A single reply-automation rule. Persisted (as part of TriggersConfig) in the
 * store cache under key "social:triggers" (agentId "social").
 */
export interface SocialTrigger {
  /** Optional stable id (audit/UI convenience). */
  id?: string;
  scope: SocialScope;
  match: SocialMatch;
  /** keyword substring / regex source (ignored when match === "any"). */
  value?: string;
  action: SocialAction;
  /** Static reply text (action === "reply"). */
  reply?: string;
  /** Persona agent id (action === "agent"); defaults to SOCIAL_REPLY_AGENT). */
  agentId?: string;
  /** Flow definition id (action === "flow"; REQUIRED — e.g. "retrofit-solar-qualification"). */
  flowId?: string;
  mode: SocialMode;
  /** Force lead capture for this trigger even without extracted contact info. */
  captureLead?: boolean;
}

/** Per-platform default applied when no specific trigger matches. */
export interface SocialFallback {
  action: SocialAction;
  mode: SocialMode;
  reply?: string;
  agentId?: string;
  captureLead?: boolean;
}

/**
 * Full persisted trigger configuration.
 *
 * NOTE ON SHAPE: the task summary describes `fallback:{action, mode}`, but the
 * required safety-first seed defaults differ per platform (Instagram DMs may
 * auto-reply inside the 24h window; TikTok DMs must ALWAYS require approval
 * because automation is only allowed in user-initiated conversations and the
 * comment-to-message path is region-gated). A single flat fallback cannot
 * express both, so `fallback` is keyed per platform. Each entry is still the
 * minimal `{action, mode}` (+ optional reply/agentId/captureLead).
 */
export interface TriggersConfig {
  instagram: SocialTrigger[];
  tiktok: SocialTrigger[];
  /** WhatsApp customer conversations (unbound chats on the business line). */
  whatsapp: SocialTrigger[];
  fallback: {
    instagram: SocialFallback;
    tiktok: SocialFallback;
    whatsapp: SocialFallback;
  };
}

// ─── Adapter contract ────────────────────────────────────────────

/**
 * Transport-agnostic social adapter. Both InstagramAdapter and TikTokAdapter
 * implement this; the engine only ever touches these members so it stays
 * platform-neutral and mockable.
 */
export interface SocialAdapter {
  readonly platform: SocialPlatform;
  /** True when the platform's required credentials are present. */
  readonly enabled: boolean;
  /** Send a DM / conversation message to a user id. */
  sendText(target: string, text: string): Promise<void>;
  /** Send an IG comment "private reply" (comment platforms only). */
  sendPrivateReply?(commentId: string, text: string): Promise<void>;
  /** Mark the reply window open for a user (IG 24h). No-op where N/A. */
  markWindow?(id: string): Promise<void>;
  /** Whether an auto-send to this user is inside the reply window. */
  withinWindow?(id: string): Promise<boolean>;
  /** Fold a native webhook body into normalized inbound events. */
  parseWebhook(body: unknown): SocialInbound[];
}

// ─── Config ──────────────────────────────────────────────────────

export interface InstagramConfig {
  /** True when IG_ACCESS_TOKEN is present. */
  enabled: boolean;
  appId?: string;
  appSecret?: string;
  verifyToken?: string;
  accessToken?: string;
  /** Graph base (IG_API_BASE) — override is REQUIRED for mock testing. */
  apiBase: string;
  /** Private-reply path template with a `{commentId}` token. */
  privateReplyPath: string;
  /** Redirect URI for the code→token exchange helper. */
  redirectUri?: string;
}

export type TikTokWebhookMode = "challenge" | "body";

export interface TikTokConfig {
  /** True when TIKTOK_ACCESS_TOKEN is present. */
  enabled: boolean;
  accessToken?: string;
  verifyToken?: string;
  /** challenge → GET hub.challenge echo; body → token carried in the POST body. */
  webhookMode: TikTokWebhookMode;
  /** Business API base (TIKTOK_API_BASE). TODO verify with real keys. */
  apiBase: string;
  /** DM send path (TIKTOK_SEND_PATH). TODO verify with real keys. */
  sendPath: string;
  advertiserId?: string;
  bcId?: string;
}

/**
 * WhatsApp customer-conversation switch. Send credentials live in the
 * channels config (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_API_BASE);
 * this only gates whether UNBOUND inbound chats are treated as customers.
 */
export interface WhatsAppSocialConfig {
  /** WHATSAPP_CUSTOMER_MODE !== "false" (default true). */
  customerMode: boolean;
}

export interface SocialConfig {
  instagram: InstagramConfig;
  tiktok: TikTokConfig;
  whatsapp: WhatsAppSocialConfig;
  /** Default persona agent id (SOCIAL_REPLY_AGENT, default "miles"). */
  replyAgent: string;
  /** bi-edge /inbound/sync URL for lead capture (SOCIAL_ENGINE_SYNC_URL). */
  engineSyncUrl?: string;
  /** X-AD-Sync header value (SOCIAL_ENGINE_SYNC_SECRET). */
  engineSyncSecret?: string;
  /**
   * Engine data-plane ORIGIN for /cmd/data/row lead PATCHes. Explicit override
   * via SOCIAL_ENGINE_DATA_URL; otherwise derived from engineSyncUrl by
   * stripping the trailing `/inbound/sync`. Subsequent social contacts patch
   * (never full-re-sync) so an already-approved/sent lead is never downgraded.
   */
  engineDataUrl?: string;
  /**
   * Capture-by-default: EVERY dm | comment | story_mention inbound becomes a
   * lead (not just when an email/@handle is present). SOCIAL_LEAD_CAPTURE,
   * default true; set to "false" to disable all social lead capture.
   */
  leadCapture: boolean;
  /** Edge base for the /events/ingest approval relay. */
  edgeEventsUrl: string;
}

// ─── Engine dependencies (injected by app.ts) ────────────────────

export interface SocialDeps {
  store: CallaStore;
  /** Shared short-id decision registry (same instance the notifier uses). */
  registry: DecisionRegistry;
  config: SocialConfig;
  /** Resolve a store-driven persona agent (dynamic-agents.resolveDynamicAgent). */
  resolveAgent: (agentId: string) => Promise<any | null>;
  /** Live adapters, keyed by platform (undefined when disabled). */
  adapters: Partial<Record<SocialPlatform, SocialAdapter>>;
}
