/**
 * TikTokAdapter — TikTok Business Messaging API (Login Kit v2 OAuth) transport.
 *
 * ── PLATFORM FACTS (2026) ──────────────────────────────────────────────────
 * • REQUIRES a TikTok **Business** account. Automation is only permitted inside
 *   USER-INITIATED conversations (we never cold-DM).
 * • Comment-to-message is REGION-GATED: a partial Southeast-Asia rollout, and it
 *   is NOT available in the EEA / UK / Switzerland. See TIKTOK_REGION_WARNING
 *   (config.ts), surfaced by GET /channels.
 *
 * ── ⚠️ PATHS NEED PORTAL VERIFICATION WITH REAL KEYS ───────────────────────
 * The exact production endpoint paths for the Business Messaging API cannot be
 * confirmed without developer credentials. EVERY path is isolated in config
 * (TIKTOK_API_BASE, TIKTOK_SEND_PATH) with env overrides, and the send call
 * below is marked TODO(tiktok-keys). When real keys arrive, verify against the
 * TikTok developer portal (Login Kit v2 → Business Messaging) and adjust the
 * defaults in config.ts — do NOT trust them blindly.
 *
 * Webhook verification supports two modes (TIKTOK_WEBHOOK_MODE):
 *   • "challenge" (default) — GET echoes hub.challenge when hub.verify_token
 *     matches TIKTOK_VERIFY_TOKEN (Meta-style handshake).
 *   • "body" — the verification token is carried in the POST body; the route
 *     calls verifyWebhookBody(body) instead.
 * Inbound parsing is DEFENSIVE: the documented shape is
 *   { event:"message.receive", data:{ conversation_id, message:{ text,
 *     sender:{ user_id } } } }
 * but unknown shapes are logged and yield zero events (HTTP 200 regardless).
 */
import type {
  SocialAdapter,
  SocialInbound,
  TikTokConfig,
} from "./types.js";
import { truncate } from "../util.js";

const TIKTOK_TEXT_LIMIT = 1000;

export interface TikTokAdapterOverrides {
  /** Injectable API base (mock tests). Defaults to config.apiBase. */
  apiBase?: string;
}

export class TikTokAdapter implements SocialAdapter {
  readonly platform = "tiktok" as const;
  readonly enabled: boolean;

  private readonly accessToken?: string;
  private readonly verifyToken?: string;
  private readonly webhookMode: TikTokConfig["webhookMode"];
  private readonly apiBase: string;
  private readonly sendPath: string;
  private readonly advertiserId?: string;
  private readonly bcId?: string;

  constructor(config: TikTokConfig, overrides: TikTokAdapterOverrides = {}) {
    this.accessToken = config.accessToken;
    this.verifyToken = config.verifyToken;
    this.webhookMode = config.webhookMode;
    this.apiBase = overrides.apiBase ?? config.apiBase;
    this.sendPath = config.sendPath;
    this.advertiserId = config.advertiserId;
    this.bcId = config.bcId;
    this.enabled = config.enabled;
  }

  // ─── SocialAdapter ──────────────────────────────────────────────

  /**
   * Send a DM to a conversation/user.
   * TODO(tiktok-keys): VERIFY the method, path, auth header, and body schema
   * against the TikTok Business Messaging API portal. The Business/Marketing
   * open_api conventionally uses an `Access-Token` header (not Bearer) and
   * query-scoped advertiser/business-center ids; we send both defensively.
   * The response envelope is not trusted — any non-2xx is treated as failure.
   */
  async sendText(target: string, text: string): Promise<void> {
    const query = new URLSearchParams();
    if (this.advertiserId) query.set("advertiser_id", this.advertiserId);
    if (this.bcId) query.set("bc_id", this.bcId);
    const qs = query.toString();
    const url = `${this.apiBase}/${this.sendPath.replace(/^\//, "")}${qs ? `?${qs}` : ""}`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.accessToken) {
      headers["Access-Token"] = this.accessToken;
      headers.authorization = `Bearer ${this.accessToken}`;
    }
    // TODO(tiktok-keys): confirm recipient/text field names in the portal.
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        recipient: { user_id: target },
        message: { text: truncate(text, TIKTOK_TEXT_LIMIT) },
      }),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`TikTok send failed ${res.status}: ${truncate(detail, 200)}`);
    }
  }

  // ─── Webhook verification ───────────────────────────────────────

  /**
   * GET handshake (challenge mode): echo hub.challenge when hub.verify_token
   * matches TIKTOK_VERIFY_TOKEN; otherwise null.
   */
  verifyWebhook(query: Record<string, string | undefined>): string | null {
    const mode = query["hub.mode"] ?? query["hub[mode]"];
    const token = query["hub.verify_token"] ?? query["hub[verify_token]"];
    const challenge = query["hub.challenge"] ?? query["hub[challenge]"];
    // Accept the Meta-style handshake; some TikTok setups omit hub.mode.
    const modeOk = mode === "subscribe" || mode == null;
    if (modeOk && this.verifyToken && token === this.verifyToken) {
      return challenge ?? null;
    }
    return null;
  }

  /**
   * POST handshake (body mode): the verification token/challenge arrive in the
   * body. Returns the challenge string to echo when the token matches, else null.
   */
  verifyWebhookBody(body: unknown): string | null {
    const b = (body ?? {}) as Record<string, any>;
    const token = b.verify_token ?? b.token ?? b["hub.verify_token"];
    const challenge = b.challenge ?? b["hub.challenge"];
    if (this.verifyToken && token === this.verifyToken) {
      return challenge != null ? String(challenge) : "";
    }
    return null;
  }

  /** Which handshake the route should honor ("challenge" | "body"). */
  get verificationMode(): TikTokConfig["webhookMode"] {
    return this.webhookMode;
  }

  // ─── Webhook parsing (defensive normalize → SocialInbound[]) ────

  /**
   * Fold a TikTok webhook body into normalized inbound events. Unknown shapes
   * are logged and produce zero events (the route still returns HTTP 200 so
   * TikTok does not retry-storm).
   */
  parseWebhook(body: unknown): SocialInbound[] {
    const out: SocialInbound[] = [];
    try {
      const b = (body ?? {}) as Record<string, any>;
      const event = b.event ?? b.type;
      const data = (b.data ?? b) as Record<string, any>;
      const message = data.message ?? data;

      // Documented: { event:"message.receive", data:{ message:{ text, sender:{user_id} } } }
      const isMessage =
        event === "message.receive" ||
        event === "message" ||
        (message && (message.text != null || message.content != null));

      if (!isMessage) {
        console.warn(
          "[channels:social:tiktok] unrecognized webhook shape (ignored):",
          truncate(JSON.stringify(b) ?? "", 300),
        );
        return out;
      }

      const userId =
        message?.sender?.user_id ??
        message?.sender?.id ??
        data?.sender?.user_id ??
        data?.user_id ??
        data?.conversation_id;
      if (userId == null) {
        console.warn("[channels:social:tiktok] message.receive without a sender id (ignored)");
        return out;
      }
      const text = String(message?.text ?? message?.content ?? "");
      const tsRaw = message?.create_time ?? message?.timestamp ?? data?.timestamp;
      const ts = typeof tsRaw === "number" ? tsRaw : undefined;

      out.push({
        platform: "tiktok",
        kind: "dm",
        externalUserId: String(userId),
        text,
        ...(ts ? { ts } : {}),
        raw: b,
      });
    } catch (err) {
      console.warn("[channels:social:tiktok] parseWebhook failed:", err);
    }
    return out;
  }
}
