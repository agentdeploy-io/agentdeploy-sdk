/**
 * ObservabilityView Component
 * ───────────────────────────
 * Traces, logs, metrics, and error tracking across all agents.
 *
 * Features:
 *   - Real latency metrics from health checks (p50, p95, error rate)
 *   - Trace timeline with spans (placeholder until tracing API available)
 *   - Log stream (placeholder until log streaming available)
 *   - Filter by agent, time range, level
 *   - Graceful degradation: shows real health data even without tracing
 *
 * Happy path: agents are reachable, health checks succeed, latency is low.
 * Sad path: agents are down, latency is high, errors are visible.
 */

import React from "react";
import { Card, Badge, Button, MetricCard, Tabs } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import { AGENTS, getAgentById } from "../constants/agents";
import { useAgentHealth } from "../hooks/useAgentHealth";
import type { AgentRegistryEntry } from "../constants/agents";

// ─── Props ───────────────────────────────────────────────────────

export interface ObservabilityViewProps {}

// ─── Health Reporter (invisible, feeds metrics) ──────────────────

const HealthMetricReporter: React.FC<{
  agent: AgentRegistryEntry;
  onReport: (agentId: string, status: string, latencyMs: number | null) => void;
}> = ({ agent, onReport }) => {
  const { status, latencyMs } = useAgentHealth(agent);

  React.useEffect(() => {
    onReport(agent.id, status, latencyMs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, latencyMs, agent.id]);

  return null;
};

// ─── Component ───────────────────────────────────────────────────

export const ObservabilityView: React.FC<ObservabilityViewProps> = () => {
  const [tab, setTab] = React.useState("traces");

  // Aggregate health data from all agents
  const [healthMap, setHealthMap] = React.useState<
    Record<string, { status: string; latencyMs: number | null }>
  >({});

  const handleHealthReport = React.useCallback(
    (agentId: string, status: string, latencyMs: number | null) => {
      setHealthMap((prev) => ({ ...prev, [agentId]: { status, latencyMs } }));
    },
    [],
  );

  // Compute real metrics from health data
  const healthValues = Object.values(healthMap);
  const totalAgents = AGENTS.length;
  const reportedAgents = healthValues.length;
  const healthyAgents = healthValues.filter((h) => h.status === "connected").length;
  const errorAgents = healthValues.filter(
    (h) => h.status === "error" || h.status === "degraded",
  ).length;

  const latencies = healthValues
    .map((h) => h.latencyMs)
    .filter((l): l is number => l !== null)
    .sort((a, b) => a - b);

  // Calculate percentiles from real latency data
  const percentile = (arr: number[], p: number): number | null => {
    if (arr.length === 0) return null;
    const idx = Math.ceil((p / 100) * arr.length) - 1;
    return arr[Math.max(0, idx)];
  };

  const p50 = percentile(latencies, 50);
  const p95 = percentile(latencies, 95);
  const errorRate = reportedAgents > 0 ? (errorAgents / reportedAgents) * 100 : 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* Invisible health reporters */}
      {AGENTS.map((agent) => (
        <HealthMetricReporter key={agent.id} agent={agent} onReport={handleHealthReport} />
      ))}

      {/* ─── Header ───────────────────────────────────────────── */}
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
          Observability
        </h1>
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          Real-time health metrics, traces, and logs across all agents
        </p>
      </div>

      {/* ─── Metrics (from live health checks) ──────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard
          label="Agent Health"
          value={`${healthyAgents}/${totalAgents}`}
          change={
            healthyAgents === totalAgents
              ? "All healthy"
              : `${totalAgents - healthyAgents} unhealthy`
          }
          changeDirection={healthyAgents === totalAgents ? "up" : "down"}
        />
        <MetricCard
          label="Error Rate"
          value={`${errorRate.toFixed(1)}%`}
          change={errorRate === 0 ? "No errors" : `${errorAgents} agents degraded`}
          changeDirection={errorRate === 0 ? "up" : "down"}
        />
        <MetricCard
          label="P50 Latency"
          value={p50 !== null ? `${p50}ms` : "—"}
          change={p50 !== null && p50 < 300 ? "Good" : p50 !== null ? "Slow" : "No data"}
          changeDirection={p50 !== null && p50 < 300 ? "up" : "down"}
        />
        <MetricCard
          label="P95 Latency"
          value={p95 !== null ? `${p95}ms` : "—"}
          change={p95 !== null && p95 < 500 ? "Good" : p95 !== null ? "Slow" : "No data"}
          changeDirection={p95 !== null && p95 < 500 ? "up" : "down"}
        />
      </div>

      {/* ─── Tabs ─────────────────────────────────────────────── */}
      <Tabs
        tabs={[
          { id: "traces", label: "Traces" },
          { id: "logs", label: "Logs" },
          { id: "errors", label: "Errors" },
          { id: "health", label: "Health" },
        ]}
        activeTab={tab}
        onChange={setTab}
        variant="pills"
      />

      {/* ─── Content ─────────────────────────────────────────── */}
      {tab === "traces" && <TracesContent />}
      {tab === "logs" && <LogsContent />}
      {tab === "errors" && <ErrorsContent errorAgents={errorAgents} healthMap={healthMap} />}
      {tab === "health" && <HealthContent healthMap={healthMap} />}
    </div>
  );
};

// ─── Traces Content ──────────────────────────────────────────────

const TracesContent: React.FC = () => (
  <Card>
    <Card.Header
      title="Recent Traces"
      subtitle="Execution traces from all agents"
    />
    <EmptyState
      icon="🔍"
      title="Tracing Not Available"
      message="Distributed tracing requires a tracing backend (e.g., Workers Analytics, Datadog, or Jaeger). Once configured, execution traces and spans will appear here."
      action={{ label: "Learn More", onClick: () => {} }}
    />
  </Card>
);

// ─── Logs Content ────────────────────────────────────────────────

const LogsContent: React.FC = () => (
  <Card>
    <Card.Header
      title="Log Stream"
      subtitle="Real-time logs from all agents"
    />
    <EmptyState
      icon="📋"
      title="Log Streaming Not Available"
      message="Real-time log streaming requires a log ingestion backend (e.g., Workers Analytics Engine or Logpush). Once configured, live logs from your agents will stream here."
      action={{ label: "Learn More", onClick: () => {} }}
    />
  </Card>
);

// ─── Errors Content ──────────────────────────────────────────────

const ErrorsContent: React.FC<{
  errorAgents: number;
  healthMap: Record<string, { status: string; latencyMs: number | null }>;
}> = ({ errorAgents, healthMap }) => {
  if (errorAgents === 0) {
    return (
      <Card>
        <Card.Header title="Error Tracking" subtitle="Aggregated errors across all agents" />
        <EmptyState
          icon="✅"
          title="All Agents Healthy"
          message="No agents are currently in an error or degraded state. Issues will be tracked and displayed here when they occur."
        />
      </Card>
    );
  }

  // Show agents that are in error/degraded state
  const unhealthyAgents = Object.entries(healthMap)
    .filter(([, h]) => h.status === "error" || h.status === "degraded")
    .map(([id, h]) => ({ agent: getAgentById(id), status: h.status }));

  return (
    <Card padding="none">
      <div style={{ padding: "20px 20px 0" }}>
        <Card.Header
          title="Unhealthy Agents"
          subtitle={`${errorAgents} agent${errorAgents > 1 ? "s" : ""} currently in error or degraded state`}
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {unhealthyAgents.map(({ agent, status }, i) => (
          <div
            key={agent?.id ?? i}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "12px 20px",
              borderBottom: i < unhealthyAgents.length - 1 ? `1px solid ${COLORS.border}` : "none",
            }}
          >
            <span style={{ fontSize: "1.25rem" }}>{agent?.icon ?? "🤖"}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
                {agent?.name ?? "Unknown Agent"}
              </div>
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                {agent?.id} · port:{agent?.port}
              </div>
            </div>
            <Badge variant={status === "error" ? "error" : "warning"} dot>
              {status === "error" ? "Error" : "Degraded"}
            </Badge>
          </div>
        ))}
      </div>
    </Card>
  );
};

// ─── Health Content (new tab — shows per-agent health breakdown) ──

const HealthContent: React.FC<{
  healthMap: Record<string, { status: string; latencyMs: number | null }>;
}> = ({ healthMap }) => (
  <Card padding="none">
    <div style={{ padding: "20px 20px 0" }}>
      <Card.Header
        title="Agent Health Breakdown"
        subtitle="Real-time health check status for all registered agents"
      />
    </div>
    <div style={{ display: "flex", flexDirection: "column" }}>
      {AGENTS.map((agent, i) => {
        const health = healthMap[agent.id];
        const status = health?.status ?? "unknown";
        const latency = health?.latencyMs ?? null;

        return (
          <div
            key={agent.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "12px",
              padding: "12px 20px",
              borderBottom: i < AGENTS.length - 1 ? `1px solid ${COLORS.border}` : "none",
            }}
          >
            <span style={{ fontSize: "1.25rem" }}>{agent.icon}</span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
                {agent.name}
              </div>
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                {agent.id} · port:{agent.port}
              </div>
            </div>
            <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)", width: "70px", textAlign: "right" }}>
              {latency !== null ? `${latency}ms` : "—"}
            </span>
            <Badge
              variant={
                status === "connected"
                  ? "success"
                  : status === "error"
                    ? "error"
                    : status === "degraded"
                      ? "warning"
                      : "neutral"
              }
              dot
            >
              {status.charAt(0).toUpperCase() + status.slice(1)}
            </Badge>
          </div>
        );
      })}
    </div>
  </Card>
);
