/**
 * OverviewView Component
 * ──────────────────────
 * Dashboard showing high-level metrics across all agents.
 * This is the landing page when you open the console.
 *
 * Layout (from edge.pen mockup Jp18o):
 *   ┌─────────────────────────────────────────────┐
 *   │ Welcome header + "View Agents" button       │
 *   ├──────────┬──────────┬──────────┬────────────┤
 *   │ Active   │ Total    │ Convos   │ Avg Resp   │
 *   │ Agents   │ Messages │ Today    │ Time       │
 *   ├──────────┴──────────┴──────────┴────────────┤
 *   │ Agent Status Table                          │
 *   │ (name, status, last active, actions)        │
 *   ├─────────────────────────────────────────────┤
 *   │ Recent Activity Feed                        │
 *   └─────────────────────────────────────────────┘
 */

import React from "react";
import { Card, MetricCard, Button, Badge, StatusDot, Table } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import { AGENTS, AGENT_STATUS_LABELS, AGENT_STATUS_BADGE_VARIANT } from "../constants/agents";
import { useAgentHealth } from "../hooks/useAgentHealth";
import { useAgentInfo } from "../hooks/useAgentInfo";
import type { AgentRegistryEntry } from "../constants/agents";
import type { AgentConnectionStatus } from "../types/agent";
import type { TableColumn } from "../types/ui";

// ─── Props ───────────────────────────────────────────────────────

export interface OverviewViewProps {
  onNavigateAgents: () => void;
  onNavigateAgent: (agentId: string) => void;
}

// ─── Agent Status Row (uses health check hook) ───────────────────

const AgentStatusRow: React.FC<{
  agent: AgentRegistryEntry;
  onClick: () => void;
}> = ({ agent, onClick }) => {
  const { status, latencyMs, lastChecked } = useAgentHealth(agent);
  const { info } = useAgentInfo(agent);

  return (
    <tr
      onClick={onClick}
      style={{ height: "48px", cursor: "pointer", transition: "background-color 100ms ease" }}
      onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.cardHover)}
      onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
    >
      <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
        <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
          <span style={{ fontSize: "1.25rem" }}>{agent.icon}</span>
          <div>
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
              {agent.name}
            </div>
            <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
              {agent.kind}
            </div>
          </div>
        </div>
      </td>
      <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
        <Badge variant={AGENT_STATUS_BADGE_VARIANT[status]} dot>
          {AGENT_STATUS_LABELS[status]}
        </Badge>
      </td>
      <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        {info ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}>{info.model}</span>
        ) : (
          "—"
        )}
      </td>
      <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        {latencyMs !== null ? `${latencyMs}ms` : "—"}
      </td>
      <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        {lastChecked ? new Date(lastChecked).toLocaleTimeString() : "Never"}
      </td>
    </tr>
  );
};

// ─── Health Aggregator (computes real metrics from all agents) ───

/**
 * Tracks health status of a single agent and reports changes to parent.
 * Renders as null (invisible) — only used for its hook side effects.
 */
const HealthReporter: React.FC<{
  agent: AgentRegistryEntry;
  onReport: (agentId: string, healthy: boolean, latency: number | null) => void;
}> = ({ agent, onReport }) => {
  const { status, latencyMs } = useAgentHealth(agent);

  React.useEffect(() => {
    onReport(agent.id, status === "connected", latencyMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, latencyMs, agent.id]);

  return null;
};

// ─── Main View ───────────────────────────────────────────────────

export const OverviewView: React.FC<OverviewViewProps> = ({ onNavigateAgents, onNavigateAgent }) => {
  // Map of agentId → { healthy, latencyMs }
  const [healthMap, setHealthMap] = React.useState<
    Record<string, { healthy: boolean; latencyMs: number | null }>
  >({});

  const handleHealthReport = React.useCallback(
    (agentId: string, healthy: boolean, latencyMs: number | null) => {
      setHealthMap((prev) => ({
        ...prev,
        [agentId]: { healthy, latencyMs },
      }));
    },
    [],
  );

  // Compute aggregate metrics from the health map
  const healthValues = Object.values(healthMap);
  const healthyAgents = healthValues.filter((h) => h.healthy).length;
  const latencies = healthValues
    .map((h) => h.latencyMs)
    .filter((l): l is number => l !== null);
  const avgLatency = latencies.length > 0
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* Invisible health reporters — aggregate metrics for the cards */}
      {AGENTS.map((agent) => (
        <HealthReporter key={agent.id} agent={agent} onReport={handleHealthReport} />
      ))}

      {/* ─── Header ───────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
            Welcome back
          </h1>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
            Monitor and manage your Cloudflare Agents in real-time.
          </p>
        </div>
        <Button variant="primary" onClick={onNavigateAgents}>
          View All Agents
        </Button>
      </div>

      {/* ─── Metrics Grid ─────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard
          label="Active Agents"
          value={`${healthyAgents}/${AGENTS.length}`}
          change={healthyAgents === AGENTS.length ? "All operational" : `${AGENTS.length - healthyAgents} offline`}
          changeDirection={healthyAgents === AGENTS.length ? "up" : "down"}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="8" width="16" height="12" rx="2" />
              <path d="M12 2v6" />
            </svg>
          }
        />
        <MetricCard
          label="Total Messages"
          value="—"
          change="Requires analytics backend"
          changeDirection="neutral"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          }
        />
        <MetricCard
          label="Conversations Today"
          value="—"
          change="Requires analytics backend"
          changeDirection="neutral"
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
              <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
            </svg>
          }
        />
        <MetricCard
          label="Avg Response Time"
          value={avgLatency !== null ? `${avgLatency}ms` : "—"}
          change={avgLatency !== null && avgLatency < 300 ? "Good" : "Slow"}
          changeDirection={avgLatency !== null && avgLatency < 300 ? "up" : "down"}
          icon={
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
            </svg>
          }
        />
      </div>

      {/* ─── Agent Status Table ──────────────────────────────── */}
      <Card padding="none">
        <Card.Header
          title="Agent Status"
          subtitle="Real-time health of all deployed agents"
          actions={
            <Button variant="ghost" size="sm" onClick={onNavigateAgents}>
              View All →
            </Button>
          }
          style={{ padding: "20px 20px 0" }}
        />
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: "4px" }}>
          <thead>
            <tr>
              {["Agent", "Status", "Model", "Latency", "Last Checked"].map((header) => (
                <th
                  key={header}
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
                  {header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {AGENTS.map((agent) => (
              <AgentStatusRow
                key={agent.id}
                agent={agent}
                onClick={() => onNavigateAgent(agent.id)}
              />
            ))}
          </tbody>
        </table>
      </Card>

      {/* ─── Recent Activity ─────────────────────────────────── */}
      <Card>
        <Card.Header
          title="Recent Activity"
          subtitle="Latest events across all agents"
        />
        <EmptyState
          icon="📡"
          title="No Activity Feed Available"
          message="This playground doesn't connect to an analytics or event-logging backend. In production, agent activity (messages sent, tools called, errors) would appear here in real-time."
        />
      </Card>
    </div>
  );
};
