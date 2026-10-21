/**
 * Decision routing — the compact callback codec, the in-memory context
 * registry, approval-card construction, and the platform-agnostic
 * "execute a decision" routine shared by the Telegram + WhatsApp handlers.
 *
 * Callback payloads must stay tiny (Telegram caps callback_data at 64 bytes;
 * WhatsApp reply-button payloads are similarly constrained and its button
 * titles at 20 chars). We therefore register the full DecisionContext in an
 * in-memory Map (TTL 24h) under a short id and encode only
 *   c:<shortId>:<a|d>
 * into the button. On press we resolve the short id back to the full context
 * and route to deps.decideEdgeApproval / deps.decideMastraApproval.
 */
import type { ApprovalRequest } from "@calla/shared";
import type { ApprovalRow } from "../store/types.js";
import type {
  ChannelDeps,
  ChannelPlatform,
  DecisionAction,
  DecisionContext,
  DecisionRegistry,
  DecisionSocialPlatform,
  OutboundButton,
  OutboundCard,
  RoutedDecisionContext,
} from "./types.js";
import { getSocialSender } from "./social/senders.js";
import { ConversationStore } from "../conversations/store.js";
import type { SocialDecisionContext } from "./types.js";
import {
  errorMessage,
  maskChatId,
  randomShortId,
  riskEmoji,
  safeStringify,
  truncate,
} from "./util.js";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const SWEEP_THRESHOLD = 1000;

/** Tool-name shape the social engine records: `social-<platform>-<kind>`. */
const SOCIAL_TOOL_RE = /^social-(instagram|tiktok|whatsapp)-[a-z_]+$/;

interface Entry {
  ctx: DecisionContext;
  expiresAt: number;
}

/** In-memory shortId -> DecisionContext registry with lazy TTL expiry. */
export class InMemoryDecisionRegistry implements DecisionRegistry {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs: number = DEFAULT_TTL_MS) {}

  register(ctx: DecisionContext): string {
    if (this.map.size > SWEEP_THRESHOLD) this.sweep();
    let shortId = randomShortId(8);
    // Extremely unlikely collision guard.
    while (this.map.has(shortId)) shortId = randomShortId(8);
    this.map.set(shortId, { ctx, expiresAt: Date.now() + this.ttlMs });
    return shortId;
  }

  resolve(shortId: string): DecisionContext | undefined {
    const entry = this.map.get(shortId);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(shortId);
      return undefined;
    }
    return entry.ctx;
  }

  encodeCallback(shortId: string, action: DecisionAction): string {
    return `c:${shortId}:${action}`;
  }

  decodeCallback(
    data: string,
  ): { shortId: string; action: DecisionAction } | undefined {
    const m = /^c:([A-Za-z0-9]+):([ad])$/.exec(String(data ?? "").trim());
    if (!m) return undefined;
    return { shortId: m[1], action: m[2] as DecisionAction };
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, entry] of this.map) {
      if (entry.expiresAt <= now) this.map.delete(id);
    }
  }
}

/** Map an inbound ApprovalRequest to the decision-routing context. */
export function contextFromApproval(req: ApprovalRequest): DecisionContext {
  // Social replies are recorded with source "mastra" but a `social-<platform>-<kind>`
  // tool name. Detect them here so the notifier's cards (built from either the
  // edge WS relay or the 15s Mastra poll) route to the platform adapter instead
  // of the Mastra resume path (which has no runId for social approvals).
  const social = SOCIAL_TOOL_RE.exec(req.toolName ?? "");
  if (social) {
    const args = (req.arguments ?? {}) as Record<string, any>;
    const platform = social[1] as DecisionSocialPlatform;
    return {
      source: "social",
      approvalId: req.id,
      agentId: req.agentId,
      toolName: req.toolName,
      createdAt: Date.now(),
      platform,
      externalUserId: String(args.externalUserId ?? ""),
      ...(args.username ? { username: String(args.username) } : {}),
      draft: String(args.draft ?? ""),
      ...(args.commentId ? { commentId: String(args.commentId) } : {}),
    };
  }

  const isMastra = req.source === "mastra";
  return {
    source: isMastra ? "mastra" : "edge",
    approvalId: isMastra ? req.id : (req.approvalId ?? req.id),
    agentId: req.agentId,
    toolName: req.toolName,
    agentName: req.agentId,
    runId: req.runId ?? null,
    toolCallId: req.toolCallId ?? null,
    createdAt: Date.now(),
  };
}

/** Map a durable store ApprovalRow to the shared ApprovalRequest wire shape. */
export function rowToApprovalRequest(row: ApprovalRow): ApprovalRequest {
  return {
    id: row.id,
    source: row.source,
    agentId: row.agentId,
    runId: row.runId ?? undefined,
    toolCallId: row.toolCallId ?? undefined,
    toolName: row.toolName,
    arguments: (row.args ?? {}) as Record<string, unknown>,
    risk: row.risk,
    summary: row.summary ?? `Approval required: ${row.toolName}`,
    requestedAt: row.requestedAt,
    expiresAt: null,
    status: row.status,
    deploymentId: row.deploymentId ?? undefined,
  };
}

/** Plain-text approval body (emoji risk marker, tool, summary, args, expiry). */
export function buildApprovalText(req: ApprovalRequest): string {
  const lines = [
    `${riskEmoji(req.risk)} Approval required (${req.risk})`,
    `Tool: ${req.toolName}`,
    `Agent: ${req.agentId}`,
  ];
  if (req.summary) lines.push(req.summary);
  const args = truncate(safeStringify(req.arguments ?? {}), 300);
  if (args && args !== "{}") lines.push(`Args: ${args}`);
  lines.push(req.expiresAt ? `Expires: ${req.expiresAt}` : "No expiry");
  return lines.join("\n");
}

/** Register the context + build Approve/Decline buttons for an approval. */
export function buildApprovalButtons(
  registry: DecisionRegistry,
  req: ApprovalRequest,
): OutboundButton[] {
  const shortId = registry.register(contextFromApproval(req));
  return [
    { label: "Approve", callbackData: registry.encodeCallback(shortId, "a") },
    { label: "Decline", callbackData: registry.encodeCallback(shortId, "d") },
  ];
}

/** Full outbound card (text + Approve/Decline buttons) for an approval. */
export function buildApprovalCard(
  registry: DecisionRegistry,
  req: ApprovalRequest,
): OutboundCard {
  return { text: buildApprovalText(req), buttons: buildApprovalButtons(registry, req) };
}

export interface ExecuteDecisionParams {
  deps: ChannelDeps;
  registry: DecisionRegistry;
  callbackData: string;
  platform: ChannelPlatform;
  chatId: string;
}

export interface DecisionResult {
  ok: boolean;
  text: string;
}

/** Best-effort hash-chained audit entry for a channel-made decision. */
async function appendDecisionAudit(
  deps: ChannelDeps,
  ctx: DecisionContext,
  approved: boolean,
  platform: ChannelPlatform,
  chatId: string,
): Promise<void> {
  // runId/toolCallId only exist on routed (edge/mastra) contexts.
  const routed: RoutedDecisionContext | undefined =
    ctx.source === "social" ? undefined : ctx;
  try {
    await deps.store.appendAudit({
      agentId: ctx.agentId ?? null,
      kind: "approval.decided",
      entry: {
        via: `channel:${platform}`,
        chatId: maskChatId(chatId),
        approvalId: ctx.approvalId,
        approved,
        source: ctx.source,
        toolName: ctx.toolName,
        ...(routed?.runId ? { runId: routed.runId } : {}),
        ...(routed?.toolCallId ? { toolCallId: routed.toolCallId } : {}),
      },
    });
  } catch (err) {
    console.warn("[channels] appendAudit(approval.decided) failed:", errorMessage(err));
  }
}

/**
 * Social-specific audit trail: "social.sent" {auto:false} on an approved+sent
 * reply, "social.declined" on a declined one. Kept separate from the generic
 * approval.decided entry so the social pipeline has its own observable history.
 */
async function appendSocialDecisionAudit(
  deps: ChannelDeps,
  ctx: DecisionContext & { source: "social" },
  sent: boolean,
  via: ChannelPlatform,
): Promise<void> {
  try {
    await deps.store.appendAudit({
      agentId: ctx.agentId ?? null,
      kind: sent ? "social.sent" : "social.declined",
      entry: {
        auto: false,
        approvalId: ctx.approvalId,
        platform: ctx.platform,
        externalUserId: maskChatId(ctx.externalUserId),
        ...(ctx.username ? { username: ctx.username } : {}),
        ...(ctx.commentId ? { commentId: ctx.commentId } : {}),
        via: `channel:${via}`,
      },
    });
  } catch (err) {
    console.warn("[channels] appendAudit(social decision) failed:", errorMessage(err));
  }
}

/**
 * Conversation-thread recording for a social decision (operator console view):
 *   approve → the delivered draft, kind "approval_result" (auto:true);
 *   decline → a "system" notice (NOTHING was sent to the customer).
 * Best-effort + fire-and-forget: the thread store never blocks a decision, and
 * a failed send is never recorded (only successful deliveries are).
 */
function recordSocialDecision(
  deps: ChannelDeps,
  ctx: SocialDecisionContext,
  sent: boolean,
): void {
  const convs = new ConversationStore(deps.store);
  void convs
    .recordOutbound({
      platform: ctx.platform,
      externalUserId: ctx.externalUserId,
      ...(ctx.username ? { username: ctx.username } : {}),
      text: sent ? ctx.draft : "(declined by operator — nothing sent)",
      kind: sent ? "approval_result" : "system",
      auto: true,
      ...(ctx.approvalId ? { approvalId: ctx.approvalId } : {}),
    })
    .catch((err) =>
      console.warn("[channels] conversation recordOutbound failed:", errorMessage(err)),
    );
}

/**
 * Resolve a callback payload, route the decision to the correct backend, and
 * append the audit entry. Returns a human-readable result string for the
 * adapter to render (Telegram edits the message; WhatsApp sends a follow-up).
 */
export async function executeDecision(
  params: ExecuteDecisionParams,
): Promise<DecisionResult> {
  const { deps, registry, callbackData, platform, chatId } = params;

  const decoded = registry.decodeCallback(callbackData);
  if (!decoded) {
    return {
      ok: false,
      text: "⚠️ That action is not recognized. Use /approvals (or send 'approvals') to see current items.",
    };
  }
  const ctx = registry.resolve(decoded.shortId);
  if (!ctx) {
    return {
      ok: false,
      text: "⚠️ That approval has expired or was already handled. Use /approvals to refresh.",
    };
  }

  const approved = decoded.action === "a";

  // ── Social reply decision (Instagram/TikTok) ────────────────────
  if (ctx.source === "social") {
    const verb = approved ? "✅ Sent" : "❌ Declined";
    const who = maskChatId(chatId);
    const when = new Date().toISOString();
    if (!approved) {
      recordSocialDecision(deps, ctx, false);
      void appendSocialDecisionAudit(deps, ctx, false, platform);
      void appendDecisionAudit(deps, ctx, false, platform, chatId);
      return { ok: true, text: `${verb} — ${ctx.toolName}\nby ${who} at ${when}` };
    }
    const sender = getSocialSender(ctx.platform);
    if (!sender) {
      return {
        ok: false,
        text: `⚠️ The ${ctx.platform} adapter is not available — cannot deliver this reply.`,
      };
    }
    try {
      await sender.send(ctx.externalUserId, ctx.draft, ctx.commentId);
    } catch (err) {
      return { ok: false, text: `❌ Send failed: ${errorMessage(err)}` };
    }
    recordSocialDecision(deps, ctx, true);
    void appendSocialDecisionAudit(deps, ctx, true, platform);
    void appendDecisionAudit(deps, ctx, true, platform, chatId);
    return { ok: true, text: `${verb} — ${ctx.toolName}\nby ${who} at ${when}` };
  }

  try {
    if (ctx.source === "edge") {
      const agentName = ctx.agentName ?? ctx.agentId;
      if (!agentName || !ctx.approvalId) {
        return { ok: false, text: "⚠️ Malformed edge approval — cannot decide." };
      }
      await deps.decideEdgeApproval(agentName, ctx.approvalId, approved);
    } else {
      if (!ctx.runId) {
        return { ok: false, text: "⚠️ Malformed brain approval — missing run id." };
      }
      await deps.decideMastraApproval(
        ctx.runId,
        ctx.toolCallId ?? null,
        approved,
        approved ? undefined : `Declined via ${platform} channel`,
      );
    }
  } catch (err) {
    return { ok: false, text: `❌ Decision failed: ${errorMessage(err)}` };
  }

  void appendDecisionAudit(deps, ctx, approved, platform, chatId);

  const verb = approved ? "✅ Approved" : "❌ Declined";
  const who = maskChatId(chatId);
  const when = new Date().toISOString();
  return { ok: true, text: `${verb} — ${ctx.toolName}\nby ${who} at ${when}` };
}
