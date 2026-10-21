/**
 * WhatsAppAdapter — Meta WhatsApp Business Cloud API transport.
 *
 * GRAPH base is WHATSAPP_API_BASE (default https://graph.facebook.com/v21.0);
 * messages POST to /<PHONE_NUMBER_ID>/messages with `Bearer WHATSAPP_TOKEN`.
 * Webhooks are verified two ways:
 *   - GET  verifyWebhook(query) -> hub.challenge (hub.verify_token match)
 *   - POST verifySignature(rawBody, X-Hub-Signature-256) -> sha256 HMAC with
 *     WHATSAPP_APP_SECRET (timingSafeEqual). When the secret is unset we ACCEPT
 *     but WARN (dev convenience).
 *
 * WhatsApp cannot edit a sent message, so after a decision we send a follow-up
 * confirmation text. Cards render as `interactive` reply buttons (max 3,
 * title <= 20 chars, payload = the compact callback id).
 *
 * ── CUSTOMER MODE (WAVE-2) ─────────────────────────────────────────────────
 * The webhook serves TWO audiences on the same business number:
 *   • BOUND operator chats (bindings.ts) — the existing console behavior
 *     EXACTLY (status/approvals/ask/unbind + approval reply buttons).
 *   • UNBOUND chats — when WHATSAPP_CUSTOMER_MODE !== "false" (default on) they
 *     are treated as CUSTOMERS: text messages normalize to a SocialInbound
 *     {platform:"whatsapp", kind:"dm", externalUserId:<wa_id, leading +
 *     stripped>, username:<contact profile name>} and are handed to the
 *     injected customer handler (app.ts wires it to the social engine's
 *     handleSocialInbound → capture-by-default lead `WA:<phone>`, triggers,
 *     qualification-flow handoff, persona reply/approval). An unbound chat can
 *     STILL redeem a 6-char binding code (checked before customer routing) so
 *     operators can bind exactly as before. Interactive button replies always
 *     keep the console decision path. Template messages (24h-window
 *     re-openers) are OUT OF SCOPE — outside the window, auto-send degrades to
 *     the HITL approval card. See channels/README.md → "WhatsApp customer
 *     conversations".
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { buildApprovalCard, executeDecision } from "./decisions.js";
import { askOrchestrator, fleetSummary, helpText } from "./commands.js";
import type {
  BindingStore,
  ChannelAdapter,
  ChannelDeps,
  ChannelsConfig,
  DecisionRegistry,
  OutboundCard,
} from "./types.js";
import type { SocialInbound } from "./social/types.js";
import { chunkText, errorMessage, maskChatId, truncate } from "./util.js";

const TEXT_LIMIT = 4096;
const INTERACTIVE_BODY_LIMIT = 1024;
const BUTTON_TITLE_LIMIT = 20;
const MAX_BUTTONS = 3;

// ─── Shared Cloud API text send (operator console + social engine) ───

/** Minimal send config — matches ChannelsConfig["whatsapp"] structurally. */
export interface WhatsAppSendConfig {
  apiBase: string;
  token?: string;
  phoneNumberId?: string;
}

/**
 * Send a plain text WhatsApp message via the Cloud API:
 * POST {apiBase}/{phoneNumberId}/messages with `Bearer token`. Shared by the
 * operator console adapter AND the social "whatsapp" sender so customer
 * replies/prompts use the exact same transport. Throws on non-2xx.
 */
export async function sendWhatsAppText(
  cfg: WhatsAppSendConfig,
  to: string,
  text: string,
): Promise<void> {
  if (!cfg.phoneNumberId) {
    throw new Error("WhatsApp send failed: WHATSAPP_PHONE_NUMBER_ID is not configured");
  }
  const url = `${cfg.apiBase}/${cfg.phoneNumberId}/messages`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (cfg.token) headers.authorization = `Bearer ${cfg.token}`;
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to,
      type: "text",
      text: { body: truncate(text, TEXT_LIMIT), preview_url: false },
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    throw new Error(`WhatsApp send failed ${res.status}: ${truncate(detail, 200)}`);
  }
}

// ─── Webhook inbound extraction ─────────────────────────────────────

/** One normalized inbound item from entry[].changes[].value.messages[]. */
export interface WhatsAppInboundItem {
  /** wa_id (phone number, E.164 without +). */
  from: string;
  /** "text" | "interactive" | anything else (media etc. — ignored upstream). */
  type: string;
  /** Text body (type "text"). */
  text?: string;
  /** Button/list reply payload (type "interactive"). */
  payload?: string;
  /** Profile name from the webhook's value.contacts[] when present. */
  profileName?: string;
  /** Event timestamp (ms epoch) when present. */
  ts?: number;
  /** The untouched native message (audit/debug only). */
  raw?: unknown;
}

/**
 * Fold a WhatsApp webhook body into normalized inbound items. Delivery
 * `statuses` (no messages array) yield nothing. Defensive: never throws.
 */
export function extractWhatsAppInbound(body: unknown): WhatsAppInboundItem[] {
  const out: WhatsAppInboundItem[] = [];
  try {
    const entries = (body as { entry?: unknown })?.entry;
    if (!Array.isArray(entries)) return out;
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown })?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const value = ((change as { value?: Record<string, unknown> })?.value ??
          {}) as Record<string, any>;
        const messages = value.messages;
        if (!Array.isArray(messages)) continue;
        // contacts: [{ wa_id, profile: { name } }] — profile names per sender.
        const names = new Map<string, string>();
        if (Array.isArray(value.contacts)) {
          for (const ct of value.contacts as Record<string, any>[]) {
            const wid = ct?.wa_id != null ? String(ct.wa_id) : undefined;
            const nm = ct?.profile?.name != null ? String(ct.profile.name) : undefined;
            if (wid && nm) names.set(wid, nm);
          }
        }
        for (const msg of messages as Record<string, any>[]) {
          const from = msg?.from != null ? String(msg.from) : undefined;
          if (!from) continue;
          const item: WhatsAppInboundItem = { from, type: String(msg?.type ?? ""), raw: msg };
          const profileName = names.get(from);
          if (profileName) item.profileName = profileName;
          const ts = Number(msg?.timestamp);
          if (Number.isFinite(ts) && ts > 0) item.ts = ts;
          if (msg?.type === "text") {
            item.text = String(msg?.text?.body ?? "");
          } else if (msg?.type === "interactive") {
            const interactive = msg?.interactive ?? {};
            const reply =
              interactive?.button_reply ?? interactive?.nwa_reply ?? interactive?.list_reply;
            const payload = reply?.payload ?? reply?.id;
            if (payload != null) item.payload = String(payload);
          }
          out.push(item);
        }
      }
    }
  } catch (err) {
    console.warn("[channels:whatsapp] inbound parse failed:", errorMessage(err));
  }
  return out;
}

/** Normalize inbound text items to SocialInbound (platform "whatsapp"). */
export function toWhatsAppSocialInbound(item: WhatsAppInboundItem): SocialInbound | null {
  if (item.type !== "text") return null;
  const text = String(item.text ?? "").trim();
  if (!text) return null;
  return {
    platform: "whatsapp",
    kind: "dm",
    externalUserId: item.from.replace(/^\+/, ""),
    ...(item.profileName ? { username: item.profileName } : {}),
    text,
    ...(item.ts ? { ts: item.ts } : {}),
    raw: item.raw,
  };
}

/**
 * Customer-mode handoff injected by app.ts (keeps this module free of any
 * runtime dependency on the social engine — the handler is a closure over
 * handleSocialInbound(msg, socialDeps)).
 */
export interface WhatsAppCustomerHandler {
  /** WHATSAPP_CUSTOMER_MODE !== "false". */
  enabled: boolean;
  /** Route one normalized customer message (never throws — guarded by caller). */
  handle(msg: SocialInbound): Promise<void>;
}

export interface WhatsAppAdapterContext {
  registry: DecisionRegistry;
  bindings: BindingStore;
  /** Unbound-chat customer routing (see module header). */
  customer?: WhatsAppCustomerHandler;
}

export class WhatsAppAdapter implements ChannelAdapter {
  readonly platform = "whatsapp" as const;
  readonly enabled: boolean;

  private readonly token?: string;
  private readonly phoneNumberId?: string;
  private readonly apiBase: string;
  private readonly verifyToken?: string;
  private readonly appSecret?: string;
  private readonly registry: DecisionRegistry;
  private readonly bindings: BindingStore;
  private readonly customer?: WhatsAppCustomerHandler;

  constructor(config: ChannelsConfig, ctx: WhatsAppAdapterContext) {
    this.token = config.whatsapp.token;
    this.phoneNumberId = config.whatsapp.phoneNumberId;
    this.apiBase = config.whatsapp.apiBase;
    this.verifyToken = config.whatsapp.verifyToken;
    this.appSecret = config.whatsapp.appSecret;
    this.registry = ctx.registry;
    this.bindings = ctx.bindings;
    this.customer = ctx.customer;
    this.enabled = config.whatsapp.enabled;
  }

  // ─── Cloud API plumbing ───────────────────────────────────────

  private async post(payload: Record<string, unknown>): Promise<void> {
    const url = `${this.apiBase}/${this.phoneNumberId}/messages`;
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      throw new Error(`WhatsApp send failed ${res.status}: ${truncate(detail, 200)}`);
    }
  }

  // ─── ChannelAdapter ───────────────────────────────────────────

  async sendMessage(chatId: string, text: string, card?: OutboundCard): Promise<void> {
    const body = card?.text ?? text;
    const buttons = (card?.buttons ?? []).slice(0, MAX_BUTTONS);
    if (buttons.length > 0) {
      await this.post({
        messaging_product: "whatsapp",
        recipient_type: "individual",
        to: chatId,
        type: "interactive",
        interactive: {
          type: "button",
          body: { text: truncate(body, INTERACTIVE_BODY_LIMIT) },
          action: {
            buttons: buttons.map((b) => ({
              type: "reply",
              reply: {
                id: b.callbackData,
                title: truncate(b.label, BUTTON_TITLE_LIMIT),
              },
            })),
          },
        },
      });
      return;
    }
    await this.post({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: chatId,
      type: "text",
      text: { body: truncate(body, TEXT_LIMIT), preview_url: false },
    });
  }

  /** Send-config snapshot for the shared sendWhatsAppText() helper. */
  sendConfig(): WhatsAppSendConfig {
    return {
      apiBase: this.apiBase,
      ...(this.token ? { token: this.token } : {}),
      ...(this.phoneNumberId ? { phoneNumberId: this.phoneNumberId } : {}),
    };
  }

  /** WhatsApp cannot edit — send a follow-up confirmation instead. */
  async editOrFollowUp(
    chatId: string,
    _messageId: string | undefined,
    text: string,
  ): Promise<void> {
    await this.sendMessage(chatId, text);
  }

  // ─── Webhook verification ─────────────────────────────────────

  /**
   * GET verification: return hub.challenge when hub.mode === "subscribe" and
   * hub.verify_token matches WHATSAPP_VERIFY_TOKEN; otherwise null.
   * Accepts both flat ("hub.mode") and bracket ("hub[mode]") query keys.
   */
  verifyWebhook(query: Record<string, string | undefined>): string | null {
    const mode = query["hub.mode"] ?? query["hub[mode]"];
    const verifyToken = query["hub.verify_token"] ?? query["hub[verify_token]"];
    const challenge = query["hub.challenge"] ?? query["hub[challenge]"];
    if (mode === "subscribe" && this.verifyToken && verifyToken === this.verifyToken) {
      return challenge ?? null;
    }
    return null;
  }

  /**
   * POST signature check: sha256 HMAC of the raw body with WHATSAPP_APP_SECRET,
   * compared to `X-Hub-Signature-256` via timingSafeEqual. When the secret is
   * unset we accept but WARN (never crash the webhook).
   */
  verifySignature(
    rawBody: string,
    signatureHeader: string | undefined,
  ): { ok: boolean; warned: boolean } {
    if (!this.appSecret) {
      console.warn(
        "[channels:whatsapp] WHATSAPP_APP_SECRET unset — accepting webhook WITHOUT HMAC verification",
      );
      return { ok: true, warned: true };
    }
    if (!signatureHeader) return { ok: false, warned: false };
    const expected = `sha256=${createHmac("sha256", this.appSecret)
      .update(rawBody, "utf8")
      .digest("hex")}`;
    const a = Buffer.from(expected, "utf8");
    const b = Buffer.from(signatureHeader.trim(), "utf8");
    if (a.length !== b.length) return { ok: false, warned: false };
    return { ok: timingSafeEqual(a, b), warned: false };
  }

  // ─── Webhook event handling ───────────────────────────────────

  /** Process a (signature-verified) webhook body: entry[].changes[].value.messages[]. */
  async handleWebhookEvent(body: unknown, deps: ChannelDeps): Promise<void> {
    try {
      for (const item of extractWhatsAppInbound(body)) {
        if (item.type === "text") {
          await this.onInboundText(item, deps);
        } else if (item.type === "interactive" && item.payload) {
          // Button replies are ALWAYS the operator-console decision path
          // (cards only ever reach bound chats; unbound presses degrade to the
          // friendly "not recognized" reply, exactly as before).
          await this.onButton(item.from, item.payload, deps);
        }
      }
    } catch (err) {
      console.warn("[channels:whatsapp] event handling failed:", errorMessage(err));
    }
  }

  /**
   * Route one inbound TEXT message: bound operator → console (unchanged);
   * unbound + customer mode → social engine; otherwise legacy console.
   */
  private async onInboundText(item: WhatsAppInboundItem, deps: ChannelDeps): Promise<void> {
    const raw = String(item.text ?? "").trim();
    if (!raw) return;
    const { from } = item;

    if (this.customer?.enabled) {
      // Fail-safe: a bindings-store error keeps the LEGACY console path rather
      // than leaking an operator command into the customer pipeline.
      let bound = true;
      try {
        bound = await this.bindings.isBound("whatsapp", from);
      } catch (err) {
        console.warn("[channels:whatsapp] isBound failed (using console path):", errorMessage(err));
      }
      if (!bound) {
        // Binding-code escape hatch: an unbound chat can still redeem a code
        // (a lone 6-char alnum token) so operators bind exactly as before.
        if (/^[A-Za-z0-9]{6}$/.test(raw)) {
          const boundNow = await this.tryBind(from, raw);
          if (boundNow) return;
        }
        const msg = toWhatsAppSocialInbound(item);
        if (msg) {
          try {
            await this.customer.handle(msg);
          } catch (err) {
            console.warn("[channels:whatsapp] customer routing failed:", errorMessage(err));
          }
          return;
        }
      }
    }

    await this.onText(from, raw, deps);
  }

  private async onButton(from: string, payload: string, deps: ChannelDeps): Promise<void> {
    const result = await executeDecision({
      deps,
      registry: this.registry,
      callbackData: payload,
      platform: "whatsapp",
      chatId: from,
    });
    await this.sendMessage(from, result.text);
  }

  private async onText(from: string, text: string, deps: ChannelDeps): Promise<void> {
    const raw = String(text ?? "").trim();
    if (!raw) return;
    const lower = raw.toLowerCase();

    if (lower === "help") {
      await this.sendMessage(from, helpText("whatsapp"));
      return;
    }
    if (lower === "status") {
      await this.sendMessage(from, await fleetSummary(deps));
      return;
    }
    if (lower === "approvals") {
      await this.cmdApprovals(from, deps);
      return;
    }
    if (lower === "unbind") {
      await this.cmdUnbind(from);
      return;
    }
    if (lower.startsWith("ask ")) {
      await this.cmdAsk(from, raw.slice(4), deps);
      return;
    }
    // A lone 6-char alnum token is treated as a binding code; if it is not a
    // valid code we fall through and treat it as a normal message.
    if (/^[A-Za-z0-9]{6}$/.test(raw)) {
      const bound = await this.tryBind(from, raw);
      if (bound) return;
    }
    await this.cmdAsk(from, raw, deps);
  }

  // ─── Commands ─────────────────────────────────────────────────

  private async tryBind(from: string, code: string): Promise<boolean> {
    try {
      await this.bindings.redeemBindingCode(code, "whatsapp", from, null);
      await this.sendMessage(
        from,
        `✅ Chat bound (${maskChatId(from)}). You'll receive approval alerts here. Send 'status' or 'approvals'.`,
      );
      return true;
    } catch {
      return false;
    }
  }

  private async cmdUnbind(from: string): Promise<void> {
    try {
      await this.bindings.unbind("whatsapp", from);
      await this.sendMessage(from, "👋 This chat was unbound from Calla.");
    } catch (err) {
      await this.sendMessage(from, `⚠️ Could not unbind: ${errorMessage(err)}`);
    }
  }

  private async cmdApprovals(from: string, deps: ChannelDeps): Promise<void> {
    let pending;
    try {
      pending = await deps.listPendingMastra();
    } catch (err) {
      await this.sendMessage(from, `⚠️ Could not load approvals: ${errorMessage(err)}`);
      return;
    }
    if (!pending.length) {
      await this.sendMessage(from, "No pending approvals. 🎉");
      return;
    }
    for (const req of pending.slice(0, 5)) {
      const card = buildApprovalCard(this.registry, req);
      await this.sendMessage(from, card.text, card);
    }
    if (pending.length > 5) {
      await this.sendMessage(from, `…and ${pending.length - 5} more.`);
    }
  }

  private async cmdAsk(from: string, text: string, deps: ChannelDeps): Promise<void> {
    const reply = await askOrchestrator(deps, text);
    for (const chunk of chunkText(reply, TEXT_LIMIT)) {
      await this.sendMessage(from, chunk);
    }
  }
}
