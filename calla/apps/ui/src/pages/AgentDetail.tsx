/**
 * AgentDetail Page
 * ────────────────
 * Single-agent console for the Calla fleet. Header (back + identity + runtime
 * + status + capabilities) over a four-tab surface:
 *
 *   Chat       — edge agents with supportsChat get the full WebSocket console
 *                (ConnectionBanner · MessageList · ToolCallIndicator ·
 *                 ChatInput + Regenerate/Clear/Reconnect controls); brain
 *                agents get BrainChat (Mastra REST stream + inline HITL);
 *                core/classifier get an explanatory empty state + recent
 *                events from the /events feed.
 *   State      — edge: live DO agentState JSON + CallaState summary cards +
 *                connection meta; core: supervision/tasks via useCoreDeployment;
 *                classifier/brain: hints.
 *   Approvals  — this agent's HITL gates from useApprovals (loose agentId
 *                match), as compact decide-inline cards.
 *   Skills     — the multi-tenant behavior console (brain-side persona
 *                instructions + markdown skill files, editable at runtime);
 *                shown for every runtime since configs are agentId-keyed.
 *
 * Every tab body is wrapped in an ErrorBoundary. The tab is part of the route
 * (/agents/:id/:tab) so deep links + back/forward work.
 */

import React, { useCallback, useMemo, useState } from "react";
import {
  Activity,
  ArrowLeft,
  BookOpen,
  CheckCircle2,
  Inbox,
  MessageSquare,
  Plug,
  RotateCcw,
  Trash2,
} from "lucide-react";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  StatusDot,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui";
import { EmptyState, ErrorBoundary, LoadingState } from "@/components/shared";
import {
  ConnectionBanner,
  MessageList,
  ToolCallIndicator,
  ChatInput,
  BrainChat,
} from "@/components/chat";
import { SkillsTab } from "@/components/skills";
import { useRouter, buildAgentRoute } from "@/hooks/useRouter";
import { useAgentRegistry } from "@/hooks/useAgentRegistry";
import {
  useAgentConnection,
  type UseAgentConnectionResult,
} from "@/hooks/useAgentConnection";
import { useDeploymentSelector } from "@/hooks/useDeploymentSelector";
import { useCoreDeployment } from "@/hooks/useCoreDeployment";
import {
  useConsoleApprovals,
  useConsoleEvents,
} from "@/components/layout/console-context";
import { AGENT_STATUS_LABELS, type AgentRegistryEntry } from "@/constants/agents";
import { relativeTime } from "@/lib/utils";
import type {
  AgentEvent,
  AgentStatus,
  ApprovalDecision,
  ApprovalRequest,
  CallaState,
} from "@calla/shared";
import type { AgentConnectionStatus } from "@/types/agent";

// ─── Public props (contract preserved) ───────────────────────────

export interface AgentDetailProps {
  agentId: string;
  tab?: string;
}

// ─── Constants & helpers ─────────────────────────────────────────

const VALID_TABS = ["chat", "state", "approvals", "skills"] as const;

const RUNTIME_BADGE: Record<string, "info" | "secondary" | "success" | "muted"> = {
  edge: "info",
  core: "secondary",
  brain: "success",
  classifier: "muted",
};

const RISK_BADGE: Record<string, "muted" | "info" | "warning" | "error"> = {
  low: "muted",
  medium: "info",
  high: "warning",
  critical: "error",
};

/** Loose agent match — approvals/events may carry "42:supervisor" or a bare id. */
function matchesAgent(candidate: string | undefined, agentId: string): boolean {
  if (!candidate) return false;
  return (
    candidate === agentId ||
    candidate.endsWith(`:${agentId}`) ||
    candidate.includes(agentId)
  );
}

/** Map a connection/runtime into a StatusDot tone for the header. */
function headerStatus(
  agent: AgentRegistryEntry,
  connStatus: AgentConnectionStatus,
): AgentStatus | "unknown" {
  if (agent.runtime === "edge") {
    switch (connStatus) {
      case "connected":
        return "running";
      case "connecting":
        return "idle";
      case "error":
        return "error";
      case "disconnected":
        return "offline";
      default:
        return "unknown";
    }
  }
  const ds = agent.deploymentStatus;
  if (ds === "suspended" || ds === "failed") return "error";
  if (ds === "pending") return "idle";
  if (ds === "active" || ds === undefined) return "running";
  return "unknown";
}

function runtimeBlurb(agent: AgentRegistryEntry): string {
  switch (agent.runtime) {
    case "core":
      return "Core agents run on the Fly.io VM (REST + supervision polling) — they don't hold a live chat socket. Open the State tab for supervision and tasks.";
    case "classifier":
      return "Classifier agents (jev) are event-driven — they route inbound signals to the fleet instead of chatting. Recent classifications appear below.";
    case "brain":
      return "Brain agents plan via the Mastra runtime. This one isn't chat-enabled.";
    default:
      return "This edge agent doesn't expose a chat console.";
  }
}

// ─── Page ────────────────────────────────────────────────────────

export function AgentDetail({ agentId, tab }: { agentId: string; tab?: string }) {
  const { route, navigate } = useRouter();
  const { getAgentById, loading, error: registryError, refetch } = useAgentRegistry();
  const { deploymentId } = useDeploymentSelector();

  const agent = getAgentById(agentId) ?? null;

  const isEdgeChat = !!agent && agent.runtime === "edge" && agent.supportsChat;
  const isBrain = agent?.runtime === "brain";

  // One connection feeds both the Chat and State tabs (edge only).
  const connAgent = agent && agent.runtime === "edge" ? agent : null;
  const conn = useAgentConnection(connAgent);

  // Shared single-instance approval aggregator + /events socket owned by
  // ConsoleLayout (they wrap useApprovals/useCallaEvents — same return shape).
  // Consuming these avoids opening duplicate sockets/poll loops per screen;
  // we filter to this agent here.
  const approvals = useConsoleApprovals();
  const { events } = useConsoleEvents();

  const agentApprovals = useMemo(
    () => approvals.approvals.filter((a) => matchesAgent(a.agentId, agentId)),
    [approvals.approvals, agentId],
  );
  const pendingCount = useMemo(
    () => agentApprovals.filter((a) => a.status === "pending").length,
    [agentApprovals],
  );

  // The tab lives in the route (/agents/:id/:tab). This screen navigates with
  // pushState, which does NOT notify App's separate useRouter instance — so the
  // live tab is read from THIS component's own router route (updated on
  // navigate + popstate), falling back to the `tab` prop on the first render.
  const routeTab =
    route.view === "agent-detail" && route.agentId === agentId ? route.tab : undefined;
  const effectiveTab = routeTab ?? tab ?? "chat";
  const activeTab = (VALID_TABS as readonly string[]).includes(effectiveTab)
    ? effectiveTab
    : "chat";

  // App owns the authoritative route state via its own useRouter instance, and
  // pushState alone doesn't notify it (App passes onNavigate to the other
  // screens, but this screen's contract is fixed at {agentId, tab}). So we push
  // the URL AND dispatch a popstate event — every router instance (App's and
  // ours) re-parses location and re-renders. Without this, "back to fleet" and
  // tab switches would change the URL but not the visible screen.
  const navigateSync = useCallback(
    (path: string) => {
      navigate(path);
      window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
    },
    [navigate],
  );

  const goBack = useCallback(() => navigateSync("/"), [navigateSync]);

  // ─── Registry loading / error / not-found ──────────────────────
  if (!agent && loading) {
    return <LoadingState message="Loading agent…" />;
  }
  if (!agent && registryError) {
    return (
      <EmptyState
        icon="⚠️"
        title="Couldn't load agents"
        message={`${registryError} Your session may have expired — refresh to sign in again.`}
        action={{ label: "Retry", onClick: refetch }}
      />
    );
  }
  if (!agent) {
    return (
      <EmptyState
        icon="🔍"
        title="Agent not found"
        message={`The agent "${agentId}" does not exist or has been removed.`}
        action={{ label: "Back to fleet", onClick: goBack }}
      />
    );
  }

  const dotStatus = headerStatus(agent, conn.status);

  return (
    <div className="scrollbar-thin flex min-h-0 w-full flex-1 flex-col gap-5 overflow-y-auto p-4 sm:p-6">
      {/* ─── Header ─────────────────────────────────────────────── */}
      <header className="flex flex-col gap-3">
        <Button variant="ghost" size="sm" onClick={goBack} className="w-fit -ml-2 gap-1.5">
          <ArrowLeft className="size-4" />
          Back to fleet
        </Button>

        <div className="flex items-start gap-4">
          <div className="flex size-14 shrink-0 items-center justify-center rounded-xl bg-surface-tag text-3xl">
            {agent.icon}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-2xl font-bold text-foreground">{agent.name}</h1>
              <Badge variant={RUNTIME_BADGE[agent.runtime] ?? "muted"}>{agent.runtime}</Badge>
              <StatusDot status={dotStatus} withLabel />
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{agent.description}</p>
            {agent.capabilities.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {agent.capabilities.map((cap) => (
                  <Badge key={cap} variant="muted" className="font-mono font-normal">
                    {cap}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      </header>

      {/* ─── Tabs ───────────────────────────────────────────────── */}
      <Tabs
        value={activeTab}
        onValueChange={(t) => navigateSync(buildAgentRoute(agentId, t))}
        className="gap-5"
      >
        <TabsList>
          <TabsTrigger value="chat" className="gap-1.5">
            <MessageSquare className="size-3.5" />
            Chat
          </TabsTrigger>
          <TabsTrigger value="state" className="gap-1.5">
            <Activity className="size-3.5" />
            State
          </TabsTrigger>
          <TabsTrigger value="approvals" className="gap-1.5">
            <Inbox className="size-3.5" />
            Approvals
            {pendingCount > 0 && (
              <Badge variant="warning" className="ml-0.5 px-1.5 py-0">
                {pendingCount}
              </Badge>
            )}
          </TabsTrigger>
          <TabsTrigger value="skills" className="gap-1.5">
            <BookOpen className="size-3.5" />
            Skills
          </TabsTrigger>
        </TabsList>

        {/* ─── Chat ─────────────────────────────────────────────── */}
        <TabsContent value="chat">
          <ErrorBoundary key={`chat-${agentId}`}>
            {isEdgeChat ? (
              <EdgeChatPanel agent={agent} conn={conn} />
            ) : isBrain ? (
              <BrainChat agent={agent} />
            ) : (
              <FallbackChatPanel agent={agent} events={events} />
            )}
          </ErrorBoundary>
        </TabsContent>

        {/* ─── State ────────────────────────────────────────────── */}
        <TabsContent value="state">
          <ErrorBoundary key={`state-${agentId}`}>
            {agent.runtime === "edge" ? (
              <EdgeStatePanel agent={agent} conn={conn} />
            ) : agent.runtime === "core" ? (
              <CoreStatePanel deploymentId={deploymentId} />
            ) : agent.runtime === "classifier" ? (
              <EmptyState
                icon="🧬"
                title="Classifier state"
                message="Classifiers are stateless event workers — they don't publish DO state. Ingest signals via the edge event bus (edgeClient.ingestEvent) and watch classifications on the fleet feed."
              />
            ) : (
              <EmptyState
                icon="🧠"
                title="Brain state"
                message="Brain runtime state lives in the Mastra server. Use the Chat tab to drive plans and approve suspended tool calls."
              />
            )}
          </ErrorBoundary>
        </TabsContent>

        {/* ─── Approvals ────────────────────────────────────────── */}
        <TabsContent value="approvals">
          <ErrorBoundary key={`approvals-${agentId}`}>
            <ApprovalsPanel
              approvals={agentApprovals}
              decide={approvals.decide}
            />
          </ErrorBoundary>
        </TabsContent>

        {/* ─── Skills ───────────────────────────────────────────── */}
        <TabsContent value="skills">
          <ErrorBoundary key={`skills-${agentId}`}>
            <SkillsTab
              agentId={agentId}
              hint={
                agent.runtime === "edge"
                  ? "Skills apply to the brain agent with this id; edge engine skills sync is on the roadmap."
                  : undefined
              }
            />
          </ErrorBoundary>
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ─── Chat: edge console ──────────────────────────────────────────

const EdgeChatPanel: React.FC<{
  agent: AgentRegistryEntry;
  conn: UseAgentConnectionResult;
}> = ({ agent, conn }) => {
  const [confirmClear, setConfirmClear] = useState(false);
  const isConnected = conn.status === "connected";
  const canRegenerate =
    isConnected && !conn.isStreaming && conn.messages.some((m) => m.role === "user");
  const canClear = isConnected && !conn.isStreaming && conn.messages.length > 0;

  return (
    <>
      <Card className="flex h-[600px] flex-col overflow-hidden p-0">
        {/* Control bar */}
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <div className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
            <StatusDot status={headerStatus(agent, conn.status)} />
            <span>{AGENT_STATUS_LABELS[conn.status]}</span>
            {conn.reconnectAttempts > 0 && !isConnected && (
              <span>· attempt {conn.reconnectAttempts}</span>
            )}
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="sm"
              title="Re-run the last question"
              disabled={!canRegenerate}
              onClick={() => conn.regenerate()}
            >
              <RotateCcw className="size-4" />
              Regenerate
            </Button>
            <Button
              variant="ghost"
              size="sm"
              title="Clear conversation"
              disabled={!canClear}
              onClick={() => setConfirmClear(true)}
            >
              <Trash2 className="size-4" />
              Clear
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title="Reconnect"
              aria-label="Reconnect"
              onClick={() => conn.reconnect()}
            >
              <Plug className="size-4" />
            </Button>
          </div>
        </div>

        <ConnectionBanner
          status={conn.status}
          reconnectAttempts={conn.reconnectAttempts}
          lastError={conn.lastError}
          onReconnect={() => conn.reconnect()}
        />

        <MessageList messages={conn.messages} className="min-h-0 flex-1" />

        <div className="border-t border-border px-3 pt-2">
          <ToolCallIndicator toolCall={conn.lastToolCall} />
        </div>

        <ChatInput
          agent={agent}
          status={conn.status}
          isStreaming={conn.isStreaming}
          commands={conn.commands}
          onSend={(text) => {
            conn.sendMessage(text);
          }}
          onStop={() => {
            conn.stopChat();
          }}
          appendMessage={conn.appendMessage}
        />
      </Card>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Clear conversation?"
        description="This wipes the pane and the agent's persisted history. The next reconnect starts from a clean slate."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => {
                conn.clearChat();
                setConfirmClear(false);
              }}
            >
              <Trash2 className="size-4" />
              Clear
            </Button>
          </>
        }
      />
    </>
  );
};

// ─── Chat: non-chat fallback ─────────────────────────────────────

const EVENT_BADGE: Record<string, "info" | "success" | "warning" | "error" | "muted"> = {
  state_change: "info",
  tool_call: "muted",
  approval_request: "warning",
  approval_resolved: "success",
  message: "muted",
  error: "error",
  classification_completed: "success",
};

const FallbackChatPanel: React.FC<{
  agent: AgentRegistryEntry;
  events: AgentEvent[];
}> = ({ agent, events }) => {
  const recent = useMemo(
    () =>
      events
        .filter((e) => matchesAgent(e.agentId, agent.id))
        .slice(-15)
        .reverse(),
    [events, agent.id],
  );

  return (
    <div className="flex flex-col gap-4">
      <EmptyState
        icon={<span className="text-4xl">{agent.icon}</span>}
        title={`${agent.name} has no chat console`}
        message={runtimeBlurb(agent)}
      />

      <Card className="p-0">
        <CardHeader className="border-b border-border py-3">
          <CardTitle className="text-sm">Recent events</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {recent.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              No recent events for this agent on the fleet feed.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {recent.map((e) => (
                <li key={e.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge variant={EVENT_BADGE[e.type] ?? "muted"} className="shrink-0">
                    {e.type.replace(/_/g, " ")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate font-mono text-xs text-body">
                    {e.agentId}
                  </span>
                  <span className="shrink-0 text-[0.6875rem] text-faint">
                    {relativeTime(e.timestamp)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// ─── State: edge ─────────────────────────────────────────────────

const EdgeStatePanel: React.FC<{
  agent: AgentRegistryEntry;
  conn: UseAgentConnectionResult;
}> = ({ conn }) => {
  const state = conn.agentState;
  const calla = state as Partial<CallaState> | null;
  const looksLikeCalla =
    !!calla &&
    typeof calla === "object" &&
    ("status" in calla ||
      "currentTask" in calla ||
      "pendingApprovals" in calla ||
      "completedSteps" in calla);

  const pendingCount = Array.isArray(calla?.pendingApprovals)
    ? (calla!.pendingApprovals as unknown[]).length
    : 0;
  const completedCount = Array.isArray(calla?.completedSteps)
    ? (calla!.completedSteps as unknown[]).length
    : 0;

  return (
    <div className="flex flex-col gap-4">
      {looksLikeCalla && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="Status">
            <StatusDot
              status={(calla!.status as AgentStatus) ?? "unknown"}
              withLabel
            />
          </SummaryCard>
          <SummaryCard label="Current task">
            <span className="truncate text-sm text-body">
              {calla!.currentTask ?? "—"}
            </span>
          </SummaryCard>
          <SummaryCard label="Pending approvals">
            <span className="text-2xl font-semibold text-foreground">{pendingCount}</span>
          </SummaryCard>
          <SummaryCard label="Completed steps">
            <span className="text-2xl font-semibold text-foreground">{completedCount}</span>
          </SummaryCard>
        </div>
      )}

      <Card className="p-0">
        <CardHeader className="border-b border-border py-3">
          <CardTitle className="text-sm">Connection</CardTitle>
        </CardHeader>
        <CardContent className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3">
          <Meta label="State">
            <Badge variant={conn.status === "connected" ? "success" : "muted"}>
              {AGENT_STATUS_LABELS[conn.status]}
            </Badge>
          </Meta>
          <Meta label="Reconnect attempts">{String(conn.reconnectAttempts)}</Meta>
          <Meta label="Messages">{String(conn.messages.length)}</Meta>
          <Meta label="Identity · name">{conn.agentIdentity?.name ?? "—"}</Meta>
          <Meta label="Identity · id">
            <span className="font-mono">{conn.agentIdentity?.id ?? "—"}</span>
          </Meta>
          <Meta label="Last tool">
            {conn.lastToolCall ? (
              <span className="font-mono">
                {conn.lastToolCall.name} · {conn.lastToolCall.status}
              </span>
            ) : (
              "—"
            )}
          </Meta>
        </CardContent>
      </Card>

      <Card className="p-0">
        <CardHeader className="border-b border-border py-3">
          <CardTitle className="text-sm">Live agent state</CardTitle>
        </CardHeader>
        <CardContent className="p-4">
          {state ? (
            <pre className="max-h-[60vh] overflow-auto rounded-lg bg-surface-canvas p-4 font-mono text-xs text-body">
              {JSON.stringify(state, null, 2)}
            </pre>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">
              No state synced yet — the agent pushes DO state over the chat socket.
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

const SummaryCard: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <Card className="p-0">
    <CardContent className="flex flex-col gap-1 p-4">
      <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>
      {children}
    </CardContent>
  </Card>
);

const Meta: React.FC<{ label: string; children: React.ReactNode }> = ({
  label,
  children,
}) => (
  <div className="flex flex-col gap-0.5">
    <span className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
      {label}
    </span>
    <span className="truncate text-sm text-body">{children}</span>
  </div>
);

// ─── State: core ─────────────────────────────────────────────────

const CoreStatePanel: React.FC<{ deploymentId?: string }> = ({ deploymentId }) => {
  const core = useCoreDeployment(deploymentId ?? "");

  if (!deploymentId) {
    return (
      <EmptyState
        icon="🕷️"
        title="No deployment selected"
        message="Core supervision and tasks stream from the selected deployment. Choose one to inspect this core agent."
      />
    );
  }

  if (core.loading) return <LoadingState message="Loading core state…" />;

  const sup = core.supervision;

  return (
    <div className="flex flex-col gap-4">
      {core.error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {core.error}
        </p>
      )}

      {sup && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <SummaryCard label="Supervisor">
            <Badge
              variant={
                sup.heartbeatHealth === "healthy"
                  ? "success"
                  : sup.heartbeatHealth === "unresponsive"
                    ? "error"
                    : "warning"
              }
            >
              {sup.supervisorState}
            </Badge>
          </SummaryCard>
          <SummaryCard label="Heartbeat">{sup.heartbeatHealth}</SummaryCard>
          <SummaryCard label="Tokens">
            <span className="text-sm text-body">
              {sup.tokenUsed.toLocaleString()} / {sup.tokenAllowance.toLocaleString()}
            </span>
          </SummaryCard>
          <SummaryCard label="Projected cost">
            <span className="text-sm text-body">${sup.projectedPeriodCost.toFixed(2)}</span>
          </SummaryCard>
        </div>
      )}

      <Card className="p-0">
        <CardHeader className="border-b border-border py-3">
          <CardTitle className="text-sm">Tasks ({core.tasks.length})</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {core.tasks.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              No core tasks reported.
            </p>
          ) : (
            <ul className="divide-y divide-border">
              {core.tasks.slice(0, 25).map((t) => (
                <li key={t.id} className="flex items-center gap-3 px-4 py-2.5">
                  <Badge
                    variant={
                      t.state === "awaiting_input"
                        ? "warning"
                        : t.state === "failed"
                          ? "error"
                          : t.state === "completed"
                            ? "success"
                            : "muted"
                    }
                    className="shrink-0"
                  >
                    {t.state.replace(/_/g, " ")}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-sm text-body">
                    {t.taskType}
                  </span>
                  <span className="shrink-0 font-mono text-[0.6875rem] text-faint">
                    {t.id.slice(0, 8)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
};

// ─── Approvals ───────────────────────────────────────────────────

const ApprovalsPanel: React.FC<{
  approvals: ApprovalRequest[];
  decide: (id: string, decision: ApprovalDecision) => Promise<void>;
}> = ({ approvals, decide }) => {
  const [busyId, setBusyId] = useState<string | null>(null);
  const pending = useMemo(
    () => approvals.filter((a) => a.status === "pending"),
    [approvals],
  );

  const onDecide = useCallback(
    async (id: string, approved: boolean) => {
      setBusyId(id);
      try {
        await decide(id, { approved });
      } finally {
        setBusyId(null);
      }
    },
    [decide],
  );

  if (pending.length === 0) {
    return (
      <EmptyState
        icon={<CheckCircle2 className="size-10 text-success" />}
        title="No pending approvals for this agent"
        message="When this agent hits a human-in-the-loop gate, the request shows up here and in the Inbox."
      />
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {pending.map((a) => {
        const busy = busyId === a.id;
        return (
          <Card key={a.id} className="p-0">
            <CardContent className="flex flex-col gap-3 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant={RISK_BADGE[a.risk] ?? "muted"}>{a.risk} risk</Badge>
                <code className="rounded bg-surface-tag px-1.5 py-0.5 font-mono text-xs text-body">
                  {a.toolName}
                </code>
                <Badge variant="muted" className="ml-auto font-normal">
                  {a.source}
                </Badge>
                <span className="text-[0.6875rem] text-faint">
                  {relativeTime(a.requestedAt)}
                </span>
              </div>

              <p className="text-sm text-body">{a.summary}</p>

              {a.arguments && Object.keys(a.arguments).length > 0 && (
                <details className="group rounded-md border border-border bg-surface-canvas">
                  <summary className="cursor-pointer select-none px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground">
                    arguments
                  </summary>
                  <pre className="scrollbar-thin max-h-64 overflow-auto border-t border-border px-3 py-2 font-mono text-xs text-body">
                    {JSON.stringify(a.arguments, null, 2)}
                  </pre>
                </details>
              )}

              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="success"
                  disabled={busy}
                  onClick={() => void onDecide(a.id, true)}
                >
                  <CheckCircle2 className="size-4" />
                  {busy ? "Working…" : "Approve"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => void onDecide(a.id, false)}
                >
                  Decline
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
};
