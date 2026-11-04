/**
 * Messaging-channels module — shared types.
 *
 * The channels module lets a single operator talk to the Calla orchestrator
 * and approve/decline HITL items from Telegram and WhatsApp. It is a pure
 * add-on: it only reads env + the existing CallaStore cache (bindings) and
 * listApprovals/appendAudit (approvals/audit), and calls back into the brain
 * and the edge worker over HTTP/WS. NO new npm dependencies — it uses global
 * fetch, global WebSocket (Node 22) and node:crypto only.
 *
 * Everything here is transport-agnostic; the Telegram/WhatsApp adapters and
 * the ApprovalNotifier depend on these interfaces (not on each other's
 * concrete classes) so the pieces stay independently testable.
 */
import type { ApprovalRequest } from "@calla/shared";
import type { CallaStore } from "../store/types.js";

// Re-exported so consumers of the module only need this file for the shapes.
export type { ApprovalRequest };

// ─── Platforms ───────────────────────────────────────────────────

export type ChannelPlatform = "telegram" | "whatsapp";

/** Approve ("a") or decline ("d") — encoded into the compact callback data. */
export type DecisionAction = "a" | "d";

/**
 * Where a decision is routed (independent of ApprovalRequest.source).
 * "social" routes an approved reply to the Instagram/TikTok adapter (see
 * social/senders.ts) instead of the edge/Mastra decision backends.
 */
export type DecisionSource = "edge" | "mastra" | "social";

/** Social platforms a decision can be delivered to (mirrors social/types.ts). */
export type DecisionSocialPlatform = "instagram" | "tiktok" | "whatsapp" | "reddit";

// ─── Outbound rendering ──────────────────────────────────────────

export interface OutboundButton {
  /** Human label, e.g. "Approve". Kept <= 20 chars for WhatsApp buttons. */
  label: string;
  /** Compact, platform-safe callback payload (<= 64 bytes for Telegram). */
  callbackData: string;
}

export interface OutboundCard {
  /** Message body (plain text; the Telegram adapter HTML-escapes it). */
  text: string;
  buttons?: OutboundButton[];
}

// ─── Adapter contract ────────────────────────────────────────────

export interface ChannelAdapter {
  readonly platform: ChannelPlatform;
  readonly enabled: boolean;
  /**
   * Send a message. When `card` is present its `text` wins over `text` and its
   * buttons render as an inline keyboard (Telegram) / interactive reply buttons
   * (WhatsApp).
   */
  sendMessage(chatId: string, text: string, card?: OutboundCard): Promise<void>;
  /**
   * Update a previously-sent message (Telegram editMessageText) or, when the
   * platform cannot edit (WhatsApp), send a follow-up confirmation instead.
   */
  editOrFollowUp?(
    chatId: string,
    messageId: string | undefined,
    text: string,
  ): Promise<void>;
}

// ─── Bindings ────────────────────────────────────────────────────

export interface Binding {
  platform: ChannelPlatform;
  chatId: string;
  /** Single-operator v1: always null (reserved for future multi-user). */
  userId?: string | null;
  /** ISO-8601 timestamp. */
  boundAt: string;
  /** The one-time code that produced this binding (audit trail). */
  code?: string;
}

// ─── Decision routing ────────────────────────────────────────────

/**
 * Full context behind a compact callback id. Stored in an in-memory registry
 * (TTL 24h) so callback payloads stay tiny (Telegram caps callback_data at 64
 * bytes; WhatsApp button payloads are similarly constrained).
 *
 * It is a discriminated union on `source`:
 *   • "edge" | "mastra" — route to deps.decideEdgeApproval / decideMastraApproval
 *     (the original HITL backends).
 *   • "social" — an Instagram/TikTok reply gated behind approval; on Approve it
 *     is delivered via the platform adapter (social/senders.ts), on Decline it
 *     is simply audited. This lets the EXISTING Telegram/WhatsApp approval cards
 *     decide social replies with no new UI.
 */
interface DecisionContextBase {
  /** Edge approval id (pendingApprovals[] entry), the Mastra/social row id. */
  approvalId: string;
  agentId: string;
  toolName: string;
  createdAt: number;
}

export interface RoutedDecisionContext extends DecisionContextBase {
  source: "edge" | "mastra";
  /** Edge REST path segment; defaults to agentId. */
  agentName?: string;
  /** Mastra suspended-run id (source === "mastra"). */
  runId?: string | null;
  /** Mastra tool-call id (source === "mastra"). */
  toolCallId?: string | null;
}

export interface SocialDecisionContext extends DecisionContextBase {
  source: "social";
  platform: DecisionSocialPlatform;
  /** Recipient user id for the reply. */
  externalUserId: string;
  /** Public @handle (IG comments) — audit/summary only. */
  username?: string;
  /** The approved reply text to deliver. */
  draft: string;
  /** IG comment id — when present the reply is sent as a private reply. */
  commentId?: string;
}

export type DecisionContext = RoutedDecisionContext | SocialDecisionContext;

/** shortId <-> DecisionContext plus the compact callback codec. */
export interface DecisionRegistry {
  /** Store ctx under a fresh short id; returns the short id. */
  register(ctx: DecisionContext): string;
  /** Look up a context by short id (undefined when missing/expired). */
  resolve(shortId: string): DecisionContext | undefined;
  /** Build the <= 64-byte callback payload for a button. */
  encodeCallback(shortId: string, action: DecisionAction): string;
  /** Parse a callback payload back into { shortId, action }. */
  decodeCallback(
    data: string,
  ): { shortId: string; action: DecisionAction } | undefined;
}

// ─── Binding store contract (cache-backed) ───────────────────────

export interface BindingStore {
  /** Mint a 6-char A-Z0-9 code (TTL 10 min). */
  createBindingCode(platform?: ChannelPlatform): Promise<string>;
  /** Redeem a code -> persist a binding for (platform, chatId). */
  redeemBindingCode(
    code: string,
    platform: ChannelPlatform,
    chatId: string,
    userId?: string | null,
  ): Promise<Binding>;
  isBound(platform: ChannelPlatform, chatId: string): Promise<boolean>;
  getBinding(
    platform: ChannelPlatform,
    chatId: string,
  ): Promise<Binding | null>;
  /** Every live binding (via the maintained index). */
  listBindings(): Promise<Binding[]>;
  unbind(platform: ChannelPlatform, chatId: string): Promise<void>;
}

// ─── Dependencies injected by the integrator ─────────────────────

export interface ChannelDeps {
  /** The existing Calla store — only cacheGet/cacheSet/listApprovals/appendAudit are used. */
  store: CallaStore;
  /**
   * Mastra agent accessor (defaults to the orchestrator). Returns `any` because
   * the concrete Agent type is heavy and only `.generate()` is used (/ask).
   */
  getAgent: (id?: string) => any;
  /** Edge worker base URL (http/https) — used for /fleet and the WS /events. */
  edgeBaseUrl: string;
  /** POST {edge}/approvals/{agentName}/{approvalId}/decision. */
  decideEdgeApproval(
    agentName: string,
    approvalId: string,
    approved: boolean,
  ): Promise<void>;
  /** Resume/decline a brain-side Mastra approval via agent.approveToolCall/declineToolCall. */
  decideMastraApproval(
    runId: string,
    toolCallId: string | null,
    approved: boolean,
    reason?: string,
  ): Promise<void>;
  /** Pending brain-side approvals as ApprovalRequest[]. */
  listPendingMastra(): Promise<ApprovalRequest[]>;
}

// ─── Adapter construction context ────────────────────────────────

export interface AdapterContext {
  config: ChannelsConfig;
  registry: DecisionRegistry;
  bindings: BindingStore;
}

// ─── Config ──────────────────────────────────────────────────────

export interface TelegramConfig {
  enabled: boolean;
  botToken?: string;
  /** Bot API base — override (TELEGRAM_API_BASE) is REQUIRED for mock testing. */
  apiBase: string;
  webhookUrl?: string;
  webhookSecret?: string;
}

export interface WhatsAppConfig {
  enabled: boolean;
  token?: string;
  phoneNumberId?: string;
  verifyToken?: string;
  appSecret?: string;
  /** Cloud API base (GRAPH). Override (WHATSAPP_API_BASE) for mock testing. */
  apiBase: string;
}

export interface ChannelsConfig {
  telegram: TelegramConfig;
  whatsapp: WhatsAppConfig;
  /** Edge base URL for the WS event stream + /fleet (CHANNELS_EDGE_EVENTS_URL). */
  edgeEventsUrl: string;
}

/** Loose shape of the Mastra instance buildChannelsDeps accepts. */
export interface MastraLike {
  listAgents?(): Record<string, any>;
  getAgent?(name: string): any;
}
