/**
 * ApprovalCard — the Calla differentiator
 * ───────────────────────────────────────
 * One human-in-the-loop gate, from any of the four sources (mastra brain,
 * cloudflare edge, core VM, data plane), rendered with everything a reviewer
 * needs to decide in-place: risk, tool, agent, summary, the exact arguments
 * about to be executed, when it was requested and when the gate expires.
 *
 * Anatomy (spec §3.3):
 *   ┌─────────────────────────────────────────────────────┐
 *   │ ⚠️  SEND EXTERNAL EMAIL          [mastra]   [HIGH]  │
 *   │ Agent: orchestrator                                 │
 *   │ <summary>                                           │
 *   │ { …arguments… }                                     │
 *   │ Requested: 2 minutes ago · Timeout: 23h remaining   │
 *   │ [ ✓ Approve ] [ ✗ Decline ] [ ✎ Edit & Approve ]    │
 *   └─────────────────────────────────────────────────────┘
 *
 * "Edit & Approve" opens a dialog with the raw JSON — parse-validated before
 * it is sent as updatedArgs (never approve malformed arguments).
 */

import * as React from "react";
import {
  AlertTriangle,
  Check,
  Clock,
  Info,
  Loader2,
  Pencil,
  ShieldAlert,
  Wrench,
  X,
} from "lucide-react";
import type { ApprovalDecision, ApprovalRequest, ApprovalSource, ApprovalStatus, RiskLevel } from "@calla/shared";
import { Badge, Button, Dialog, Textarea } from "@/components/ui";
import { cn, relativeTime, timeUntil } from "@/lib/utils";

// ─── Props ───────────────────────────────────────────────────────

export interface ApprovalCardProps {
  approval: ApprovalRequest;
  onDecide(decision: ApprovalDecision): Promise<void>;
  /** A decision for this card is in flight. */
  busy?: boolean;
  /** Keyboard focus (j/k) — draws the primary ring. */
  focused?: boolean;
}

type CardAction = "approve" | "decline" | "edit";

// ─── Styling maps ────────────────────────────────────────────────

const RISK_STYLE: Record<RiskLevel, { className: string; Icon: React.ComponentType<{ className?: string }> }> = {
  critical: { className: "border-transparent bg-destructive text-destructive-foreground", Icon: ShieldAlert },
  high: { className: "border-transparent bg-destructive/15 text-destructive", Icon: AlertTriangle },
  medium: { className: "border-transparent bg-warning/15 text-warning", Icon: AlertTriangle },
  low: { className: "border-transparent bg-info/15 text-info", Icon: Info },
};

const SOURCE_LABEL: Record<ApprovalSource, string> = {
  mastra: "brain",
  cloudflare: "edge",
  core: "core vm",
  data: "data plane",
};

const STATUS_BADGE: Record<ApprovalStatus, { label: string; variant: "warning" | "success" | "muted" | "error" }> = {
  pending: { label: "pending", variant: "warning" },
  approved: { label: "approved", variant: "success" },
  declined: { label: "declined", variant: "error" },
  expired: { label: "expired", variant: "muted" },
};

/** Re-render every 15s so the expiry countdown stays honest. */
function useTicker(intervalMs = 15_000): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

function formatArguments(args: Record<string, unknown>): string {
  if (!args || Object.keys(args).length === 0) return "{}";
  try {
    return JSON.stringify(args, null, 2);
  } catch {
    return String(args);
  }
}

// ─── Component ───────────────────────────────────────────────────

export const ApprovalCard = React.memo<ApprovalCardProps>(
  ({ approval, onDecide, busy = false, focused = false }) => {
    const [action, setAction] = React.useState<CardAction | null>(null);
    const [editOpen, setEditOpen] = React.useState(false);
    const [draft, setDraft] = React.useState("");
    const [draftError, setDraftError] = React.useState<string | null>(null);

    const tick = useTicker();
    const risk = RISK_STYLE[approval.risk] ?? RISK_STYLE.medium;
    const status = STATUS_BADGE[approval.status] ?? STATUS_BADGE.pending;
    const isPending = approval.status === "pending";
    const disabled = busy || !isPending;

    const argsText = React.useMemo(() => formatArguments(approval.arguments), [approval.arguments]);

    // Expiry countdown — recomputed on every tick so it stays honest.
    const expiry = React.useMemo(
      () => (approval.expiresAt ? timeUntil(approval.expiresAt) : null),
      [approval.expiresAt, tick],
    );
    const expiringSoon =
      !!approval.expiresAt &&
      new Date(approval.expiresAt).getTime() - Date.now() < 60 * 60 * 1000;

    const decide = React.useCallback(
      async (kind: CardAction, decision: ApprovalDecision) => {
        if (disabled) return;
        setAction(kind);
        try {
          await onDecide(decision);
        } finally {
          setAction(null);
        }
      },
      [disabled, onDecide],
    );

    const openEdit = React.useCallback(() => {
      setDraft(formatArguments(approval.arguments));
      setDraftError(null);
      setEditOpen(true);
    }, [approval.arguments]);

    const submitEdit = React.useCallback(async () => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(draft);
      } catch (err) {
        setDraftError(err instanceof Error ? err.message : "Invalid JSON");
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setDraftError("Arguments must be a JSON object");
        return;
      }
      setDraftError(null);
      setEditOpen(false);
      await decide("edit", { approved: true, updatedArgs: parsed as Record<string, unknown> });
    }, [draft, decide]);

    const spinner = (kind: CardAction) =>
      busy && action === kind ? <Loader2 className="size-4 animate-spin" /> : null;

    return (
      <>
        <article
          className={cn(
            "relative overflow-hidden rounded-xl border bg-card text-card-foreground shadow-panel transition-shadow",
            focused ? "border-primary ring-2 ring-primary" : "border-border",
            !isPending && "opacity-60",
          )}
          aria-busy={busy}
        >
          {/* Risk accent */}
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-0 left-0 w-1",
              approval.risk === "critical" && "bg-destructive",
              approval.risk === "high" && "bg-destructive/70",
              approval.risk === "medium" && "bg-warning",
              approval.risk === "low" && "bg-info",
            )}
          />

          <div className="space-y-3 p-4 pl-5">
            {/* ─── Header ───────────────────────────────────── */}
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={cn("gap-1 uppercase", risk.className)}>
                <risk.Icon className="size-3" />
                {approval.risk}
              </Badge>

              <span className="inline-flex items-center gap-1.5 font-mono text-xs font-semibold uppercase tracking-wide text-foreground">
                <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="break-all">{approval.toolName}</span>
              </span>

              <span className="ml-auto flex items-center gap-1.5">
                <Badge variant="muted" className="font-mono normal-case">
                  {SOURCE_LABEL[approval.source] ?? approval.source}
                </Badge>
                <Badge variant={status.variant} className="normal-case">
                  {status.label}
                </Badge>
              </span>
            </div>

            {/* ─── Body ─────────────────────────────────────── */}
            <div className="space-y-2">
              <div className="flex items-baseline gap-2 text-xs">
                <span className="shrink-0 text-faint">Agent</span>
                <span className="truncate font-mono text-muted-foreground">{approval.agentId}</span>
              </div>

              {approval.summary && (
                <p className="text-sm leading-relaxed text-body">{approval.summary}</p>
              )}

              <pre className="max-h-40 overflow-x-auto rounded-md bg-surface-canvas p-2 font-mono text-xs text-body scrollbar-thin">
                {argsText}
              </pre>

              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.6875rem] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  <Clock className="size-3 text-faint" />
                  Requested {relativeTime(approval.requestedAt)}
                </span>
                <span
                  className={cn(
                    "inline-flex items-center gap-1",
                    expiry === "expired" && "font-medium text-destructive",
                    expiry && expiringSoon && expiry !== "expired" && "font-medium text-warning",
                  )}
                >
                  <Clock className="size-3 text-faint" />
                  {!expiry
                    ? "No timeout"
                    : expiry === "expired"
                      ? "Expired"
                      : `Expires ${expiry}`}
                </span>
              </div>
            </div>

            {/* ─── Footer ───────────────────────────────────── */}
            {isPending ? (
              <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3">
                <Button
                  variant="success"
                  size="sm"
                  disabled={disabled}
                  onClick={() => decide("approve", { approved: true })}
                  title="Approve (A)"
                >
                  {spinner("approve") ?? <Check className="size-4" />}
                  Approve
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={disabled}
                  onClick={() => decide("decline", { approved: false })}
                  className="text-destructive hover:text-destructive"
                  title="Decline (R)"
                >
                  {spinner("decline") ?? <X className="size-4" />}
                  Decline
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={disabled}
                  onClick={openEdit}
                  className="ml-auto"
                  title="Edit the arguments, then approve"
                >
                  {spinner("edit") ?? <Pencil className="size-4" />}
                  Edit &amp; Approve
                </Button>
                {busy && action === null && (
                  <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                    <Loader2 className="size-3.5 animate-spin" />
                    Deciding…
                  </span>
                )}
              </div>
            ) : (
              <div className="border-t border-border pt-3 text-[0.6875rem] uppercase tracking-[0.06em] text-faint">
                {status.label} — no action available
              </div>
            )}
          </div>
        </article>

        {/* ─── Edit & Approve dialog ─────────────────────────── */}
        <Dialog
          open={editOpen}
          onClose={() => setEditOpen(false)}
          title="Edit arguments"
          description={`Approve ${approval.toolName} with modified arguments. Must stay valid JSON.`}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>
                Cancel
              </Button>
              <Button variant="success" size="sm" onClick={submitEdit} disabled={busy}>
                {busy && action === "edit" ? <Loader2 className="size-4 animate-spin" /> : <Check className="size-4" />}
                Approve with edits
              </Button>
            </>
          }
        >
          <div className="space-y-2">
            <Textarea
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                if (draftError) setDraftError(null);
              }}
              spellCheck={false}
              rows={12}
              aria-label="Approval arguments (JSON)"
              className={cn(
                "font-mono text-xs",
                draftError && "border-destructive focus-visible:ring-destructive",
              )}
            />
            {draftError && (
              <p className="flex items-center gap-1.5 text-xs text-destructive">
                <AlertTriangle className="size-3.5 shrink-0" />
                {draftError}
              </p>
            )}
          </div>
        </Dialog>
      </>
    );
  },
);

ApprovalCard.displayName = "ApprovalCard";
