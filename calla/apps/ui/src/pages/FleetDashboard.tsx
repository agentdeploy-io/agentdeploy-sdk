/**
 * FleetDashboard — Screen A
 * ─────────────────────────
 * Every agent in the deployment on one screen: live status, pending HITL
 * gates, last activity — plus the raw /events feed down the right rail so the
 * operator can watch the fleet think.
 *
 * Status comes from three signals (see deriveAgentStatus):
 *   pending approvals → awaiting_approval
 *   edge agents       → useAgentHealth HTTP probe (connected/degraded/…)
 *   everything else   → recent calla:* frames on /events
 */

import * as React from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Clock,
  Inbox,
  MessageSquare,
  RefreshCw,
  ShieldAlert,
  Sparkles,
  Timer,
  Users,
  Wrench,
  Zap,
} from "lucide-react";
import { isModuleEnabled } from "@calla/shared";
import type { AgentEvent, AgentEventType, AgentStatus } from "@calla/shared";
import {
  AgentCard,
  deriveAgentStatus,
  eventLabel,
  lastEventForAgent,
} from "@/components/AgentCard";
import { useConsoleApprovals, useConsoleEvents } from "@/components/layout/console-context";
import { Badge, Button, Card, StatusDot } from "@/components/ui";
import { EmptyState, LoadingState } from "@/components/shared";
import { authFetch, buildAgentRoute, useAgentHealth, useAgentRegistry, useDeploymentSelector } from "@/hooks";
import { useModuleConfig } from "@/lib/modules";
import type { AgentRegistryEntry } from "@/constants/agents";
import { cn, relativeTime } from "@/lib/utils";

export interface FleetDashboardProps {
  onNavigate: (path: string) => void;
}

// ─── Event feed presentation ─────────────────────────────────────

const EVENT_ICON: Record<AgentEventType, React.ComponentType<{ className?: string }>> = {
  state_change: Activity,
  tool_call: Wrench,
  approval_request: ShieldAlert,
  approval_resolved: CheckCircle2,
  message: MessageSquare,
  error: AlertTriangle,
  classification_completed: Sparkles,
};

const EVENT_TONE: Partial<Record<AgentEventType, string>> = {
  error: "text-destructive",
  approval_request: "text-warning",
  approval_resolved: "text-success",
  classification_completed: "text-info",
};

const FEED_LABEL: Record<string, { dot: AgentStatus; label: string }> = {
  connected: { dot: "running", label: "Live" },
  connecting: { dot: "idle", label: "Connecting…" },
  disconnected: { dot: "offline", label: "Offline" },
  error: { dot: "error", label: "Error" },
};

const LIVE_EVENT_WINDOW_MS = 5 * 60 * 1000;

/** Re-render periodically so relative timestamps stay honest. */
function useTicker(intervalMs = 30_000): number {
  const [tick, setTick] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}

// ─── Stat card ───────────────────────────────────────────────────

const StatCard: React.FC<{
  label: string;
  value: React.ReactNode;
  icon: React.ReactNode;
  tone?: "default" | "warning" | "success";
  onClick?: () => void;
}> = ({ label, value, icon, tone = "default", onClick }) => {
  const body = (
    <>
      <span
        className={cn(
          "flex size-8 shrink-0 items-center justify-center rounded-md",
          tone === "warning" && "bg-warning/15 text-warning",
          tone === "success" && "bg-success/15 text-success",
          tone === "default" && "bg-surface-tag text-muted-foreground",
        )}
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-xl font-semibold leading-tight text-foreground">{value}</span>
        <span className="block truncate text-[0.6875rem] uppercase tracking-[0.05em] text-faint">
          {label}
        </span>
      </span>
    </>
  );

  const className = cn(
    "flex items-center gap-3 rounded-xl border p-3.5 text-left shadow-panel transition-colors",
    tone === "warning" ? "border-warning/40 bg-warning/10" : "border-border bg-card",
    onClick && "cursor-pointer hover:shadow-elevated",
  );

  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
};

// ─── Agent tile (adds the edge health probe) ─────────────────────

interface FleetAgentTileProps {
  agent: AgentRegistryEntry;
  pendingCount: number;
  events: AgentEvent[];
  onReportStatus: (agentId: string, status: AgentStatus) => void;
  onOpen: () => void;
}

const FleetAgentTile: React.FC<FleetAgentTileProps> = ({
  agent,
  pendingCount,
  events,
  onReportStatus,
  onOpen,
}) => {
  const isEdge = agent.runtime === "edge";
  const { status: connection } = useAgentHealth(isEdge ? agent : null);

  const status = React.useMemo(
    () =>
      deriveAgentStatus(agent, {
        pendingCount,
        connection: isEdge ? connection : undefined,
        events,
      }),
    [agent, pendingCount, connection, isEdge, events],
  );

  React.useEffect(() => {
    onReportStatus(agent.id, status);
  }, [agent.id, status, onReportStatus]);

  return (
    <AgentCard
      agent={agent}
      pendingCount={pendingCount}
      status={status}
      lastEvent={lastEventForAgent(events, agent.id)}
      onOpen={onOpen}
    />
  );
};

// ─── Live events rail ────────────────────────────────────────────

const LiveEventsPanel: React.FC = () => {
  const { events, status, reconnect, reconnectAttempts } = useConsoleEvents();
  // Keeps the relative timestamps fresh without waiting for a new frame.
  useTicker();

  const recent = React.useMemo(() => events.slice(-12).reverse(), [events]);
  const feed = FEED_LABEL[status] ?? FEED_LABEL.disconnected;

  return (
    <Card className="sticky top-20 flex max-h-[calc(100vh-7rem)] flex-col overflow-hidden p-0">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Live events</h2>
        <span className="ml-auto flex items-center gap-1.5">
          <StatusDot status={feed.dot} />
          <span className="text-[0.6875rem] text-muted-foreground">{feed.label}</span>
        </span>
      </div>

      {status !== "connected" && (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-warning/10 px-4 py-2 text-[0.6875rem] text-warning">
          <span className="min-w-0 flex-1 truncate">
            /events {status}
            {reconnectAttempts > 0 ? ` · retry ${reconnectAttempts}` : ""}
          </span>
          <Button variant="ghost" size="icon-sm" onClick={reconnect} aria-label="Reconnect event feed">
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {recent.length === 0 ? (
          <EmptyState
            icon={<Zap className="size-6 text-muted-foreground" />}
            title="No events yet"
            message="Agent state changes, tool calls and approval gates stream in here as they happen."
            className="py-8"
          />
        ) : (
          <ul className="divide-y divide-border">
            {recent.map((event) => {
              const Icon = EVENT_ICON[event.type] ?? Activity;
              return (
                <li key={event.id} className="flex items-start gap-2.5 px-4 py-2.5">
                  <Icon
                    className={cn(
                      "mt-0.5 size-3.5 shrink-0 text-muted-foreground",
                      EVENT_TONE[event.type],
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[0.6875rem] text-foreground">
                      {event.agentId}
                    </div>
                    <div className="truncate text-[0.6875rem] text-muted-foreground">
                      {eventLabel(event.type)}
                    </div>
                  </div>
                  <span className="shrink-0 text-[0.625rem] text-faint">
                    {relativeTime(event.timestamp)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Card>
  );
};

// ─── Lead-gen pipeline card ──────────────────────────────────────

/**
 * Shown only when the Data module is on. Surfaces the crawl/schedule state
 * and points at the Operations screen — the discoverability fix for "where
 * is the cron?".
 */
const PipelineCard: React.FC<{ onNavigate: (path: string) => void }> = ({ onNavigate }) => {
  const { deploymentId } = useDeploymentSelector();
  const [info, setInfo] = React.useState<{
    paused: boolean;
    lastRunAt: string | null;
    lastState: string | null;
    nextCron: string | null;
    funnel: Array<{ stage: string; count: number }>;
  } | null>(null);

  const load = React.useCallback(async () => {
    if (!deploymentId) return;
    try {
      const [s, p] = await Promise.all([
        authFetch(`/d/${deploymentId}/cmd/schedules`, { signal: AbortSignal.timeout(8000) }),
        authFetch(`/d/${deploymentId}/cmd/pipeline`, { signal: AbortSignal.timeout(8000) }),
      ]);
      if (!s.ok) return;
      const sj = (await s.json()) as {
        schedules?: Array<{ name: string; cron: string; enabled: boolean; lastRun: string | null }>;
        paused?: boolean;
      };
      const crawl = sj.schedules?.find((x) => x.name === "crawl");
      let lastRunAt: string | null = null;
      let lastState: string | null = null;
      if (p.ok) {
        const pj = (await p.json()) as {
          funnel?: Array<{ stage: string; count: number }>;
          lastCrawl?: { started_at?: string; startedAt?: string; state?: string } | null;
        };
        setInfo((prev) => ({
          paused: !!sj.paused,
          lastRunAt: pj.lastCrawl?.started_at ?? pj.lastCrawl?.startedAt ?? null,
          lastState: pj.lastCrawl?.state ?? null,
          nextCron: crawl?.enabled ? crawl.cron : null,
          funnel: pj.funnel ?? prev?.funnel ?? [],
        }));
      } else {
        setInfo({ paused: !!sj.paused, lastRunAt, lastState, nextCron: crawl?.enabled ? crawl.cron : null, funnel: [] });
      }
    } catch {
      /* engine down — card stays hidden */
    }
  }, [deploymentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (!deploymentId || !info) return null;

  return (
    <Card className="flex flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Timer className="size-4 text-muted-foreground" />
          <span className="text-sm font-semibold text-foreground">Lead-gen pipeline</span>
          <Badge variant={info.paused ? "warning" : "success"}>
            {info.paused ? "Paused" : "Running"}
          </Badge>
        </div>
        <Button size="sm" variant="outline" onClick={() => onNavigate("/operations")}>
          Open Operations →
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[0.75rem] text-muted-foreground">
        <span>
          Crawl schedule{" "}
          <b className="font-mono text-foreground">{info.nextCron ?? "—"}</b>
        </span>
        <span>
          Last run{" "}
          <b className="text-foreground">
            {info.lastRunAt ? `${relativeTime(info.lastRunAt)}${info.lastState ? ` · ${info.lastState}` : ""}` : "never"}
          </b>
        </span>
        {info.funnel.length > 0 && (
          <span className="flex flex-wrap gap-x-2">
            {info.funnel.map((f) => (
              <span key={f.stage}>
                {f.stage} <b className="text-foreground tabular-nums">{f.count}</b>
              </span>
            ))}
          </span>
        )}
      </div>
      <p className="text-[0.6875rem] text-faint">
        Start/stop, edit crons, run a crawl now, set your campaign and test the full send→reply loop in Operations.
      </p>
    </Card>
  );
};

// ─── Screen ──────────────────────────────────────────────────────

export const FleetDashboard: React.FC<FleetDashboardProps> = ({ onNavigate }) => {
  const { agents, loading, error, refetch } = useAgentRegistry();
  const { modules } = useModuleConfig();
  const { approvals, counts } = useConsoleApprovals();
  const { events, status } = useConsoleEvents();
  const [statusByAgent, setStatusByAgent] = React.useState<Record<string, AgentStatus>>({});

  const reportStatus = React.useCallback((agentId: string, next: AgentStatus) => {
    setStatusByAgent((prev) => (prev[agentId] === next ? prev : { ...prev, [agentId]: next }));
  }, []);

  const pendingByAgent = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const approval of approvals) {
      if (approval.status !== "pending") continue;
      map.set(approval.agentId, (map.get(approval.agentId) ?? 0) + 1);
    }
    return map;
  }, [approvals]);

  const eventsByAgent = React.useMemo(() => {
    const now = Date.now();
    const map = new Map<string, AgentEvent[]>();
    for (const event of events) {
      if (now - new Date(event.timestamp).getTime() > LIVE_EVENT_WINDOW_MS * 12) continue;
      const list = map.get(event.agentId);
      if (list) list.push(event);
      else map.set(event.agentId, [event]);
    }
    return map;
  }, [events]);

  const running = React.useMemo(
    () => Object.values(statusByAgent).filter((s) => s === "running").length,
    [statusByAgent],
  );
  const awaiting = React.useMemo(
    () => Object.values(statusByAgent).filter((s) => s === "awaiting_approval").length,
    [statusByAgent],
  );

  const feed = FEED_LABEL[status] ?? FEED_LABEL.disconnected;

  return (
    <div className="mx-auto flex w-full max-w-[1600px] gap-6">
      <div className="min-w-0 flex-1 space-y-6">
        {/* ─── Header ───────────────────────────────────────── */}
        <header className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Fleet</h1>
          <p className="text-[0.8125rem] text-muted-foreground">
            Every agent in this deployment, its live state, and what is waiting on a human.
          </p>
        </header>

        {/* ─── Summary strip ────────────────────────────────── */}
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          <StatCard label="Total agents" value={agents.length} icon={<Users className="size-4" />} />
          <StatCard
            label="Running"
            value={running}
            tone="success"
            icon={<Activity className="size-4" />}
          />
          <StatCard
            label="Awaiting approval"
            value={counts.pending}
            tone="warning"
            icon={<Inbox className="size-4" />}
            onClick={() => onNavigate("/inbox")}
          />
          <div className="flex items-center gap-3 rounded-xl border border-border bg-card p-3.5 shadow-panel">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
              <Zap className="size-4" />
            </span>
            <span className="min-w-0">
              <span className="flex items-center gap-1.5 text-sm font-semibold leading-tight text-foreground">
                <StatusDot status={feed.dot} />
                {feed.label}
              </span>
              <span className="block truncate text-[0.6875rem] uppercase tracking-[0.05em] text-faint">
                Events feed
              </span>
            </span>
          </div>
        </div>

        {isModuleEnabled("data", modules) && (
          <PipelineCard onNavigate={onNavigate} />
        )}

        {awaiting > 0 && (
          <button
            type="button"
            onClick={() => onNavigate("/inbox")}
            className="flex w-full items-center gap-2 rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-left text-[0.8125rem] text-warning transition-colors hover:bg-warning/15"
          >
            <Clock className="size-4 shrink-0" />
            {awaiting} {awaiting === 1 ? "agent is" : "agents are"} blocked on a human decision —
            open the approval inbox
          </button>
        )}

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

        {/* ─── Agent grid ───────────────────────────────────── */}
        {loading ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <LoadingState key={i} variant="card" />
            ))}
          </div>
        ) : agents.length === 0 ? (
          <Card>
            <EmptyState
              icon={<Users className="size-7 text-muted-foreground" />}
              title="No agents deployed"
              message="Once this deployment provisions its agents they show up here with live status."
              action={{ label: "Reload registry", onClick: refetch }}
              actionVariant="outline"
            />
          </Card>
        ) : (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {agents.map((agent) => (
              <FleetAgentTile
                key={agent.id}
                agent={agent}
                pendingCount={pendingByAgent.get(agent.id) ?? 0}
                events={eventsByAgent.get(agent.id) ?? []}
                onReportStatus={reportStatus}
                onOpen={() => onNavigate(buildAgentRoute(agent.id, "chat"))}
              />
            ))}
          </div>
        )}
      </div>

      {/* ─── Right rail ─────────────────────────────────────── */}
      <aside className="hidden w-80 shrink-0 xl:block">
        <LiveEventsPanel />
      </aside>
    </div>
  );
};

FleetDashboard.displayName = "FleetDashboard";
