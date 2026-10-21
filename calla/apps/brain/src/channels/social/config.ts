/**
 * Social channels configuration — pure env → SocialConfig.
 *
 * Mirrors channels/config.ts readConfig(): every platform is enabled iff its
 * required credential is present, and every API path is overridable so the
 * module can be exercised against local mock servers with no real keys.
 *
 * ── TikTok path caveat ─────────────────────────────────────────────────────
 * The exact production endpoint paths for the TikTok Business Messaging API
 * cannot be verified without developer keys. They are therefore isolated here
 * (TIKTOK_API_BASE / TIKTOK_SEND_PATH) with TODO markers. VERIFY each against
 * the TikTok developer portal (Login Kit v2 / Business Messaging) when real
 * keys arrive — do NOT assume the defaults are final.
 */
import type {
  InstagramConfig,
  SocialConfig,
  TikTokConfig,
  TikTokWebhookMode,
} from "./types.js";

// Instagram API with Instagram Login (2026). Override IG_API_BASE for the
// legacy graph.facebook.com mode or a local mock.
const DEFAULT_IG_API_BASE = "https://graph.instagram.com/v21.0";
// One private reply per comment, within 7 days. `{commentId}` is substituted.
const DEFAULT_IG_PRIVATE_REPLY_PATH = "{commentId}/private_replies";

// TODO(tiktok-keys): VERIFY against the TikTok developer portal with real keys.
const DEFAULT_TIKTOK_API_BASE = "https://business-api.tiktok.com/open_api/v1.3";
// TODO(tiktok-keys): VERIFY the DM send path (Business Messaging API) with keys.
const DEFAULT_TIKTOK_SEND_PATH = "im/dm/send/";

const DEFAULT_EDGE = "http://127.0.0.1:8787";

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function tiktokWebhookMode(value: string | undefined): TikTokWebhookMode {
  return clean(value)?.toLowerCase() === "body" ? "body" : "challenge";
}

/**
 * Derive the engine data-plane ORIGIN from the /inbound/sync URL by stripping
 * the trailing `/inbound/sync` (so `${base}/cmd/data/row` resolves). Falls back
 * to the sync URL's trailing-slash-stripped form when the suffix is absent.
 */
function deriveEngineDataUrl(syncUrl: string | undefined): string | undefined {
  if (!syncUrl) return undefined;
  return stripTrailingSlash(syncUrl.replace(/\/inbound\/sync\/?$/i, ""));
}

/**Truthy env flag with a default; "false"/"0"/"no"/"off" (any case) disable. */
function boolFlag(value: string | undefined, dflt: boolean): boolean {
  const v = clean(value)?.toLowerCase();
  if (v == null) return dflt;
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

/** Read + normalize the social channels config from the environment (pure). */
export function readSocialConfig(): SocialConfig {
  const env = process.env;

  const igToken = clean(env.IG_ACCESS_TOKEN);
  const ttToken = clean(env.TIKTOK_ACCESS_TOKEN);

  const edgeEventsUrl = stripTrailingSlash(
    clean(env.CHANNELS_EDGE_EVENTS_URL) ?? clean(env.CALLA_EDGE_URL) ?? DEFAULT_EDGE,
  );

  const instagram: InstagramConfig = {
    enabled: Boolean(igToken),
    appId: clean(env.IG_APP_ID),
    appSecret: clean(env.IG_APP_SECRET),
    verifyToken: clean(env.IG_VERIFY_TOKEN),
    accessToken: igToken,
    apiBase: stripTrailingSlash(clean(env.IG_API_BASE) ?? DEFAULT_IG_API_BASE),
    privateReplyPath: clean(env.IG_PRIVATE_REPLY_PATH) ?? DEFAULT_IG_PRIVATE_REPLY_PATH,
    redirectUri: clean(env.IG_REDIRECT_URI),
  };

  const tiktok: TikTokConfig = {
    enabled: Boolean(ttToken),
    accessToken: ttToken,
    verifyToken: clean(env.TIKTOK_VERIFY_TOKEN),
    webhookMode: tiktokWebhookMode(env.TIKTOK_WEBHOOK_MODE),
    apiBase: stripTrailingSlash(clean(env.TIKTOK_API_BASE) ?? DEFAULT_TIKTOK_API_BASE),
    sendPath: clean(env.TIKTOK_SEND_PATH) ?? DEFAULT_TIKTOK_SEND_PATH,
    advertiserId: clean(env.TIKTOK_ADVERTISER_ID),
    bcId: clean(env.TIKTOK_BC_ID),
  };

  return {
    instagram,
    tiktok,
    whatsapp: {
      // Customer mode is ON by default; only an explicit "false" disables it
      // (unbound WhatsApp chats then keep the legacy operator-console path).
      customerMode: boolFlag(env.WHATSAPP_CUSTOMER_MODE, true),
    },
    replyAgent: clean(env.SOCIAL_REPLY_AGENT) ?? "miles",
    engineSyncUrl: clean(env.SOCIAL_ENGINE_SYNC_URL),
    engineSyncSecret: clean(env.SOCIAL_ENGINE_SYNC_SECRET),
    engineDataUrl:
      clean(env.SOCIAL_ENGINE_DATA_URL) ??
      deriveEngineDataUrl(clean(env.SOCIAL_ENGINE_SYNC_URL)),
    leadCapture: boolFlag(env.SOCIAL_LEAD_CAPTURE, true),
    edgeEventsUrl,
  };
}

/**
 * Loud, human-readable warning about the TikTok comment-to-message region gate.
 * Surfaced by GET /channels so operators cannot miss it.
 */
export const TIKTOK_REGION_WARNING =
  "TikTok automation is only permitted in USER-INITIATED conversations and " +
  "comment-to-message is REGION-GATED (partial SEA rollout; NOT available in " +
  "the EEA/UK/CH). Verify availability for the account's region before " +
  "enabling comment flows.";
