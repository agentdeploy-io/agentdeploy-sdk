/**
 * ApprovalInbox — Screen B
 * ────────────────────────
 * The unified HITL queue: brain tool gates, edge workflow steps, core VM
 * tasks awaiting input, and data-plane review rows — one list, one decide().
 *
 * Keyboard flow (mirrors the playground HITL view):
 *   j / k  move focus      a  approve      r / e  decline / edit-decision
 * Shortcuts are ignored while typing in a field.
 */

import * as React from "react";
import { AlertTriangle, Inbox, RefreshCw, Search, X } from "lucide-react";
import type { ApprovalDecision, ApprovalRequest, ApprovalSource, RiskLevel } from "@calla/shared";
import { ApprovalCard } from "@/components/ApprovalCard";
import { useConsoleApprovals } from "@/components/layout/console-context";
import { Badge, Button, Card, Input, Skeleton, Tabs, TabsList, TabsTrigger } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { buildAgentRoute, toast, useAgentRegistry } from "@/hooks";
import { cn } from "@/lib/utils";

export interface ApprovalInboxProps {
  onNavigate: (path: string) => void;
}

// ─── Constants ───────────────────────────────────────────────────

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];

const SOURCE_TABS: Array<{ source: ApprovalSource; label: string }> = [
  { source: "mastra", label: "Brain" },
  { source: "cloudflare", label: "Edge" },
  { source: "core", label: "Core VM" },
  { source: "data", label: "Data plane" },
];

const RISK_CHIP_CLASS: Record<RiskLevel, string> = {
  low: "border-info/40 bg-info/15 text-info",
  medium: "border-warning/40 bg-warning/15 text-warning",
  high: "border-destructive/40 bg-destructive/15 text-destructive",
  critical: "border-destructive bg-destructive text-destructive-foreground",
};

// ─── Screen ──────────────────────────────────────────────────────

export const ApprovalInbox: React.FC<ApprovalInboxProps> = ({ onNavigate }) => {
  const { approvals, counts, isLoading, error, decide, refetch } = useConsoleApprovals();
  const { getAgentById } = useAgentRegistry();

  const [tab, setTab] = React.useState("pending");
  const [risks, setRisks] = React.useState<ReadonlySet<RiskLevel>>(() => new Set());
  const [query, setQuery] = React.useState("");
  const [focusIdx, setFocusIdx] = React.useState(0);
  const [busyId, setBusyId] = React.useState<string | null>(null);

  // ─── Filtering ───────────────────────────────────────────────

  const visible = React.useMemo(() => {
    const q = query.trim().toLowerCase();

    return approvals.filter((a) => {
      if (tab === "pending" && a.status !== "pending") return false;
      if (tab === "history" && a.status === "pending") return false;
      if (tab.startsWith("source:") && a.source !== tab.slice("source:".length)) return false;
      // Source tabs are pending queues — their badge counts pending only.
      if (tab.startsWith("source:") && a.status !== "pending") return false;
      if (risks.size > 0 && !risks.has(a.risk)) return false;
      if (!q) return true;
      return (
        a.summary.toLowerCase().includes(q) ||
        a.toolName.toLowerCase().includes(q) ||
        a.agentId.toLowerCase().includes(q)
      );
    });
  }, [approvals, tab, risks, query]);

  // Reset focus whenever the list identity changes.
  React.useEffect(() => {
    setFocusIdx(0);
  }, [tab, query, risks]);

  React.useEffect(() => {
    setFocusIdx((prev) => (visible.length === 0 ? 0 : Math.min(prev, visible.length - 1)));
  }, [visible.length]);

  const focused = visible[focusIdx];

  // Keep the focused card on screen.
  React.useEffect(() => {
    if (!focused) return;
    document
      .getElementById(`approval-${focused.id}`)
      ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [focusIdx, focused]);

  // ─── Decisions ───────────────────────────────────────────────

  const handleDecide = React.useCallback(
    async (approval: ApprovalRequest, decision: ApprovalDecision) => {
      setBusyId(approval.id);
      try {
        await decide(approval.id, decision);
        // decide() rolls back + toasts on failure; success is optimistic.
        if (decision.approved) {
          toast.success("Approved", `${approval.toolName} · ${approval.agentId}`);
        } else {
          toast.info("Declined", `${approval.toolName} · ${approval.agentId}`);
        }
      } finally {
        setBusyId(null);
      }
    },
    [decide],
  );

  const decideFocused = React.useCallback(
    (decision: ApprovalDecision) => {
      if (!focused || focused.status !== "pending") return;
      void handleDecide(focused, decision);
    },
    [focused, handleDecide],
  );

  // ─── Keyboard flow ───────────────────────────────────────────

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping) return;
      if (document.querySelector('[role="dialog"]')) return;

      switch (e.key.toLowerCase()) {
        case "j":
          e.preventDefault();
          setFocusIdx((i) => Math.min(i + 1, Math.max(visible.length - 1, 0)));
          break;
        case "k":
          e.preventDefault();
          setFocusIdx((i) => Math.max(i - 1, 0));
          break;
        case "a":
          e.preventDefault();
          decideFocused({ approved: true });
          break;
        case "r":
        case "e":
          e.preventDefault();
          decideFocused({ approved: false });
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [visible.length, decideFocused]);

  // ─── Tab config ──────────────────────────────────────────────

  const tabs = React.useMemo(
    () => [
      { value: "all", label: "All", count: counts.all },
      { value: "pending", label: "Needs review", count: counts.pending },
      { value: "history", label: "History", count: counts.history },
      ...SOURCE_TABS.map(({ source, label }) => ({
        value: `source:${source}`,
        label,
        count: counts.bySource[source] ?? 0,
      })),
    ],
    [counts],
  );

  const toggleRisk = (risk: RiskLevel) => {
    setRisks((prev) => {
      const next = new Set(prev);
      if (next.has(risk)) next.delete(risk);
      else next.add(risk);
      return next;
    });
  };

  const filtersActive = risks.size > 0 || query.trim().length > 0;

  return (
    <div className="mx-auto w-full max-w-4xl space-y-5">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Approvals</h1>
          <Badge variant={counts.pending > 0 ? "warning" : "muted"}>{counts.pending} pending</Badge>
          <Badge variant="muted">{counts.all} total</Badge>
        </div>
        <p className="text-[0.8125rem] text-muted-foreground">
          Every human gate across the brain, edge, core VM and data plane.
          <span className="ml-2 hidden text-faint italic sm:inline">
            j/k navigate · a approve · r decline
          </span>
        </p>
      </header>

      {/* ─── Tabs ───────────────────────────────────────────── */}
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="h-auto flex-wrap justify-start">
          {tabs.map((t) => (
            <TabsTrigger key={t.value} value={t.value} className="gap-1.5">
              {t.label}
              {t.count > 0 && (
                <span
                  className={cn(
                    "rounded-full px-1.5 text-[0.625rem] font-semibold",
                    tab === t.value ? "bg-surface-tag text-foreground" : "bg-surface-tag/70 text-muted-foreground",
                  )}
                >
                  {t.count}
                </span>
              )}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {/* ─── Filters ────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="min-w-[200px] flex-1">
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search summary, tool or agent…"
            aria-label="Search approvals"
            leftIcon={<Search />}
          />
        </div>

        <div className="flex items-center gap-1.5">
          {RISK_LEVELS.map((risk) => {
            const active = risks.has(risk);
            return (
              <button
                key={risk}
                type="button"
                onClick={() => toggleRisk(risk)}
                aria-pressed={active}
                className={cn(
                  "rounded-full border px-2.5 py-1 text-[0.6875rem] font-semibold capitalize transition-colors",
                  active
                    ? RISK_CHIP_CLASS[risk]
                    : "border-border text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                {risk}
              </button>
            );
          })}

          {(filtersActive || tab !== "pending") && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label="Clear filters"
              title="Clear filters"
              onClick={() => {
                setRisks(new Set());
                setQuery("");
                setTab("pending");
              }}
            >
              <X className="size-3.5" />
            </Button>
          )}

          <Button
            variant="outline"
            size="sm"
            onClick={refetch}
            title="Refetch every source"
            className="ml-auto"
          >
            <RefreshCw className="size-3.5" />
            Refresh
          </Button>
        </div>
      </div>

      {/* ─── Error banner ───────────────────────────────────── */}
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
          <AlertTriangle className="size-4 shrink-0" />
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      {/* ─── List ───────────────────────────────────────────── */}
      {isLoading && approvals.length === 0 ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <Card key={i} className="space-y-3 p-4">
              <div className="flex gap-2">
                <Skeleton className="h-5 w-16" />
                <Skeleton className="h-5 w-40" />
                <Skeleton className="ml-auto h-5 w-20" />
              </div>
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-24 w-full" />
              <div className="flex gap-2">
                <Skeleton className="h-8 w-24" />
                <Skeleton className="h-8 w-24" />
              </div>
            </Card>
          ))}
        </div>
      ) : visible.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Inbox className="size-7 text-muted-foreground" />}
              title={
                filtersActive || query.trim()
                  ? "No approvals match those filters"
                  : tab === "pending"
                    ? "All caught up"
                    : tab === "history"
                      ? "No decided approvals yet"
                      : tab === "all"
                        ? "Nothing in the inbox"
                        : `No pending ${tabs.find((t) => t.value === tab)?.label.toLowerCase() ?? "source"} approvals`
              }
              message={
                filtersActive || query.trim()
                  ? "Loosen the risk chips or clear the search to see more of the queue."
                  : tab === "pending"
                    ? "No automation steps awaiting approval — leads are reviewed in bulk under Data. New gates stream in live."
                    : tab === "history"
                      ? "Approved and discarded reply drafts land here for audit once you decide them."
                      : "Decided and expired gates are kept here for audit."
              }
            action={
              filtersActive
                ? {
                    label: "Clear filters",
                    onClick: () => {
                      setRisks(new Set());
                      setQuery("");
                    },
                  }
                : {
                    label: "Open Data section",
                    onClick: () => onNavigate("/data"),
                  }
            }
            actionVariant="outline"
          />
        </Card>
      ) : (
        <div className="space-y-3">
          {visible.map((approval, index) => (
            <div key={approval.id} id={`approval-${approval.id}`}>
              <ApprovalCard
                approval={approval}
                busy={busyId === approval.id}
                focused={index === focusIdx}
                onDecide={(decision) => handleDecide(approval, decision)}
              />
              {approval.status === "pending" && getAgentById(approval.agentId) && (
                <button
                  type="button"
                  onClick={() => onNavigate(buildAgentRoute(approval.agentId, "chat"))}
                  className="mt-1 px-1 text-[0.6875rem] text-faint underline-offset-2 transition-colors hover:text-primary hover:underline"
                >
                  Open {approval.agentId} →
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

ApprovalInbox.displayName = "ApprovalInbox";
