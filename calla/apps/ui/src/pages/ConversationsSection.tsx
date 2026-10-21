/**
 * ConversationsSection — /conversations
 * ─────────────────────────────────────
 * The sell-readiness inbox: every customer DM thread the brain owns
 * (Instagram / WhatsApp / TikTok), full-height two-pane layout.
 *
 *   Left pane  — conversation list: platform filter chips, privacy-masked
 *                contacts (phone last-4 only), flow tier/status + takeover
 *                badges, auto-refresh every 5s while this page is mounted.
 *   Right pane — thread: message bubbles (Auto/You attribution), takeover
 *                toggle ("Pause automation"), operator composer with
 *                optimistic send + rollback, and a flow-run side card with
 *                score/tier/routing and the Q&A transcript.
 *
 * Degradation is the design constraint: the brain may 404 (endpoint not
 * landed yet) or be unreachable — both render the same honest empty state
 * with Retry, never a crash. conversationsClient never throws.
 */

import * as React from "react";
import {
  Bot,
  CalendarDays,
  ExternalLink,
  Hand,
  Instagram,
  MessageCircle,
  MessagesSquare,
  Music2,
  RefreshCw,
  Send,
  Trash2,
  Unplug,
  User,
  Workflow,
} from "lucide-react";
import { EmptyState } from "@/components/shared";
import { Badge, Button, Card, Dialog, Skeleton, Textarea } from "@/components/ui";
import { toast } from "@/hooks";
import {
  conversationsClient,
  type ConversationDetail,
  type ConversationMessage,
  type ConversationSummary,
  type ConversationsResult,
} from "@/lib/conversations-client";
import { cn, formatDublinTime, humanizeFieldName, relativeTime } from "@/lib/utils";

// ─── Constants & helpers ─────────────────────────────────────────

/** List refresh cadence — only while this page is mounted. */
const REFRESH_INTERVAL_MS = 5_000;
/** Fetch cap per list read. */
const LIST_LIMIT = 50;
/** Autoscroll keeps pinning the thread while this close to the bottom. */
const NEAR_BOTTOM_PX = 96;

const PLATFORM_META: Record<
  string,
  { label: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  instagram: { label: "Instagram", Icon: Instagram },
  whatsapp: { label: "WhatsApp", Icon: MessageCircle },
  tiktok: { label: "TikTok", Icon: Music2 },
};

const PLATFORM_FILTERS: Array<{ id: "all" | "instagram" | "whatsapp" | "tiktok"; label: string }> = [
  { id: "all", label: "All" },
  { id: "instagram", label: "Instagram" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "tiktok", label: "TikTok" },
];

const TIER_VARIANT: Record<string, "error" | "warning" | "muted"> = {
  hot: "error",
  warm: "warning",
  cold: "muted",
};

/** Kinds worth labeling under an Auto bubble (the rest are plain messages). */
const KIND_LABELS: Record<string, string> = {
  flow_prompt: "flow prompt",
  approval_result: "approval result",
  persona: "persona",
  static: "static",
  system: "system",
};

function platformMeta(platform: string) {
  return PLATFORM_META[platform] ?? { label: platform || "unknown", Icon: MessageCircle };
}

/**
 * Privacy: phone numbers are never shown in full — only the last 4 digits
 * ("••• 4567"). The full number stays server-side.
 */
export function maskPhone(phone: string): string {
  const digits = phone.replace(/\D/g, "");
  if (digits.length === 0) return "••••";
  return `••• ${digits.slice(-4)}`;
}

function summaryName(c: ConversationSummary): string {
  if (c.username) return c.username;
  if (c.phone) return maskPhone(c.phone);
  return `Conversation ${c.id.slice(0, 6)}`;
}

function detailName(detail: ConversationDetail): string {
  const { username, phone, externalUserId } = detail.contact;
  if (username) return username;
  if (phone) return maskPhone(phone);
  if (externalUserId) return `${externalUserId.slice(0, 4)}…${externalUserId.slice(-4)}`;
  return `Conversation ${detail.id.slice(0, 6)}`;
}

function formatTime(ts: string): string {
  if (!ts) return "";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return ts;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Proposed slots arrive as ISO strings or {start|startTime} objects. */
function formatSlot(slot: unknown): string {
  if (typeof slot === "string") return formatDublinTime(slot);
  if (typeof slot === "number") return formatDublinTime(slot);
  if (slot && typeof slot === "object") {
    const rec = slot as Record<string, unknown>;
    const value = rec.start ?? rec.startTime ?? rec.start_time ?? rec.value;
    if (typeof value === "string" || typeof value === "number") return formatDublinTime(value);
    return JSON.stringify(slot);
  }
  return String(slot);
}

function answerText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function isBotMessage(m: ConversationMessage): boolean {
  if (m.dir !== "out") return false;
  if (m.kind === "manual") return false;
  return m.auto !== false;
}

// ─── Small pieces ────────────────────────────────────────────────

const TierBadge: React.FC<{ tier?: string }> = ({ tier }) => {
  if (!tier) return null;
  const key = tier.toLowerCase();
  return (
    <Badge variant={TIER_VARIANT[key] ?? "muted"} className="px-1.5 py-0 text-[0.625rem]">
      {key.toUpperCase()}
    </Badge>
  );
};

const OfflineNote: React.FC<{
  result: ConversationsResult<unknown> | null;
  onRetry: () => void;
  title?: string;
}> = ({ result, onRetry, title = "Brain not connected" }) => {
  const detail = !result
    ? "Waiting for the brain…"
    : result.disabled
      ? "BRAIN_URL is not configured on this console."
      : result.status === 404
        ? "This brain build doesn't expose /conversations yet."
        : (result.error ?? "The brain didn't answer.");
  return (
    <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
      <span className="flex size-10 items-center justify-center rounded-full bg-surface-tag text-muted-foreground">
        <Unplug className="size-5" />
      </span>
      <div>
        <div className="text-sm font-semibold text-foreground">{title}</div>
        <div className="mt-0.5 max-w-[260px] text-[0.6875rem] leading-snug text-muted-foreground">
          {detail}
        </div>
      </div>
      <Button variant="outline" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" />
        Retry
      </Button>
    </div>
  );
};

// ─── Flow-run side card ──────────────────────────────────────────

const FlowRunCard: React.FC<{
  flowRun: NonNullable<ConversationDetail["flowRun"]>;
}> = ({ flowRun }) => {
  const routing = flowRun.routing;
  const answers = Object.entries(flowRun.answers);

  return (
    <Card className="space-y-3 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
          <Workflow className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
            Qualification flow
          </div>
          <div className="truncate font-mono text-xs text-body">{flowRun.flowId}</div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <Badge variant={flowRun.status === "completed" ? "success" : flowRun.status === "active" ? "info" : "muted"}>
          {flowRun.status}
        </Badge>
        {typeof flowRun.score === "number" && (
          <Badge variant="outline" className="tabular-nums">
            score {flowRun.score.toFixed(2)}
          </Badge>
        )}
        <TierBadge tier={flowRun.tier} />
      </div>

      {routing && (
        <div className="space-y-1.5 rounded-md border border-border bg-surface-canvas p-2.5">
          <div className="text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
            Routing
          </div>
          {(routing.repName || routing.repId) && (
            <div className="flex items-center gap-1.5 text-[0.8125rem] text-body">
              <User className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="truncate">{routing.repName ?? routing.repId}</span>
              {routing.bookedAppointmentId && (
                <Badge variant="success" className="ml-auto shrink-0 px-1.5 py-0 text-[0.625rem]">
                  <CalendarDays className="size-3" />
                  Booked
                </Badge>
              )}
            </div>
          )}
          {Array.isArray(routing.proposedSlots) && routing.proposedSlots.length > 0 && (
            <ul className="space-y-0.5">
              {routing.proposedSlots.slice(0, 4).map((slot, i) => (
                <li key={i} className="text-[0.6875rem] text-muted-foreground">
                  {formatSlot(slot)}
                </li>
              ))}
            </ul>
          )}
          {routing.link && (
            <a
              href={routing.link}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
            >
              Booking link
              <ExternalLink className="size-3" />
            </a>
          )}
        </div>
      )}

      {/* Q&A transcript (collapsible) */}
      {answers.length > 0 && (
        <details className="group rounded-md border border-border bg-surface-canvas" open>
          <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[0.6875rem] font-medium text-muted-foreground hover:text-foreground">
            Q&A · {answers.length} answer{answers.length === 1 ? "" : "s"}
          </summary>
          <dl className="space-y-1.5 border-t border-border px-2.5 py-2">
            {answers.map(([field, value]) => {
              const awaiting = flowRun.currentField === field;
              return (
                <div
                  key={field}
                  className={cn(
                    "rounded-md px-2 py-1.5",
                    awaiting && "border border-warning/40 bg-warning/10",
                  )}
                >
                  <dt className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.04em] text-faint">
                    {humanizeFieldName(field)}
                    {awaiting && (
                      <Badge variant="warning" className="px-1 py-0 text-[0.5625rem]">
                        awaiting answer
                      </Badge>
                    )}
                  </dt>
                  <dd className="mt-0.5 text-[0.8125rem] text-body">{answerText(value)}</dd>
                </div>
              );
            })}
            {flowRun.currentField && !answers.some(([f]) => f === flowRun.currentField) && (
              <div className="rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5">
                <div className="text-[0.625rem] font-semibold uppercase tracking-[0.04em] text-faint">
                  {humanizeFieldName(flowRun.currentField)}
                </div>
                <Badge variant="warning" className="mt-0.5 px-1 py-0 text-[0.5625rem]">
                  awaiting answer
                </Badge>
              </div>
            )}
          </dl>
        </details>
      )}
    </Card>
  );
};

// ─── Screen ──────────────────────────────────────────────────────

export interface ConversationsSectionProps {
  onNavigate: (path: string) => void;
}

export const ConversationsSection: React.FC<ConversationsSectionProps> = ({ onNavigate }) => {
  const [platform, setPlatform] = React.useState<"all" | "instagram" | "whatsapp" | "tiktok">("all");
  const [listResult, setListResult] =
    React.useState<ConversationsResult<{ conversations: ConversationSummary[]; total: number }> | null>(
      null,
    );
  const [listLoading, setListLoading] = React.useState(true);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [detail, setDetail] = React.useState<ConversationsResult<ConversationDetail> | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);
  const [composer, setComposer] = React.useState("");
  const [sending, setSending] = React.useState(false);
  const [takeoverBusy, setTakeoverBusy] = React.useState(false);
  const [confirmDelete, setConfirmDelete] = React.useState(false);
  const [deleting, setDeleting] = React.useState(false);
  /** Locally-appended outbound messages not yet confirmed by a detail refresh. */
  const [optimistic, setOptimistic] = React.useState<ConversationMessage[]>([]);

  // ─── List loading + 5s auto-refresh (mounted only) ─────────────

  const loadList = React.useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!opts?.quiet) setListLoading(true);
      const res = await conversationsClient.list(
        platform === "all" ? undefined : platform,
        LIST_LIMIT,
      );
      setListResult(res);
      if (!opts?.quiet) setListLoading(false);
    },
    [platform],
  );

  React.useEffect(() => {
    void loadList();
    const timer = setInterval(() => {
      void loadList({ quiet: true });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [loadList]);

  // ─── Detail loading ────────────────────────────────────────────

  const loadDetail = React.useCallback(async (id: string, opts?: { quiet?: boolean }) => {
    if (!opts?.quiet) setDetailLoading(true);
    const res = await conversationsClient.get(id);
    setDetail((prev) => {
      // Don't clobber a newer selection's detail with a stale response.
      return res.data?.id === id || res.data === null ? res : prev;
    });
    if (!opts?.quiet) setDetailLoading(false);
    return res;
  }, []);

  React.useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setOptimistic([]);
      return;
    }
    setOptimistic([]);
    setComposer("");
    void loadDetail(selectedId);
  }, [selectedId, loadDetail]);

  // Keep the open thread fresh on the same 5s cadence (skipped mid-send so
  // the optimistic bubble is never replaced by a pre-send snapshot).
  React.useEffect(() => {
    if (!selectedId) return;
    const timer = setInterval(() => {
      if (!sending) void loadDetail(selectedId, { quiet: true });
    }, REFRESH_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [selectedId, sending, loadDetail]);

  const conversations = listResult?.data?.conversations ?? [];
  const selected = detail?.data && detail.data.id === selectedId ? detail.data : null;
  const messages = selected ? [...selected.messages, ...optimistic] : [];

  // ─── Thread autoscroll (near-bottom pinning, like the chat panes) ──

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const nearBottomRef = React.useRef(true);

  const handleScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    nearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  // Jump to the bottom whenever a different conversation is opened.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el) {
      el.scrollTop = el.scrollHeight;
      nearBottomRef.current = true;
    }
  }, [selectedId]);

  // Pin to the bottom on new messages only while the operator is down there.
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && nearBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // ─── Actions ───────────────────────────────────────────────────

  const handleSend = React.useCallback(async () => {
    const text = composer.trim();
    if (!text || !selected || sending) return;
    setSending(true);
    setComposer("");
    const bubble: ConversationMessage = {
      dir: "out",
      text,
      ts: new Date().toISOString(),
      kind: "manual",
      auto: false,
    };
    setOptimistic((prev) => [...prev, bubble]);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;

    const res = await conversationsClient.send(selected.id, text);
    if (res.error || !res.data?.ok) {
      // Roll the optimistic bubble back and hand the draft back to the operator.
      setOptimistic((prev) => prev.filter((m) => m !== bubble));
      setComposer(text);
      toast.error(
        "Message not delivered",
        res.error ?? "The provider rejected the message (502).",
      );
      setSending(false);
      return;
    }
    const fresh = await loadDetail(selected.id, { quiet: true });
    if (fresh.data) setOptimistic((prev) => prev.filter((m) => m !== bubble));
    setSending(false);
  }, [composer, selected, sending, loadDetail]);

  const handleTakeover = React.useCallback(async () => {
    if (!selected || takeoverBusy) return;
    const next = !selected.takeover;
    setTakeoverBusy(true);
    // Optimistic flip so the bar responds instantly.
    setDetail((prev) =>
      prev?.data ? { ...prev, data: { ...prev.data, takeover: next } } : prev,
    );
    const res = await conversationsClient.setTakeover(selected.id, next);
    if (res.error || !res.data?.ok) {
      setDetail((prev) =>
        prev?.data ? { ...prev, data: { ...prev.data, takeover: !next } } : prev,
      );
      toast.error("Takeover update failed", res.error ?? "The brain didn't answer.");
    } else {
      toast.success(
        next ? "Automation paused" : "Automation resumed",
        next ? "Replies in this thread are manual now." : "The brain replies to this thread again.",
      );
      void loadList({ quiet: true });
    }
    setTakeoverBusy(false);
  }, [selected, takeoverBusy, loadList]);

  const handleDelete = React.useCallback(async () => {
    if (!selected || deleting) return;
    setDeleting(true);
    const res = await conversationsClient.remove(selected.id);
    setDeleting(false);
    setConfirmDelete(false);
    if (res.error || !res.data?.ok) {
      toast.error("Delete failed", res.error ?? "The brain didn't answer.");
      return;
    }
    toast.info("Conversation deleted");
    setSelectedId(null);
    void loadList({ quiet: true });
  }, [selected, deleting, loadList]);

  const composerKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  // ─── Render ────────────────────────────────────────────────────

  const listUnreachable = !!listResult && listResult.unreachable;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-rows-[minmax(0,2fr)_minmax(0,3fr)] lg:grid-cols-[320px_1fr] lg:grid-rows-1">
        {/* ─── List pane ──────────────────────────────────────── */}
        <aside className="flex min-h-0 flex-col border-b border-border bg-surface-panel lg:border-b-0 lg:border-r">
          <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
            <h1 className="text-sm font-semibold text-foreground">Conversations</h1>
            <span className="flex items-center gap-2">
              {listResult?.data && (
                <span className="text-[0.625rem] tabular-nums text-faint">
                  {listResult.data.total.toLocaleString()} total
                </span>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => void loadList()}
                aria-label="Refresh conversations"
                title="Refresh (auto-refreshes every 5s)"
              >
                <RefreshCw className={cn("size-3.5", listLoading && "animate-spin")} />
              </Button>
            </span>
          </div>

          {/* Platform filter chips */}
          <div className="flex gap-1.5 border-b border-border px-3 py-2">
            {PLATFORM_FILTERS.map(({ id, label }) => {
              const Icon = id === "all" ? MessagesSquare : platformMeta(id).Icon;
              const active = platform === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => setPlatform(id)}
                  aria-pressed={active}
                  className={cn(
                    "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[0.6875rem] font-medium transition-colors",
                    active
                      ? "border-transparent bg-secondary text-foreground"
                      : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <Icon className="size-3.5" />
                  {label}
                </button>
              );
            })}
          </div>

          {/* Rows */}
          <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
            {listLoading && !listResult ? (
              <div className="space-y-2 p-3">
                {Array.from({ length: 6 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : listUnreachable ? (
              <OfflineNote result={listResult} onRetry={() => void loadList()} />
            ) : conversations.length === 0 ? (
              <EmptyState
                className="px-4 py-10"
                icon={<MessageCircle className="size-7 text-muted-foreground" />}
                title="No conversations yet"
                message="They appear when customers message your connected Instagram/WhatsApp."
              />
            ) : (
              <ul>
                {conversations.map((c) => {
                  const meta = platformMeta(c.platform);
                  const active = c.id === selectedId;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => {
                          // Reset synchronously so the pane skeletons instead of
                          // flashing the previous thread's state.
                          setSelectedId(c.id);
                          setDetail(null);
                          setDetailLoading(true);
                        }}
                        aria-current={active ? "true" : undefined}
                        className={cn(
                          "flex w-full items-start gap-2.5 border-b border-border/60 px-3 py-2.5 text-left transition-colors",
                          active ? "bg-secondary" : "hover:bg-surface-hover",
                        )}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
                          <meta.Icon className="size-4" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-1.5">
                            <span className="truncate text-[0.8125rem] font-medium text-foreground">
                              {summaryName(c)}
                            </span>
                            {c.flowStatus === "active" && (
                              <span
                                className="inline-block size-2 shrink-0 rounded-full bg-info animate-pulse-dot"
                                title="Flow active"
                                aria-label="Flow active"
                              />
                            )}
                            <span className="ml-auto shrink-0 text-[0.625rem] whitespace-nowrap text-faint">
                              {c.lastAt ? relativeTime(c.lastAt) : ""}
                            </span>
                          </span>
                          <span className="mt-0.5 block truncate text-[0.6875rem] text-muted-foreground">
                            {c.lastMessage || "—"}
                          </span>
                          <span className="mt-1 flex flex-wrap items-center gap-1">
                            <TierBadge tier={c.flowTier} />
                            {c.takeover && (
                              <Badge variant="warning" className="gap-0.5 px-1.5 py-0 text-[0.625rem]">
                                <Hand className="size-3" />
                                TAKEOVER
                              </Badge>
                            )}
                            {c.messageCount > 0 && (
                              <span className="text-[0.625rem] tabular-nums text-faint">
                                {c.messageCount} msg{c.messageCount === 1 ? "" : "s"}
                              </span>
                            )}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </aside>

        {/* ─── Thread pane ────────────────────────────────────── */}
        <section className="flex min-h-0 min-w-0 flex-col bg-background">
          {!selectedId ? (
            <EmptyState
              className="m-auto"
              icon={<MessagesSquare className="size-7 text-muted-foreground" />}
              title="Select a conversation"
              message="Pick a thread on the left to read it, take over from the bot, or reply as the operator."
            />
          ) : detailLoading && !selected ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 6 }).map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : !selected ? (
            <OfflineNote
              result={detail}
              onRetry={() => void loadDetail(selectedId)}
              title="Couldn't load this conversation"
            />
          ) : (
            <>
              {/* Thread header */}
              <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface-panel px-4 py-2.5">
                <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
                  {React.createElement(platformMeta(selected.platform).Icon, {
                    className: "size-4",
                  })}
                </span>
                <div className="min-w-0">
                  <div className="truncate text-sm font-semibold text-foreground">
                    {detailName(selected)}
                  </div>
                  <div className="text-[0.625rem] text-faint">
                    {platformMeta(selected.platform).label}
                    {selected.contact.externalUserId && (
                      <span className="font-mono"> · {selected.contact.externalUserId.slice(0, 12)}…</span>
                    )}
                  </div>
                </div>
                <Badge variant="muted" className="shrink-0">
                  {platformMeta(selected.platform).label}
                </Badge>
                {selected.lead && (
                  <button
                    type="button"
                    onClick={() => onNavigate("/data")}
                    title="Open this lead in Data"
                    className="shrink-0 rounded-full border border-border bg-surface-tag px-2 py-0.5 font-mono text-[0.625rem] text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {selected.lead.key.length > 18
                      ? `${selected.lead.key.slice(0, 8)}…${selected.lead.key.slice(-6)}`
                      : selected.lead.key}
                  </button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="ml-auto shrink-0 text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => setConfirmDelete(true)}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
              </div>

              {/* Messages + flow-run side card */}
              <div className="flex min-h-0 flex-1">
                <div className="flex min-w-0 flex-1 flex-col">
                  <div
                    ref={scrollRef}
                    onScroll={handleScroll}
                    className="scrollbar-thin min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
                  >
                    {messages.length === 0 ? (
                      <p className="py-10 text-center text-[0.8125rem] text-muted-foreground">
                        No messages in this thread yet.
                      </p>
                    ) : (
                      messages.map((m, i) => {
                        const out = m.dir === "out";
                        const bot = isBotMessage(m);
                        const kindLabel = m.kind ? KIND_LABELS[m.kind] : undefined;
                        return (
                          <div
                            key={`${m.ts}-${i}`}
                            className={cn("flex flex-col gap-1", out ? "items-end" : "items-start")}
                          >
                            <div
                              className={cn(
                                "max-w-[78%] whitespace-pre-wrap rounded-xl px-3 py-2 text-[0.8125rem] leading-relaxed",
                                out
                                  ? "rounded-br-sm bg-primary text-primary-foreground"
                                  : "rounded-bl-sm border border-border bg-card text-card-foreground",
                              )}
                            >
                              {m.text}
                            </div>
                            <div
                              className={cn(
                                "flex items-center gap-1.5 text-[0.625rem] text-faint",
                                out && "flex-row-reverse",
                              )}
                            >
                              {out &&
                                (bot ? (
                                  <span className="inline-flex items-center gap-1 rounded-full bg-surface-tag px-1.5 py-px font-medium text-muted-foreground">
                                    <Bot className="size-3" />
                                    Auto
                                    {kindLabel && <span className="text-faint">· {kindLabel}</span>}
                                  </span>
                                ) : (
                                  <span className="font-medium text-muted-foreground">You</span>
                                ))}
                              {m.approvalId && (
                                <span className="font-mono">approval {m.approvalId.slice(0, 6)}</span>
                              )}
                              {m.ts && <span>{formatTime(m.ts)}</span>}
                            </div>
                          </div>
                        );
                      })
                    )}
                  </div>

                  {/* Takeover toggle */}
                  <div className="border-t border-border bg-surface-panel px-3">
                    <button
                      type="button"
                      onClick={() => void handleTakeover()}
                      disabled={takeoverBusy}
                      aria-pressed={selected.takeover}
                      className={cn(
                        "flex w-full items-center gap-2.5 py-2 text-left text-[0.8125rem] transition-colors disabled:opacity-60",
                        selected.takeover ? "text-warning" : "text-muted-foreground hover:text-foreground",
                      )}
                    >
                      <Hand className="size-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {selected.takeover
                          ? "Automation paused — replies are manual"
                          : "Pause automation"}
                      </span>
                      {/* switch-style indicator */}
                      <span
                        className={cn(
                          "flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition-colors",
                          selected.takeover ? "justify-end bg-warning" : "justify-start bg-muted",
                        )}
                        aria-hidden
                      >
                        <span className="size-4 rounded-full bg-white shadow-control" />
                      </span>
                    </button>
                  </div>

                  {/* Composer */}
                  <div className="flex items-end gap-2 border-t border-border bg-surface-panel p-3">
                    <Textarea
                      value={composer}
                      onChange={(e) => setComposer(e.target.value)}
                      onKeyDown={composerKeyDown}
                      placeholder="Reply as the operator… (Enter to send, Shift+Enter for a new line)"
                      rows={1}
                      disabled={sending}
                      className="min-h-[40px] flex-1 resize-none py-2"
                      aria-label="Message"
                    />
                    <Button
                      size="sm"
                      onClick={() => void handleSend()}
                      disabled={sending || composer.trim().length === 0}
                    >
                      {sending ? (
                        <RefreshCw className="size-3.5 animate-spin" />
                      ) : (
                        <Send className="size-3.5" />
                      )}
                      {sending ? "Sending…" : "Send"}
                    </Button>
                  </div>
                </div>

                {/* Flow-run side card */}
                {selected.flowRun && (
                  <div className="scrollbar-thin hidden w-72 shrink-0 overflow-y-auto border-l border-border bg-surface-panel p-3 xl:block">
                    <FlowRunCard flowRun={selected.flowRun} />
                  </div>
                )}
              </div>
            </>
          )}
        </section>
      </div>

      {/* ─── Delete confirmation ────────────────────────────────── */}
      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete this conversation?"
        description="The thread and its messages are removed from the brain. The lead row in Data (if any) is untouched."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={deleting}
            >
              <Trash2 className="size-3.5" />
              {deleting ? "Deleting…" : "Delete"}
            </Button>
          </>
        }
      />
    </div>
  );
};

ConversationsSection.displayName = "ConversationsSection";
