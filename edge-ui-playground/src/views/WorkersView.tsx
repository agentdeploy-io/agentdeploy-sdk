/**
 * WorkersView Component
 * ──────────────────────
 * Workers & Deployments view showing deployed agent backends,
 * their status, and resource usage.
 *
 * Data sources:
 *   - AGENTS registry (static — defines which workers exist)
 *   - useAgentHealth (live — polls /health for each worker)
 *   - useAgentInfo (live — fetches deployment ID, version, template)
 *
 * Happy path: workers are running, health checks pass, metrics show real data.
 * Sad path: workers are down, shows error status, graceful empty states.
 *
 * Layout (from edge.pen mockup LaeNe):
 *   ┌─────────────────────────────────────────────┐
 *   │ "Workers & Deployments" + "Deploy" button   │
 *   ├──────────┬──────────┬──────────┬────────────┤
 *   │ Worker Table: Name | Status | Port | ...    │
 *   ├──────────────────────────────────────────────┤
 *   │ Deployment Info (from /health)              │
 *   └──────────────────────────────────────────────┘
 */

import React from "react";
import { Card, Badge, Button, MetricCard, Table } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import { AGENTS, getAgentById } from "../constants/agents";
import { useAgentHealth } from "../hooks/useAgentHealth";
import { useAgentInfo } from "../hooks/useAgentInfo";
import type { AgentRegistryEntry } from "../constants/agents";
import type { AgentConnectionStatus } from "../types/agent";
import type { TableColumn } from "../types/ui";

// ─── Props ───────────────────────────────────────────────────────

export interface WorkersViewProps {}

// ─── Worker Row Type (derived from agent + health + info) ────────

interface WorkerRow {
  id: string;
  name: string;
  port: number;
  status: AgentConnectionStatus;
  latencyMs: number | null;
  model: string | null;
  deploymentId: string | null;
  version: string | null;
  templateId: string | null;
}

// ─── Worker Card (renders one agent as a worker row) ─────────────

const WorkerRowRenderer: React.FC<{
  agent: AgentRegistryEntry;
  onReport: (row: WorkerRow) => void;
}> = ({ agent, onReport }) => {
  const { status, latencyMs } = useAgentHealth(agent);
  const { info } = useAgentInfo(agent);

  React.useEffect(() => {
    onReport({
      id: agent.id,
      name: agent.name,
      port: agent.port,
      status,
      latencyMs,
      model: info?.model ?? null,
      deploymentId: info?.deploymentId ?? null,
      version: info?.version ?? null,
      templateId: info?.templateId ?? null,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, latencyMs, info, agent.id, agent.name, agent.port]);

  return null;
};

// ─── Component ───────────────────────────────────────────────────

export const WorkersView: React.FC<WorkersViewProps> = () => {
  const [workerRows, setWorkerRows] = React.useState<WorkerRow[]>([]);

  const handleReport = React.useCallback((row: WorkerRow) => {
    setWorkerRows((prev) => {
      const idx = prev.findIndex((r) => r.id === row.id);
      if (idx >= 0) {
        const updated = [...prev];
        updated[idx] = row;
        return updated;
      }
      return [...prev, row];
    });
  }, []);

  // Compute aggregate metrics
  const activeWorkers = workerRows.filter((w) => w.status === "connected").length;
  const errorWorkers = workerRows.filter(
    (w) => w.status === "error" || w.status === "degraded",
  ).length;
  const avgLatency = (() => {
    const latencies = workerRows
      .map((w) => w.latencyMs)
      .filter((l): l is number => l !== null);
    if (latencies.length === 0) return null;
    return Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length);
  })();

  const workerColumns: TableColumn<WorkerRow>[] = [
    {
      key: "name",
      label: "Worker",
      render: (value: unknown, row: WorkerRow) => {
        const agent = getAgentById(row.id);
        return (
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "1.125rem" }}>{agent?.icon ?? "🔧"}</span>
            <div>
              <div style={{ fontWeight: 500 }}>{value as string}</div>
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                {row.id}
              </div>
            </div>
          </div>
        );
      },
    },
    {
      key: "status",
      label: "Status",
      render: (value: unknown) => {
        const status = value as AgentConnectionStatus;
        const variant =
          status === "connected"
            ? ("success" as const)
            : status === "error"
              ? ("error" as const)
              : status === "degraded"
                ? ("warning" as const)
                : ("neutral" as const);
        return (
          <Badge variant={variant} dot>
            {status.charAt(0).toUpperCase() + status.slice(1)}
          </Badge>
        );
      },
    },
    {
      key: "port",
      label: "Port",
      render: (value: unknown) => (
        <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>
          :{value as number}
        </span>
      ),
    },
    {
      key: "latencyMs",
      label: "Latency",
      align: "right",
      render: (value: unknown) => {
        const ms = value as number | null;
        if (ms === null) return <span style={{ color: COLORS.mutedForeground }}>—</span>;
        const color = ms < 200 ? STATUS_COLORS.success : ms < 500 ? STATUS_COLORS.warning : STATUS_COLORS.error;
        return (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem", color }}>
            {ms}ms
          </span>
        );
      },
    },
    {
      key: "model",
      label: "Model",
      render: (value: unknown) =>
        value ? (
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.75rem", color: COLORS.mutedForeground }}>
            {value as string}
          </span>
        ) : (
          <span style={{ color: COLORS.mutedForeground }}>—</span>
        ),
    },
    {
      key: "version",
      label: "Version",
      render: (value: unknown) =>
        value ? (
          <Badge variant="info">v{value as string}</Badge>
        ) : (
          <span style={{ color: COLORS.mutedForeground }}>—</span>
        ),
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* Invisible worker data reporters */}
      {AGENTS.map((agent) => (
        <WorkerRowRenderer key={agent.id} agent={agent} onReport={handleReport} />
      ))}

      {/* ─── Header ───────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
            Workers & Deployments
          </h1>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
            Agent backends running on local wrangler dev servers
          </p>
        </div>
      </div>

      {/* ─── Metrics ─────────────────────────────────────────── */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard
          label="Active Workers"
          value={`${activeWorkers}/${AGENTS.length}`}
          change={
            activeWorkers === AGENTS.length
              ? "All running"
              : `${AGENTS.length - activeWorkers} down`
          }
          changeDirection={activeWorkers === AGENTS.length ? "up" : "down"}
        />
        <MetricCard
          label="Avg Latency"
          value={avgLatency !== null ? `${avgLatency}ms` : "—"}
          change={avgLatency !== null && avgLatency < 300 ? "Good" : "Slow"}
          changeDirection={avgLatency !== null && avgLatency < 300 ? "up" : "down"}
        />
        <MetricCard
          label="Errors"
          value={errorWorkers}
          change={errorWorkers === 0 ? "No errors" : `${errorWorkers} unhealthy`}
          changeDirection={errorWorkers === 0 ? "up" : "down"}
        />
        <MetricCard
          label="Total Agents"
          value={AGENTS.length}
          change="Registered"
          changeDirection="neutral"
        />
      </div>

      {/* ─── Workers Table ───────────────────────────────────── */}
      <Card padding="none">
        <div style={{ padding: "20px 20px 0" }}>
          <Card.Header title="Agent Backends" subtitle="Live status of all registered agent workers" />
        </div>
        <Table
          columns={workerColumns}
          data={workerRows}
          rowKey={(w) => w.id}
          emptyState={{
            icon: "🔧",
            title: "No Agent Backends",
            message: "No agents are registered. Add agents to the registry to monitor them here.",
          }}
        />
      </Card>

      {/* ─── Deployment Info ─────────────────────────────────── */}
      <Card>
        <Card.Header
          title="Deployment Details"
          subtitle="Per-agent deployment metadata from /health endpoint"
        />
        {workerRows.length === 0 ? (
          <EmptyState
            icon="📡"
            title="No Deployment Data"
            message="Start agent backends to see deployment IDs, template IDs, and versions."
          />
        ) : (
          <div style={{ display: "flex", flexDirection: "column" }}>
            {workerRows.map((row, i) => (
              <div
                key={row.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "12px",
                  padding: "10px 0",
                  borderBottom: i < workerRows.length - 1 ? `1px solid ${COLORS.border}` : "none",
                }}
              >
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
                    {row.name}
                  </div>
                  <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)" }}>
                    {row.deploymentId ?? "—"}
                  </div>
                </div>
                {row.templateId && (
                  <Badge variant="neutral">template:{row.templateId}</Badge>
                )}
                {row.version && (
                  <Badge variant="success">v{row.version}</Badge>
                )}
                <Badge
                  variant={
                    row.status === "connected"
                      ? "success"
                      : row.status === "error"
                        ? "error"
                        : "neutral"
                  }
                >
                  {row.status}
                </Badge>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};
