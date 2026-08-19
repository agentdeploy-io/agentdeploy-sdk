/**
 * AgentDetailView Component
 * ─────────────────────────
 * Detail view for a single agent with tabbed sub-navigation.
 *
 * Layout (from edge.pen mockups L7Qz4 / oChJg):
 *   ┌─────────────────────────────────────────────┐
 *   │ ← Back  Agent Name  Status Badge            │
 *   │ Icon + description + capabilities           │
 *   ├──────────────────────────────────────────────┤
 *   │ Chat | Monitor | Config | Schedules | ...   │
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │ Tab Content                                  │
 *   │                                              │
 *   └──────────────────────────────────────────────┘
 *
 * Tabs: Chat, Monitor, Configuration, Schedules, Storage, Logs, Traces, Versions
 */

import React from "react";
import { Card, Badge, Button, Tabs, StatusDot, MetricCard, CodeBlock } from "../components/ui";
import { LoadingState, EmptyState, ErrorBoundary } from "../components/shared";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import {
  getAgentById,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_BADGE_VARIANT,
} from "../constants/agents";
import { AGENT_TABS } from "../constants/navigation";
import { useAgentConnection } from "../hooks/useAgentConnection";
import { useAgentHealth } from "../hooks/useAgentHealth";
import { useAgentInfo } from "../hooks/useAgentInfo";
import { AppErrors } from "../errors/AppError";
import {
  TOAST_RECONNECT_EVENT,
  TOAST_RETRY_EVENT,
} from "../components/layout/ToastContainer";
import type { ChatMessage } from "../types/agent";

// ─── Props ───────────────────────────────────────────────────────

export interface AgentDetailViewProps {
  agentId: string;
  tab: string;
  onNavigateTab: (tabId: string) => void;
  onNavigateBack: () => void;
}

// ─── Main Component ──────────────────────────────────────────────

export const AgentDetailView: React.FC<AgentDetailViewProps> = ({
  agentId,
  tab,
  onNavigateTab,
  onNavigateBack,
}) => {
  const agent = getAgentById(agentId);

  // ─── Agent Not Found ──────────────────────────────────────────

  if (!agent) {
    return (
      <EmptyState
        icon="🔍"
        title="Agent Not Found"
        message={`The agent "${agentId}" does not exist or has been removed.`}
        action={{ label: "Back to Agents", onClick: onNavigateBack }}
      />
    );
  }

  // ─── Tab Config ───────────────────────────────────────────────

  const availableTabs = AGENT_TABS.filter((t) => {
    // Hide schedules tab for non-cron agents
    if (t.id === "schedules" && !agent.hasCron) return false;
    return true;
  }).map((t) => ({
    id: t.id,
    label: t.label,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <AgentDetailHeader agent={agent} onBack={onNavigateBack} />

      {/* ─── Tabs ─────────────────────────────────────────────── */}
      <div style={{ marginTop: "16px" }}>
        <Tabs tabs={availableTabs} activeTab={tab} onChange={onNavigateTab} />
      </div>

      {/* ─── Tab Content ──────────────────────────────────────── */}
      <div style={{ marginTop: "24px" }}>
        <ErrorBoundary key={`${agentId}-${tab}`}>
          {tab === "chat" && <AgentChatTab agent={agent} />}
          {tab === "monitor" && <AgentMonitorTab agent={agent} />}
          {tab === "config" && <AgentConfigTab agent={agent} />}
          {tab === "schedules" && <AgentSchedulesTab agent={agent} />}
          {tab === "storage" && <AgentStorageTab agent={agent} />}
          {tab === "logs" && <AgentLogsTab agent={agent} />}
          {tab === "traces" && <AgentTracesTab agent={agent} />}
          {tab === "versions" && <AgentVersionsTab agent={agent} />}
        </ErrorBoundary>
      </div>
    </div>
  );
};

// ─── Header Sub-Component ────────────────────────────────────────

const AgentDetailHeader: React.FC<{
  agent: NonNullable<ReturnType<typeof getAgentById>>;
  onBack: () => void;
}> = ({ agent, onBack }) => {
  const { status } = useAgentHealth(agent);
  const { info } = useAgentInfo(agent);

  return (
    <div>
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack} leftIcon={<span>←</span>}>
        Back to Agents
      </Button>

      {/* Agent info */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "16px",
          marginTop: "12px",
        }}
      >
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: RADIUS.lg,
            backgroundColor: COLORS.secondary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.75rem",
            flexShrink: 0,
          }}
        >
          {agent.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground }}>
              {agent.name}
            </h1>
            <Badge variant={AGENT_STATUS_BADGE_VARIANT[status]} dot>
              {AGENT_STATUS_LABELS[status]}
            </Badge>
          </div>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            {agent.description}
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <Badge variant="neutral">{agent.kind}</Badge>
            <Badge variant="neutral">port:{agent.port}</Badge>
            {/* Show real model from /health endpoint */}
            {info && (
              <>
                <Badge variant="info">model:{info.model}</Badge>
                {info.templateId && (
                  <Badge variant="info">template:{info.templateId}</Badge>
                )}
                {info.version && (
                  <Badge variant="success">v{info.version}</Badge>
                )}
              </>
            )}
            {agent.capabilities
              .filter((cap) => !cap.startsWith("rpc:") && !cap.startsWith("cron:"))
              .map((cap) => (
                <Badge key={cap} variant="info">
                  {cap}
                </Badge>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Chat Tab ────────────────────────────────────────────────────

const AgentChatTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = ({
  agent,
}) => {
  const { status, messages, sendMessage, reconnect, reconnectAttempts, lastError, lastToolCall } = useAgentConnection(agent);
  const [input, setInput] = React.useState("");
  const [isTyping, setIsTyping] = React.useState(false);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const prevMessageCountRef = React.useRef(0);
  const typingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if user sent a message and is waiting for a response
  const waitingForResponse = React.useRef(false);

  // ─── Listen for toast action events (reconnect/retry from toast buttons) ───
  React.useEffect(() => {
    const handleReconnect = () => reconnect();
    window.addEventListener(TOAST_RECONNECT_EVENT, handleReconnect);
    window.addEventListener(TOAST_RETRY_EVENT, handleReconnect);
    return () => {
      window.removeEventListener(TOAST_RECONNECT_EVENT, handleReconnect);
      window.removeEventListener(TOAST_RETRY_EVENT, handleReconnect);
    };
  }, [reconnect]);

  // Auto-scroll to bottom on new messages (only if already at bottom)
  const scrollToBottom = React.useCallback((smooth = true) => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Check if user is near the bottom of the scroll area
  const isNearBottom = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const threshold = 100; // pixels from bottom
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Track scroll position
  const handleScroll = React.useCallback(() => {
    setShowScrollButton(!isNearBottom());
  }, [isNearBottom]);

  // Auto-scroll and typing detection
  React.useEffect(() => {
    const wasNearBottom = isNearBottom();
    const newCount = messages.length;
    const oldCount = prevMessageCountRef.current;
    prevMessageCountRef.current = newCount;

    // New message arrived
    if (newCount > oldCount) {
      const lastMsg = messages[messages.length - 1];

      // If user was waiting for a response and got an assistant message
      if (waitingForResponse.current && lastMsg?.role === "assistant") {
        waitingForResponse.current = false;
        setIsTyping(false);
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }

      // If user sent a message, show typing indicator while waiting
      if (lastMsg?.role === "user" && status === "connected") {
        waitingForResponse.current = true;
        setIsTyping(true);
        // Safety timeout: clear typing after 30s even if no response
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          setIsTyping(false);
          waitingForResponse.current = false;
        }, 30000);
      }

      // Auto-scroll only if user was already near bottom
      if (wasNearBottom) {
        scrollToBottom();
      }
    }
  }, [messages, status, isNearBottom, scrollToBottom]);

  // Clear typing timer on unmount
  React.useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // Reset typing when connection drops
  React.useEffect(() => {
    if (status !== "connected") {
      setIsTyping(false);
      waitingForResponse.current = false;
    }
  }, [status]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim()) return;
    const sent = sendMessage(input.trim());
    if (sent) {
      setInput("");
    }
  };

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const isError = status === "error";

  // Connection banner style based on status
  const bannerConfig = React.useMemo(() => {
    if (isError) {
      return {
        bg: "var(--color-error-bg)",
        border: STATUS_COLORS.error,
        icon: "⚠",
        message: lastError ?? "Connection failed. The agent may be offline.",
      };
    }
    if (isConnecting) {
      return {
        bg: "var(--color-warning-bg)",
        border: STATUS_COLORS.warning,
        icon: "↻",
        message: reconnectAttempts > 0
          ? `Reconnecting… (attempt ${reconnectAttempts})`
          : "Establishing connection…",
      };
    }
    if (status === "disconnected") {
      return {
        bg: "var(--color-warning-bg)",
        border: STATUS_COLORS.warning,
        icon: "⇋",
        message: "Disconnected from agent.",
      };
    }
    return null;
  }, [status, isError, isConnecting, lastError, reconnectAttempts]);

  return (
    <Card padding="none" style={{ height: "600px", display: "flex", flexDirection: "column" }}>
      {/* ─── Connection Bar ────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <StatusDot variant={AGENT_STATUS_BADGE_VARIANT[status]} pulse={isConnected} />
          <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            {AGENT_STATUS_LABELS[status]}
            {reconnectAttempts > 0 && !isConnected && ` · attempt ${reconnectAttempts}`}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {isConnected && messages.length > 0 && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                /* TODO: clear messages */
              }}
            >
              Clear
            </Button>
          )}
          {!isConnected && (
            <Button
              variant={isError ? "primary" : "secondary"}
              size="sm"
              onClick={reconnect}
              loading={isConnecting}
            >
              {isConnecting ? "Connecting…" : "Reconnect"}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Connection State Banner ───────────────────────── */}
      {bannerConfig && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 16px",
            backgroundColor: bannerConfig.bg,
            borderBottom: `1px solid ${COLORS.border}`,
            fontSize: "0.75rem",
            color: COLORS.foreground,
          }}
        >
          <span style={{ color: bannerConfig.border, fontSize: "0.875rem", flexShrink: 0 }}>
            {bannerConfig.icon}
          </span>
          <span style={{ flex: 1 }}>{bannerConfig.message}</span>
          {isError && (
            <span style={{ fontSize: "0.6875rem", color: COLORS.mutedForeground }}>
              ws://{agent.id}:{agent.port}
            </span>
          )}
        </div>
      )}

      {/* ─── Messages ───────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          position: "relative",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              color: COLORS.mutedForeground,
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: "2.5rem", opacity: 0.6 }}>{agent.icon}</span>
            <div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "4px" }}>
                {isConnected ? "Ready to chat" : "Awaiting connection"}
              </div>
              <span style={{ fontSize: "0.8125rem" }}>
                {isConnected
                  ? `Send a message to start talking with ${agent.name}`
                  : `${agent.name} will be available once connected`}
              </span>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                showTimestamp={
                  i === 0 ||
                  new Date(messages[i - 1].timestamp).getTime() +
                    5 * 60 * 1000 < new Date(msg.timestamp).getTime()
                }
              />
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "10px 14px",
                    borderRadius: "12px 12px 12px 2px",
                    backgroundColor: COLORS.secondary,
                  }}
                >
                  <TypingDot delay={0} />
                  <TypingDot delay={150} />
                  <TypingDot delay={300} />
                </div>
              </div>
            )}

            {/* Tool call indicator — shows when agent is executing a tool */}
            {isTyping && lastToolCall && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  fontSize: "0.75rem",
                  color: COLORS.mutedForeground,
                  backgroundColor: COLORS.secondary,
                  borderRadius: RADIUS.md,
                  alignSelf: "flex-start",
                  marginLeft: "4px",
                }}
              >
                <StatusDot
                  variant={
                    lastToolCall.status === "done"
                      ? "success"
                      : lastToolCall.status === "error"
                        ? "error"
                        : "warning"
                  }
                  pulse={lastToolCall.status === "running"}
                  size={6}
                />
                <span>
                  {lastToolCall.status === "running"
                    ? `Calling ${lastToolCall.name}…`
                    : lastToolCall.status === "done"
                      ? `${lastToolCall.name} completed`
                      : `${lastToolCall.name} failed`}
                </span>
              </div>
            )}

            {/* Scroll to bottom button */}
            {showScrollButton && (
              <button
                onClick={() => scrollToBottom()}
                style={{
                  position: "sticky",
                  bottom: "0",
                  alignSelf: "center",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                  cursor: "pointer",
                  color: COLORS.foreground,
                  zIndex: 1,
                }}
                aria-label="Scroll to latest"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* ─── Input ──────────────────────────────────────────── */}
      <form
        onSubmit={handleSubmit}
        style={{
          display: "flex",
          gap: "8px",
          padding: "12px 16px",
          borderTop: `1px solid ${COLORS.border}`,
        }}
      >
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={isConnected ? `Message ${agent.name}…` : isConnecting ? "Connecting…" : "Connect to send messages"}
          disabled={!isConnected}
          style={{
            flex: 1,
            height: "40px",
            padding: "0 12px",
            borderRadius: RADIUS.md,
            border: `1px solid ${COLORS.border}`,
            backgroundColor: COLORS.background,
            color: COLORS.foreground,
            fontSize: "0.875rem",
            outline: "none",
            opacity: !isConnected ? 0.5 : 1,
          }}
        />
        <Button type="submit" variant="primary" disabled={!isConnected || !input.trim()}>
          Send
        </Button>
      </form>
    </Card>
  );
};

// ─── Typing Dot ──────────────────────────────────────────────────

const TypingDot: React.FC<{ delay: number }> = ({ delay }) => (
  <span
    style={{
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      backgroundColor: COLORS.mutedForeground,
      animation: "typingPulse 1.4s infinite ease-in-out",
      animationDelay: `${delay}ms`,
    }}
  />
);

// ─── Message Bubble ──────────────────────────────────────────────

const MessageBubble: React.FC<{ message: ChatMessage; showTimestamp?: boolean }> = ({
  message,
  showTimestamp = false,
}) => {
  const isUser = message.role === "user";
  const time = React.useMemo(() => {
    try {
      return new Date(message.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [message.timestamp]);

  return (
    <div>
      {/* Timestamp separator */}
      {showTimestamp && time && (
        <div
          style={{
            textAlign: "center",
            fontSize: "0.6875rem",
            color: COLORS.mutedForeground,
            margin: "8px 0 4px",
          }}
        >
          {time}
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: isUser ? "flex-end" : "flex-start",
        }}
      >
        <div
          style={{
            maxWidth: "70%",
            padding: "8px 14px",
            borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            backgroundColor: isUser ? COLORS.primary : COLORS.secondary,
            color: isUser ? COLORS.primaryForeground : COLORS.foreground,
            fontSize: "0.875rem",
            lineHeight: 1.5,
            wordBreak: "break-word",
          }}
        >
          {message.content}
          {!isUser && time && (
            <div
              style={{
                fontSize: "0.625rem",
                color: COLORS.mutedForeground,
                marginTop: "4px",
                textAlign: "right",
                opacity: 0.7,
              }}
            >
              {time}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Monitor Tab ─────────────────────────────────────────────────

const AgentMonitorTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = ({
  agent,
}) => {
  const { status, latencyMs } = useAgentHealth(agent);
  const { messages, reconnectAttempts, agentState, agentIdentity, lastToolCall } =
    useAgentConnection(agent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Metrics */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard label="Status" value={AGENT_STATUS_LABELS[status]} />
        <MetricCard label="Latency" value={latencyMs !== null ? `${latencyMs}ms` : "—"} />
        <MetricCard label="Messages" value={messages.length} />
        <MetricCard label="Reconnects" value={reconnectAttempts} />
      </div>

      {/* Agent Identity + Last Tool Call */}
      {(agentIdentity || lastToolCall) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "16px",
          }}
        >
          {agentIdentity && (agentIdentity.id || agentIdentity.name) && (
            <Card padding="md">
              <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.04em", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Agent Identity
              </div>
              {agentIdentity.name && (
                <div style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground }}>
                  {agentIdentity.name}
                </div>
              )}
              {agentIdentity.id && (
                <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)" }}>
                  {agentIdentity.id}
                </div>
              )}
            </Card>
          )}
          {lastToolCall && (
            <Card padding="md">
              <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.04em", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Last Tool Call
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <StatusDot
                  variant={
                    lastToolCall.status === "done"
                      ? "success"
                      : lastToolCall.status === "error"
                        ? "error"
                        : "warning"
                  }
                  pulse={lastToolCall.status === "running"}
                />
                <span style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground, fontFamily: "var(--font-mono)" }}>
                  {lastToolCall.name}
                </span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Live Agent State from WS sync */}
      <Card>
        <Card.Header
          title="Agent State"
          subtitle={
            agentState
              ? "Live Durable Object state synced via WebSocket"
              : "No state synced yet — connect via chat to see live DO state"
          }
        />
        <CodeBlock
          code={JSON.stringify(
            agentState ?? {
              agentId: agent.id,
              note: "State will appear here once the agent pushes cf_agent_state messages.",
              messageCount: messages.length,
              lastMessages: messages.slice(-5).map((m) => ({
                role: m.role,
                content: m.content.slice(0, 100),
                timestamp: m.timestamp,
              })),
            },
            null,
            2,
          )}
          language="json"
          title="agent-state.json"
          showLineNumbers
        />
      </Card>
    </div>
  );
};

// ─── Config Tab ──────────────────────────────────────────────────

const AgentConfigTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = ({
  agent,
}) => {
  const { info, loading, refetch } = useAgentInfo(agent);

  return (
    <Card>
      <Card.Header
        title="Configuration"
        subtitle="Agent settings and model parameters"
        actions={
          <Button variant="secondary" size="sm" onClick={refetch} loading={loading}>
            Refresh
          </Button>
        }
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <ConfigRow label="Agent ID" value={agent.id} />
        <ConfigRow label="Kind" value={agent.kind} />
        <ConfigRow label="Port" value={String(agent.port)} />
        <ConfigRow label="WebSocket Path" value={agent.wsPath} />
        <ConfigRow label="Supports Chat" value={agent.supportsChat ? "Yes" : "No"} />
        <ConfigRow label="Has Cron" value={agent.hasCron ? "Yes" : "No"} />
        <ConfigRow label="Capabilities" value={agent.capabilities.join(", ") || "—"} />
      </div>

      {/* Deployment Info from live /health endpoint */}
      <div style={{ marginTop: "24px" }}>
        <h4 style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
          Deployment Info
        </h4>
        {loading ? (
          <div style={{ padding: "12px 0" }}>
            <LoadingState message="Fetching deployment info…" />
          </div>
        ) : info ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <ConfigRow label="Model" value={info.model} />
            <ConfigRow label="Template ID" value={info.templateId} />
            <ConfigRow label="Deployment ID" value={info.deploymentId} />
            <ConfigRow label="Version" value={info.version} />
            <ConfigRow label="Available Agents" value={info.agents.join(", ") || "—"} />
          </div>
        ) : (
          <div style={{ padding: "12px 0", fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            Backend not reachable. Start the agent on port {agent.port} to see deployment info.
          </div>
        )}
      </div>

      <div style={{ marginTop: "24px" }}>
        <h4 style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
          Model Configuration
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <ConfigRow label="Model" value={info?.model ?? "— (not configured)"} />
          <ConfigRow label="Temperature" value="0.7" />
          <ConfigRow label="Max Tokens" value="4096" />
          <ConfigRow label="Streaming" value="Enabled" />
        </div>
      </div>
    </Card>
  );
};

const ConfigRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: `1px solid ${COLORS.border}`,
    }}
  >
    <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>{label}</span>
    <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, fontFamily: "var(--font-mono)" }}>
      {value}
    </span>
  </div>
);

// ─── Schedules Tab ───────────────────────────────────────────────

const AgentSchedulesTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = ({
  agent,
}) => {
  if (!agent.hasCron) {
    return (
      <EmptyState
        icon="🕐"
        title="No Schedules"
        message="This agent does not have any cron schedules configured."
      />
    );
  }

  const cronCap = agent.capabilities.find((c) => c.startsWith("cron:"));

  return (
    <Card>
      <Card.Header
        title="Cron Schedules"
        subtitle="Scheduled task execution for this agent"
        actions={<Button variant="primary" size="sm">+ Add Schedule</Button>}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Schedule", "Status", "Last Run", "Next Run", "Actions"].map((h) => (
              <th
                key={h}
                style={{
                  height: "44px",
                  padding: "0 16px",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: COLORS.mutedForeground,
                  textAlign: "left",
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "48px" }}>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>
              {cronCap?.replace("cron:", "") ?? "—"}
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
              <Badge variant="success" dot>Active</Badge>
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
              —
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
              —
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
              <Button variant="ghost" size="sm">Edit</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
};

// ─── Storage Tab ─────────────────────────────────────────────────

const AgentStorageTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = () => (
  <Card>
    <Card.Header
      title="Storage"
      subtitle="Durable Object storage and bindings"
    />
    <EmptyState
      icon="📦"
      title="No Storage Bindings"
      message="This agent does not have any KV namespaces or Durable Object bindings configured."
      action={{ label: "Add Binding", onClick: () => {} }}
    />
  </Card>
);

// ─── Logs Tab ────────────────────────────────────────────────────

const AgentLogsTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = ({
  agent,
}) => (
  <Card>
    <Card.Header
      title="Logs"
      subtitle={`Recent log entries for ${agent.name}`}
    />
    <EmptyState
      icon="📋"
      title="No Logs Available"
      message="Agent logs are not streamed to this console. In production, connect a logging backend (e.g. Cloudflare Workers Analytics, Logpush) to view real-time log output here."
    />
  </Card>
);

// ─── Traces Tab ──────────────────────────────────────────────────

const AgentTracesTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = () => (
  <Card>
    <Card.Header
      title="Traces"
      subtitle="Execution traces and spans"
    />
    <EmptyState
      icon="🔍"
      title="No Traces Available"
      message="Enable tracing in your agent configuration to see execution spans here."
    />
  </Card>
);

// ─── Versions Tab ────────────────────────────────────────────────

const AgentVersionsTab: React.FC<{ agent: NonNullable<ReturnType<typeof getAgentById>> }> = () => (
  <Card>
    <Card.Header
      title="Version History"
      subtitle="Deployment history and rollback points"
    />
    <EmptyState
      icon="🏷️"
      title="No Version History"
      message="Deployment versions are managed by Wrangler and your CI/CD pipeline, not by this console. Use `wrangler deployments list` or check your Git history for deployment records."
    />
  </Card>
);
