/**
 * InstagramAdapter — Meta "Instagram API with Instagram Login" transport.
 *
 * ── PLATFORM FACTS (verified 2026) ─────────────────────────────────────────
 * • Base URL: https://graph.instagram.com/v21.0 (override IG_API_BASE for the
 *   legacy graph.facebook.com mode, or a local mock server for tests).
 * • Send DM: POST {base}/me/messages  {recipient:{id}, message:{text}}
 *   Authorization: `Bearer IG_ACCESS_TOKEN`.
 * • Comment reply = "private reply":
 *   POST {base}/{commentId}/private_replies  {recipient:{comment_id}, message:{text}}
 *   ONE reply per comment, within 7 days of the comment. The path template is
 *   configurable (IG_PRIVATE_REPLY_PATH, `{commentId}` token) because Meta has
 *   moved this endpoint between API surfaces before.
 * • Webhook GET verification echoes hub.challenge when hub.verify_token equals
 *   IG_VERIFY_TOKEN. Webhook POST bodies carry X-Hub-Signature-256 =
 *   HMAC-sha256(rawBody, IG_APP_SECRET); verified with timingSafeEqual when the
 *   secret is set (accepted-but-warned when unset, matching the WhatsApp adapter).
 * • Inbound payload shape:
 *   { object:"instagram",
 *     entry:[ { messaging:[ {sender:{id}, recipient:{id}, timestamp,
 *                            message:{mid,text} | postback:{payload}} ],
 *               comments:[ {id, from:{id,username}, message, media, timestamp} ] } ] }
 *   → normalized to SocialInbound {platform, kind, externalUserId, username?,
 *     text, commentId?, ts, raw}.
 * • There is a 24h reply window from the last inbound message; we track it in
 *   the store cache under "social:ig:window:<id>" (TTL 24h). Outside the window
 *   auto-send is blocked and the engine routes to approval instead.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { CallaStore } from "../../store/types.js";
import type {
  InstagramConfig,
  SocialAdapter,
  SocialInbound,
} from "./types.js";
import { SOCIAL_CACHE_AGENT, IG_WINDOW_PREFIX, IG_WINDOW_TTL_MS } from "./keys.js";
import { truncate } from "../util.js";

const IG_TEXT_LIMIT = 1000; // Instagram DM text cap (conservative).

export interface InstagramAdapterOverrides {
  /** Injectable API base (mock tests). Defaults to config.instagram.apiBase. */
  apiBase?: string;
}

export class InstagramAdapter implements SocialAdapter {
  readonly platform = "instagram" as const;
  readonly enabled: boolean;

  private readonly accessToken?: string;
  private readonly appSecret?: string;
  private readonly verifyToken?: string;
  private readonly apiBase: string;
  private readonly privateReplyPath: string;
  private readonly store: CallaStore;

  constructor(
    config: InstagramConfig,
    store: CallaStore,
    overrides: InstagramAdapterOverrides = {},
  ) {
    this.accessToken = config.accessToken;
    this.appSecret = config.appSecret;
    this.verifyToken = config.verifyToken;
    this.apiBase = overrides.apiBase ?? config.apiBase;
    this.privateReplyPath = config.privateReplyPath;
    this.store = store;
    this.enabled = config.enabled;
  }

  // ─── Graph API plumbing ─────────────────────────────────────────

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.accessToken) h.authorization = `Bearer ${this.accessToken}`;
    return h;
  }

  private async post(path: string, payload: Record<string, unknown>): Promise<void> {
    const url = `${this.apiBase}/${path.replace(/^\//, "")}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`Instagram send failed ${res.status}: ${truncate(detail, 200)}`);
    }
  }

  // ─── SocialAdapter ──────────────────────────────────────────────

  /** Send a DM to a user id: POST {base}/me/messages. */
  async sendText(id: string, text: string): Promise<void> {
    await this.post("me/messages", {
      recipient: { id },
      message: { text: truncate(text, IG_TEXT_LIMIT) },
    });
  }

  /** Send a comment private reply: POST {base}/{commentId}/private_replies. */
  async sendPrivateReply(commentId: string, text: string): Promise<void> {
    const path = this.privateReplyPath.replace(/\{commentId\}/g, encodeURIComponent(commentId));
    await this.post(path, {
      recipient: { comment_id: commentId },
      message: { text: truncate(text, IG_TEXT_LIMIT) },
    });
  }

  // ─── 24h reply window (store-cache backed) ──────────────────────

  /** Mark the reply window open for a user (TTL 24h). */
  async markWindow(id: string): Promise<void> {
    await this.store
      .cacheSet(
        `${IG_WINDOW_PREFIX}${id}`,
        SOCIAL_CACHE_AGENT,
        { ts: Date.now() },
        IG_WINDOW_TTL_MS,
      )
      .catch(() => {});
  }

  /** True when the user's 24h reply window is still open. */
  async withinWindow(id: string): Promise<boolean> {
    const rec = await this.store
      .cacheGet(`${IG_WINDOW_PREFIX}${id}`, SOCIAL_CACHE_AGENT)
      .catch(() => null);
    return rec != null;
  }

  // ─── Webhook verification ───────────────────────────────────────

  /**
   * GET verification: echo hub.challenge when hub.mode === "subscribe" and
   * hub.verify_token matches IG_VERIFY_TOKEN; otherwise null. Accepts both flat
   * ("hub.mode") and bracket ("hub[mode]") query keys.
   */
  verifyWebhook(query: Record<string, string | undefined>): string | null {
    const mode = query["hub.mode"] ?? query["hub[mode]"];
    const token = query["hub.verify_token"] ?? query["hub[verify_token]"];
    const challenge = query["hub.challenge"] ?? query["hub[challenge]"];
    if (mode === "subscribe" && this.verifyToken && token === this.verifyToken) {
      return challenge ?? null;
    }
    return null;
  }

  /**
   * POST signature check: sha256 HMAC of the raw body with IG_APP_SECRET vs the
   * X-Hub-Signature-256 header (timingSafeEqual). When the secret is unset we
   * ACCEPT but WARN (dev convenience; set IG_APP_SECRET in production).
   */
  validateSignature(
    rawBody: string,
    headers: Record<string, string | undefined>,
  ): { ok: boolean; warned: boolean } {
    if (!this.appSecret) {
      console.warn(
        "[channels:social:instagram] IG_APP_SECRET unset — accepting webhook WITHOUT HMAC verification",
      );
      return { ok: true, warned: true };
    }
    const signature =
      headers["x-hub-signature-256"] ?? headers["X-Hub-Signature-256"];
    if (!signature) return { ok: false, warned: false };
    const expected = `sha256=${createHmac("sha256", this.appSecret)
      .update(rawBody, "utf8")
      .digest("hex")}`;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signature.trim(), "utf8");
    if (a.length !== b.length) return { ok: false, warned: false };
    return { ok: timingSafeEqual(a, b), warned: false };
  }

  // ─── Webhook parsing (normalize → SocialInbound[]) ──────────────

  /** Fold an Instagram webhook body into normalized inbound events. */
  parseWebhook(body: unknown): SocialInbound[] {
    const out: SocialInbound[] = [];
    try {
      const entries = (body as { entry?: unknown })?.entry;
      if (!Array.isArray(entries)) return out;
      for (const entry of entries) {
        const e = (entry ?? {}) as Record<string, unknown>;

        // 1) Direct messages + postbacks + story mentions.
        const messaging = e.messaging;
        if (Array.isArray(messaging)) {
          for (const item of messaging as Record<string, any>[]) {
            const senderId = item?.sender?.id != null ? String(item.sender.id) : undefined;
            if (!senderId) continue;
            const ts = typeof item?.timestamp === "number" ? item.timestamp : undefined;

            if (item?.postback?.payload != null) {
              out.push({
                platform: "instagram",
                kind: "postback",
                externalUserId: senderId,
                text: String(item.postback.payload),
                ...(ts ? { ts } : {}),
                raw: item,
              });
              continue;
            }

            const message = item?.message;
            if (message && typeof message === "object") {
              const text = String(message.text ?? "");
              // Story mentions arrive as a message with a `story_mention` field.
              const kind: SocialInbound["kind"] = message.story_mention
                ? "story_mention"
                : "dm";
              out.push({
                platform: "instagram",
                kind,
                externalUserId: senderId,
                text,
                ...(ts ? { ts } : {}),
                raw: item,
              });
            }
          }
        }

        // 2) Comments (reply via private_replies).
        const comments = e.comments;
        if (Array.isArray(comments)) {
          for (const item of comments as Record<string, any>[]) {
            const commentId = item?.id != null ? String(item.id) : undefined;
            const fromId = item?.from?.id != null ? String(item.from.id) : undefined;
            if (!commentId || !fromId) continue;
            const username =
              item?.from?.username != null ? String(item.from.username) : undefined;
            const ts = typeof item?.timestamp === "number" ? item.timestamp : undefined;
            out.push({
              platform: "instagram",
              kind: "comment",
              externalUserId: fromId,
              ...(username ? { username } : {}),
              text: String(item?.message ?? ""),
              commentId,
              ...(ts ? { ts } : {}),
              raw: item,
            });
          }
        }
      }
    } catch (err) {
      console.warn("[channels:social:instagram] parseWebhook failed:", err);
    }
    return out;
  }
}
