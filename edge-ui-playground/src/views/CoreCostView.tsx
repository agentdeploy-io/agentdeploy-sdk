import React from "react";
import { useCoreDeployment } from "../hooks/useCoreDeployment";
import { Card } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";

const HEALTH_COLORS: Record<string, string> = {
  healthy: "#10b981",
  degraded: "#f59e0b",
  unresponsive: "#ef4444",
  unknown: "#6b7280",
};

function formatMinutes(mins: number): string {
  if (mins < 60) return `${Math.round(mins)}m`;
  const hrs = mins / 60;
  return `${hrs.toFixed(1)}h`;
}

function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export interface CoreCostViewProps {
  deploymentId: string;
}

export const CoreCostView: React.FC<CoreCostViewProps> = ({ deploymentId }) => {
  const { supervision, loading, error, refetch } = useCoreDeployment(deploymentId);

  if (loading && !supervision) return <LoadingState message="Loading cost data..." />;
  if (error) return <EmptyState icon="⚠️" title="Error" message={error} action={{ label: "Retry", onClick: refetch }} />;
  if (!supervision) return <EmptyState icon="💰" title="No Data" message="Cost data not yet available." />;

  const vmCapMinutes = supervision.maxVmHoursPerDay * 60;
  const vmPercent = vmCapMinutes > 0 ? (supervision.vmMinutesPeriod / vmCapMinutes) * 100 : 0;
  const tokenPercent = supervision.tokenAllowance > 0 ? (supervision.tokenUsed / supervision.tokenAllowance) * 100 : 0;

  const metrics = [
    {
      label: "VM Time This Period",
      value: formatMinutes(supervision.vmMinutesPeriod),
      sub: `of ${formatMinutes(vmCapMinutes)} daily cap`,
      percent: vmPercent,
    },
    {
      label: "Projected Period Cost",
      value: formatCost(supervision.projectedPeriodCost),
      sub: "estimated from burn rate",
      percent: 0,
    },
    {
      label: "Tokens Used",
      value: supervision.tokenUsed.toLocaleString(),
      sub: `of ${supervision.tokenAllowance.toLocaleString()} allowance`,
      percent: tokenPercent,
    },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Cost & Usage</h3>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <span style={{
            width: "8px", height: "8px", borderRadius: "50%",
            backgroundColor: HEALTH_COLORS[supervision.heartbeatHealth] || "#6b7280",
          }} />
          <span style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)" }}>
            {supervision.heartbeatHealth} — {supervision.supervisorState}
          </span>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "12px" }}>
        {metrics.map((m) => (
          <Card key={m.label} style={{ padding: "16px" }}>
            <div style={{ fontSize: "11px", color: "var(--muted-foreground, #9ca3af)", textTransform: "uppercase", letterSpacing: "0.05em" }}>
              {m.label}
            </div>
            <div style={{ fontSize: "24px", fontWeight: 700, marginTop: "4px" }}>{m.value}</div>
            <div style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)", marginTop: "2px" }}>{m.sub}</div>
            {m.percent > 0 && (
              <div style={{ marginTop: "8px", height: "4px", backgroundColor: "var(--border, #374151)", borderRadius: "2px", overflow: "hidden" }}>
                <div style={{
                  width: `${Math.min(100, m.percent)}%`,
                  height: "100%",
                  backgroundColor: m.percent > 90 ? "#ef4444" : m.percent > 70 ? "#f59e0b" : "#3b82f6",
                  borderRadius: "2px",
                  transition: "width 0.3s ease",
                }} />
              </div>
            )}
          </Card>
        ))}
      </div>

      {supervision.lastHeartbeatAt && (
        <div style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)" }}>
          Last heartbeat: {new Date(supervision.lastHeartbeatAt).toLocaleString()}
        </div>
      )}
    </div>
  );
};
