/**
 * TelegramAdapter — Telegram Bot API transport (sendMessage with HTML parse
 * mode + inline keyboards, callback_query handling, webhook updates, and a
 * long-polling dev loop). The Bot API base URL is TELEGRAM_API_BASE (default
 * https://api.telegram.org); overriding it is REQUIRED for mock testing.
 *
 * Buttons carry the compact callback payload `c:<shortId>:<a|d>` (see
 * decisions.ts) — well under Telegram's 64-byte callback_data cap.
 */
import {
  buildApprovalCard,
  executeDecision,
} from "./decisions.js";
import { askOrchestrator, fleetSummary, helpText } from "./commands.js";
import type {
  ChannelAdapter,
  ChannelDeps,
  ChannelsConfig,
  DecisionRegistry,
  BindingStore,
  OutboundButton,
  OutboundCard,
} from "./types.js";
import {
  chunkText,
  errorMessage,
  escapeHtml,
  maskChatId,
  sleep,
} from "./util.js";

// ─── Telegram wire shapes (loose — inbound JSON) ─────────────────

interface TgChat {
  id: number | string;
}
interface TgMessage {
  message_id: number;
  chat: TgChat;
  text?: string;
  from?: { id?: number | string };
}
interface TgCallbackQuery {
  id: string;
  data?: string;
  message?: TgMessage;
  from?: { id?: number | string };
}
export interface TgUpdate {
  update_id?: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

interface TgApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
}

const MAX_MESSAGE_LEN = 4096;
const POLL_TIMEOUT_SEC = 25;
const POLL_ERROR_BACKOFF_MS = 3000;

/** Lay buttons out into inline_keyboard rows (2 per row). */
function toInlineKeyboard(
  buttons?: OutboundButton[],
): { text: string; callback_data: string }[][] | undefined {
  if (!buttons || buttons.length === 0) return undefined;
  const rows: { text: string; callback_data: string }[][] = [];
  for (let i = 0; i < buttons.length; i += 2) {
    rows.push(
      buttons.slice(i, i + 2).map((b) => ({
        text: b.label.slice(0, 64),
        callback_data: b.callbackData.slice(0, 64),
      })),
    );
  }
  return rows;
}

export interface TelegramAdapterContext {
  registry: DecisionRegistry;
  bindings: BindingStore;
}

export class TelegramAdapter implements ChannelAdapter {
  readonly platform = "telegram" as const;
  readonly enabled: boolean;

  private readonly token?: string;
  private readonly apiBase: string;
  private readonly registry: DecisionRegistry;
  private readonly bindings: BindingStore;

  private polling = false;
  private offset = 0;
  /** Set once setWebhook succeeds (surfaced by channelsStatus()). */
  webhookSet = false;

  constructor(config: ChannelsConfig, ctx: TelegramAdapterContext) {
    this.token = config.telegram.botToken;
    this.apiBase = config.telegram.apiBase;
    this.enabled = config.telegram.enabled;
    this.registry = ctx.registry;
    this.bindings = ctx.bindings;
  }

  // ─── Bot API plumbing ─────────────────────────────────────────

  private url(method: string): string {
    return `${this.apiBase}/bot${this.token}/${method}`;
  }

  private async callApi<T>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    const res = await fetch(this.url(method), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    });
    const json = (await res.json().catch(() => null)) as TgApiResponse<T> | null;
    if (!res.ok || !json || json.ok !== true) {
      const detail = json?.description ?? `HTTP ${res.status}`;
      throw new Error(`Telegram ${method} failed: ${detail}`);
    }
    return json.result as T;
  }

  // ─── ChannelAdapter ───────────────────────────────────────────

  async sendMessage(chatId: string, text: string, card?: OutboundCard): Promise<void> {
    const body = escapeHtml(card?.text ?? text);
    const params: Record<string, unknown> = {
      chat_id: chatId,
      text: body.slice(0, MAX_MESSAGE_LEN),
      parse_mode: "HTML",
    };
    const keyboard = toInlineKeyboard(card?.buttons);
    if (keyboard) params.reply_markup = { inline_keyboard: keyboard };
    await this.callApi("sendMessage", params);
  }

  async editOrFollowUp(
    chatId: string,
    messageId: string | undefined,
    text: string,
  ): Promise<void> {
    if (messageId) {
      try {
        await this.callApi("editMessageText", {
          chat_id: chatId,
          message_id: Number(messageId),
          text: escapeHtml(text).slice(0, MAX_MESSAGE_LEN),
          parse_mode: "HTML",
        });
        return;
      } catch (err) {
        // Editing can fail (e.g. message too old / identical text) — fall back.
        console.warn("[channels:telegram] editMessageText failed, sending follow-up:", errorMessage(err));
      }
    }
    await this.sendMessage(chatId, text);
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.callApi("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text: text.slice(0, 200) } : {}),
    }).catch((err) =>
      console.warn("[channels:telegram] answerCallbackQuery failed:", errorMessage(err)),
    );
  }

  async setWebhook(url: string, secretToken?: string): Promise<void> {
    await this.callApi("setWebhook", {
      url,
      allowed_updates: ["message", "callback_query"],
      ...(secretToken ? { secret_token: secretToken } : {}),
    });
    this.webhookSet = true;
  }

  // ─── Webhook entry point ──────────────────────────────────────

  /** Handle one Telegram update (webhook mode OR a polled update). */
  async handleWebhookUpdate(update: TgUpdate, deps: ChannelDeps): Promise<void> {
    try {
      if (update?.callback_query) {
        await this.onCallbackQuery(update.callback_query, deps);
        return;
      }
      if (update?.message && typeof update.message.text === "string") {
        await this.onMessage(update.message, deps);
      }
    } catch (err) {
      console.warn("[channels:telegram] update handling failed:", errorMessage(err));
    }
  }

  private async onCallbackQuery(cq: TgCallbackQuery, deps: ChannelDeps): Promise<void> {
    const chatId = cq.message?.chat?.id != null ? String(cq.message.chat.id) : undefined;
    const messageId = cq.message?.message_id != null ? String(cq.message.message_id) : undefined;
    await this.answerCallbackQuery(cq.id);

    if (!chatId || !cq.data) {
      return;
    }
    const result = await executeDecision({
      deps,
      registry: this.registry,
      callbackData: cq.data,
      platform: "telegram",
      chatId,
    });
    await this.editOrFollowUp(chatId, messageId, result.text);
  }

  private async onMessage(message: TgMessage, deps: ChannelDeps): Promise<void> {
    const chatId = String(message.chat.id);
    const raw = (message.text ?? "").trim();
    if (!raw) return;

    if (raw.startsWith("/")) {
      const [cmdRaw, ...rest] = raw.split(/\s+/);
      // Strip the optional @botname suffix Telegram adds in groups.
      const cmd = cmdRaw.split("@")[0].toLowerCase();
      const arg = rest.join(" ").trim();
      switch (cmd) {
        case "/start":
          await this.cmdStart(chatId, arg);
          return;
        case "/help":
          await this.sendMessage(chatId, helpText("telegram"));
          return;
        case "/status":
          await this.sendMessage(chatId, await fleetSummary(deps));
          return;
        case "/approvals":
          await this.cmdApprovals(chatId, deps);
          return;
        case "/unbind":
          await this.cmdUnbind(chatId);
          return;
        case "/ask":
          await this.cmdAsk(chatId, arg, deps);
          return;
        default:
          await this.sendMessage(chatId, `Unknown command. ${helpText("telegram")}`);
          return;
      }
    }

    // Any plain text -> ask the orchestrator.
    await this.cmdAsk(chatId, raw, deps);
  }

  // ─── Commands ─────────────────────────────────────────────────

  private async cmdStart(chatId: string, code: string): Promise<void> {
    if (!code) {
      await this.sendMessage(
        chatId,
        "Welcome to Calla. Bind this chat with /start <code> — get a code from the brain's POST /channels/bindings/code.",
      );
      return;
    }
    try {
      await this.bindings.redeemBindingCode(code, "telegram", chatId, null);
      await this.sendMessage(
        chatId,
        `✅ Chat bound (${maskChatId(chatId)}). You'll now receive approval alerts here. Try /status or /approvals.`,
      );
    } catch (err) {
      await this.sendMessage(chatId, `⚠️ ${errorMessage(err)}`);
    }
  }

  private async cmdUnbind(chatId: string): Promise<void> {
    try {
      await this.bindings.unbind("telegram", chatId);
      await this.sendMessage(chatId, "👋 This chat was unbound from Calla.");
    } catch (err) {
      await this.sendMessage(chatId, `⚠️ Could not unbind: ${errorMessage(err)}`);
    }
  }

  private async cmdApprovals(chatId: string, deps: ChannelDeps): Promise<void> {
    let pending;
    try {
      pending = await deps.listPendingMastra();
    } catch (err) {
      await this.sendMessage(chatId, `⚠️ Could not load approvals: ${errorMessage(err)}`);
      return;
    }
    if (!pending.length) {
      await this.sendMessage(chatId, "No pending approvals. 🎉");
      return;
    }
    for (const req of pending.slice(0, 5)) {
      const card = buildApprovalCard(this.registry, req);
      await this.sendMessage(chatId, card.text, card);
    }
    if (pending.length > 5) {
      await this.sendMessage(chatId, `…and ${pending.length - 5} more.`);
    }
  }

  private async cmdAsk(chatId: string, text: string, deps: ChannelDeps): Promise<void> {
    const reply = await askOrchestrator(deps, text);
    for (const chunk of chunkText(reply, MAX_MESSAGE_LEN)) {
      await this.sendMessage(chatId, chunk);
    }
  }

  // ─── Polling (dev without a public URL) ───────────────────────

  /** Start the long-polling getUpdates loop. Idempotent; stop with stopPolling(). */
  startPolling(deps: ChannelDeps): void {
    if (this.polling) return;
    if (!this.enabled) {
      console.warn("[channels:telegram] startPolling ignored — adapter not enabled");
      return;
    }
    this.polling = true;
    void this.pollLoop(deps);
  }

  stopPolling(): void {
    this.polling = false;
  }

  private async pollLoop(deps: ChannelDeps): Promise<void> {
    console.log("[channels:telegram] polling started");
    while (this.polling) {
      try {
        const updates = await this.callApi<TgUpdate[]>("getUpdates", {
          offset: this.offset,
          timeout: POLL_TIMEOUT_SEC,
          allowed_updates: ["message", "callback_query"],
        });
        for (const update of updates ?? []) {
          if (typeof update?.update_id === "number") {
            this.offset = Math.max(this.offset, update.update_id + 1);
          }
          await this.handleWebhookUpdate(update, deps);
        }
      } catch (err) {
        if (!this.polling) break;
        console.warn("[channels:telegram] getUpdates error (backoff 3s):", errorMessage(err));
        await sleep(POLL_ERROR_BACKOFF_MS);
      }
    }
    console.log("[channels:telegram] polling stopped");
  }
}
