import React, { useState, useEffect } from "react";
import { Card, Badge, MetricCard } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";
import { DeploymentSelector } from "../components/DeploymentSelector";
import { COLORS, RADIUS, STATUS_COLORS, TRANSITIONS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";
import { useWire } from "../hooks/useDataApi";
import { WireDiagram } from "../components/WireDiagram";
import type { WireAgent, WireConnection } from "../components/WireDiagram";

// ─── Fallback Mock Data (used when no deployment selected or API fails) ───

const now = Date.now();

const FALLBACK_AGENTS: WireAgent[] = [
  { id: "supervisor", name: "Supervisor", icon: "👑", runtime: "edge", health: "healthy", state: "working", lastHeartbeat: now - 2000, costToday: 0.0234, group: "orchestrator" },
  { id: "qualifier", name: "Qualifier", icon: "🎯", runtime: "edge", health: "healthy", state: "idle", lastHeartbeat: now - 5000, costToday: 0.0112, group: "orchestrator" },
  { id: "researcher", name: "Researcher", icon: "🔍", runtime: "edge", health: "healthy", state: "working", lastHeartbeat: now - 1000, costToday: 0.0456, group: "orchestrator" },
  { id: "writer", name: "Writer", icon: "✍️", runtime: "edge", health: "degraded", state: "idle", lastHeartbeat: now - 12000, costToday: 0.0089, group: "orchestrator" },
  { id: "outreach", name: "Outreach", icon: "📤", runtime: "edge", health: "healthy", state: "idle", lastHeartbeat: now - 8000, costToday: 0.0067, group: "orchestrator" },
  { id: "core-crawler", name: "Core Crawler", icon: "🕷️", runtime: "core", health: "healthy", state: "working", lastHeartbeat: now - 3000, costToday: 0.1234, group: "core" },
  { id: "jev-classifier", name: "jev Classifier", icon: "🏷️", runtime: "cf-worker", health: "healthy", state: "working", lastHeartbeat: now - 1500, costToday: 0.0045, group: "classifier" },
];

const FALLBACK_CONNECTIONS: WireConnection[] = [
  { from: "supervisor", to: "core-crawler", label: "handoff", active: true },
  { from: "supervisor", to: "jev-classifier", label: "classify", active: true },
  { from: "core-crawler", to: "supervisor", label: "sync", active: true },
];

const FALLBACK_EVENTS = [
  { id: "1", time: now - 30000, type: "handoff", message: "Handoff started: lead-qualify-batch-42", duration: "2m 14s" },
  { id: "2", time: now - 25000, type: "sync", message: "Batch 1/5 synced (12 records)", duration: "0.8s" },
  { id: "3", time: now - 20000, type: "sync", message: "Batch 2/5 synced (15 records)", duration: "1.1s" },
  { id: "4", time: now - 15000, type: "classify", message: "Classification complete: 27 leads scored", duration: "3.2s" },
  { id: "5", time: now - 10000, type: "sync", message: "Batch 3/5 synced (18 records)", duration: "0.9s" },
];

// ─── Mapping helpers ────────────────────────────────────────────

function mapWireAgent(raw: Record<string, unknown>): WireAgent {
  return {
    id: String(raw.id ?? ""),
    name: String(raw.name ?? raw.id ?? ""),
    icon: String(raw.icon ?? "🤖"),
    runtime: (String(raw.runtime ?? "edge") as WireAgent["runtime"]),
    health: (String(raw.health ?? "healthy") as WireAgent["health"]),
    state: (String(raw.state ?? "idle") as WireAgent["state"]),
    lastHeartbeat: Number(raw.lastHeartbeat ?? Date.now()),
    costToday: Number(raw.costToday ?? 0),
    group: (String(raw.group ?? "orchestrator") as WireAgent["group"]),
  };
}

function mapWireConnection(raw: Record<string, unknown>): WireConnection {
  return {
    from: String(raw.from ?? ""),
    to: String(raw.to ?? ""),
    label: String(raw.label ?? ""),
    active: Boolean(raw.active ?? false),
  };
}

// ─── Component ─────────────────────────────────────────────────────

export const AgentWireView: React.FC = () => {
  const { deploymentId } = useDeploymentSelector();
  const { data, loading, error, refetch } = useWire(deploymentId);
  const [liveAgents, setLiveAgents] = useState<WireAgent[]>([]);

  const agents = data?.agents?.map(mapWireAgent) ?? (deploymentId ? [] : FALLBACK_AGENTS);
  const connections = data?.connections?.map(mapWireConnection) ?? (deploymentId ? [] : FALLBACK_CONNECTIONS);
  const events = data?.events ?? FALLBACK_EVENTS;

  useEffect(() => {
    setLiveAgents(agents);
  }, [agents]);

  useEffect(() => {
    if (liveAgents.length === 0) return;
    const interval = setInterval(() => {
      setLiveAgents((prev) =>
        prev.map((a) => ({
          ...a,
          lastHeartbeat: Date.now() - Math.random() * 5000,
        }))
      );
    }, 3000);
    return () => clearInterval(interval);
  }, [liveAgents.length]);

  const totalCost = liveAgents.reduce((sum, a) => sum + a.costToday, 0);
  const budgetRemaining = 5.0 - totalCost;

  if (!deploymentId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>Agent Wire</h1>
            <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>Multi-agent deployment topology and live task flow</p>
          </div>
          <DeploymentSelector />
        </div>
        <EmptyState icon="🔌" title="No deployment selected" message="Select a deployment above to view the agent wire topology." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
            Agent Wire
          </h1>
          <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
            Multi-agent deployment topology and live task flow
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <DeploymentSelector />
          <button
            onClick={refetch}
            style={{
              height: "34px",
              padding: "0 14px",
              borderRadius: RADIUS.md,
              border: `1px solid ${COLORS.border}`,
              backgroundColor: "transparent",
              color: COLORS.foreground,
              fontSize: "0.8125rem",
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <LoadingState variant="spinner" message="Loading wire topology..." height="300px" />
      ) : error ? (
        <Card>
          <div style={{ padding: "32px", textAlign: "center" }}>
            <p style={{ color: STATUS_COLORS.error, fontSize: "0.875rem", marginBottom: "12px" }}>{error}</p>
            <button
              onClick={refetch}
              style={{
                height: "34px",
                padding: "0 14px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: "transparent",
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                fontWeight: 500,
                cursor: "pointer",
              }}
            >
              Try Again
            </button>
          </div>
        </Card>
      ) : liveAgents.length === 0 ? (
        <EmptyState icon="🔌" title="No wire data" message="The edge worker hasn't reported any agent topology yet. Deploy the worker to see the wire diagram." />
      ) : (
        <>
          {/* Cost Summary Bar */}
          <div
            style={{
              display: "flex",
              gap: "16px",
              padding: "16px 20px",
              borderRadius: RADIUS.lg,
              border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.card,
              flexWrap: "wrap",
            }}
          >
            <div style={{ flex: "1 1 200px" }}>
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Total Cost Today
              </div>
              <div style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground }}>
                ${totalCost.toFixed(4)}
              </div>
            </div>
            <div style={{ flex: "1 1 200px" }}>
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Budget Remaining
              </div>
              <div
                style={{
                  fontSize: "1.5rem",
                  fontWeight: 700,
                  color: budgetRemaining > 1 ? STATUS_COLORS.success : STATUS_COLORS.warning,
                }}
              >
                ${budgetRemaining.toFixed(2)}
              </div>
            </div>
            <div style={{ flex: "2 1 300px", display: "flex", gap: "12px", flexWrap: "wrap" }}>
              {liveAgents.slice(0, 4).map((a) => (
                <div key={a.id} style={{ fontSize: "0.75rem" }}>
                  <span style={{ color: COLORS.mutedForeground }}>{a.icon} {a.name}: </span>
                  <span style={{ fontFamily: "var(--font-mono)", color: COLORS.foreground }}>
                    ${a.costToday.toFixed(4)}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Wire Diagram */}
          <WireDiagram agents={liveAgents} connections={connections} />

          {/* Task Flow Panel */}
          <Card>
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div>
                <h2 style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
                  Active Handoff
                </h2>
                <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
                  {events.length > 0 ? events[0].message : "No active handoffs"}
                </p>
              </div>

              <div style={{ display: "flex", gap: "12px", flexWrap: "wrap" }}>
                <MetricCard label="Agents" value={String(liveAgents.length)} />
                <MetricCard label="Connections" value={String(connections.length)} />
                <MetricCard label="Total Cost" value={`$${totalCost.toFixed(4)}`} />
                <MetricCard label="Events" value={String(events.length)} />
              </div>

              <div>
                <h3 style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "8px" }}>
                  Recent Events
                </h3>
                {events.length === 0 ? (
                  <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>No recent events</p>
                ) : (
                  <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
                    {events.map((evt) => (
                      <div
                        key={evt.id}
                        style={{
                          display: "flex",
                          alignItems: "center",
                          gap: "12px",
                          padding: "8px 12px",
                          borderRadius: RADIUS.md,
                          backgroundColor: COLORS.secondary,
                          fontSize: "0.8125rem",
                        }}
                      >
                        <Badge variant={evt.type === "handoff" ? "info" : evt.type === "sync" ? "success" : "warning"}>
                          {evt.type}
                        </Badge>
                        <span style={{ flex: 1, color: COLORS.foreground }}>{evt.message}</span>
                        <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)" }}>
                          {evt.duration}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </Card>
        </>
      )}
    </div>
  );
};
