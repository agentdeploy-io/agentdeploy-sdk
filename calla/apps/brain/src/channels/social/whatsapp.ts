/**
 * WhatsAppSocialAdapter — the social-engine transport for CUSTOMER WhatsApp
 * conversations (WAVE-2). Complements channels/whatsapp.ts, which stays the
 * operator console + webhook front door: unbound inbound chats are normalized
 * there (extractWhatsAppInbound → toWhatsAppSocialInbound) and funneled into
 * handleSocialInbound; this adapter gives the engine the platform-neutral
 * send + 24h-window members it needs.
 *
 * ── PLATFORM FACTS ─────────────────────────────────────────────────────────
 * • Send: POST {WHATSAPP_API_BASE}/{PHONE_NUMBER_ID}/messages with
 *   `Bearer WHATSAPP_TOKEN` — the SAME Cloud API call the operator console
 *   uses (shared sendWhatsAppText() helper), type "text" (4096-char cap).
 * • WhatsApp Cloud API enforces a 24h CUSTOMER-SERVICE WINDOW from the last
 *   inbound customer message. We track it in the store cache at
 *   "social:wa:window:<phone>" (TTL 24h, same pattern as IG_WINDOW_PREFIX).
 *   Outside the window a free-form send is REJECTED by Meta (error 131047) —
 *   the engine's send policy then blocks auto-send and the HITL approval card
 *   path takes over (a human can respond via a template in the Meta inbox).
 * • TEMPLATE messages (pre-approved window re-openers) are OUT OF SCOPE for
 *   this module — see channels/README.md → "WhatsApp customer conversations".
 * • Lead keys are `WA:<phone>` (phone = wa_id, leading + stripped); flow runs
 *   use channel "whatsapp" with chatRef `whatsapp:<phone>`.
 */
import type { CallaStore } from "../../store/types.js";
import {
  extractWhatsAppInbound,
  sendWhatsAppText,
  toWhatsAppSocialInbound,
  type WhatsAppSendConfig,
} from "../whatsapp.js";
import { SOCIAL_CACHE_AGENT, WA_WINDOW_PREFIX, WA_WINDOW_TTL_MS } from "./keys.js";
import type { SocialAdapter, SocialInbound } from "./types.js";

export class WhatsAppSocialAdapter implements SocialAdapter {
  readonly platform = "whatsapp" as const;
  readonly enabled: boolean;

  private readonly cfg: WhatsAppSendConfig;
  private readonly store: CallaStore;

  /**
   * @param cfg      Cloud API send config (from ChannelsConfig.whatsapp).
   * @param store    CallaStore for the 24h window cache.
   * @param enabled  false when the platform credentials are missing or
   *                 WHATSAPP_CUSTOMER_MODE=false (engine then degrades every
   *                 send to the approval path).
   */
  constructor(cfg: WhatsAppSendConfig, store: CallaStore, enabled: boolean) {
    this.cfg = cfg;
    this.store = store;
    this.enabled = enabled;
  }

  // ─── SocialAdapter ──────────────────────────────────────────────

  /** Send a plain text message to a phone number (wa_id, no +). */
  async sendText(target: string, text: string): Promise<void> {
    await sendWhatsAppText(this.cfg, target, text);
  }

  // ─── 24h customer-service window (store-cache backed) ───────────

  /** Mark the 24h customer-service window open for a phone (TTL 24h). */
  async markWindow(id: string): Promise<void> {
    await this.store
      .cacheSet(
        `${WA_WINDOW_PREFIX}${id}`,
        SOCIAL_CACHE_AGENT,
        { ts: Date.now() },
        WA_WINDOW_TTL_MS,
      )
      .catch(() => {});
  }

  /** True when the phone's 24h customer-service window is still open. */
  async withinWindow(id: string): Promise<boolean> {
    const rec = await this.store
      .cacheGet(`${WA_WINDOW_PREFIX}${id}`, SOCIAL_CACHE_AGENT)
      .catch(() => null);
    return rec != null;
  }

  // ─── Webhook parsing ────────────────────────────────────────────

  /**
   * Fold a native WhatsApp webhook body into normalized customer events.
   * The live webhook path parses in channels/whatsapp.ts (it must consult
   * bindings first); this exists for adapter-contract completeness + QA.
   */
  parseWebhook(body: unknown): SocialInbound[] {
    const out: SocialInbound[] = [];
    for (const item of extractWhatsAppInbound(body)) {
      const msg = toWhatsAppSocialInbound(item);
      if (msg) out.push(msg);
    }
    return out;
  }
}
