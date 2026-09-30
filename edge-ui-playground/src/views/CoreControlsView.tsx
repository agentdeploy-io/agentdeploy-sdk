import React from "react";
import { useCoreDeployment } from "../hooks/useCoreDeployment";
import { Button } from "../components/ui";
import { LoadingState } from "../components/shared";

export interface CoreControlsViewProps {
  deploymentId: string;
}

export const CoreControlsView: React.FC<CoreControlsViewProps> = ({ deploymentId }) => {
  const { supervision, loading, stopDeployment, startDeployment, refetch } = useCoreDeployment(deploymentId);

  if (loading && !supervision) return <LoadingState message="Loading controls..." />;

  const supervisorState = supervision?.supervisorState || "unknown";
  const isRunning = supervisorState === "active" || supervisorState === "degraded";
  const isStopped = supervisorState === "stopped_operator" || supervisorState === "stopped";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Deployment Controls</h3>

      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        <div style={{
          display: "flex", alignItems: "center", gap: "8px",
          padding: "8px 16px", borderRadius: "8px",
          backgroundColor: "var(--surface-elevated, #1f2937)",
          border: "1px solid var(--border, #374151)",
        }}>
          <span style={{
            width: "10px", height: "10px", borderRadius: "50%",
            backgroundColor: isRunning ? "#10b981" : isStopped ? "#ef4444" : "#6b7280",
          }} />
          <span style={{ fontSize: "13px", fontWeight: 500 }}>
            {isRunning ? "Running" : isStopped ? "Stopped" : supervisorState}
          </span>
        </div>

        <Button
          variant="ghost"
          size="sm"
          onClick={stopDeployment}
          disabled={!isRunning}
        >
          Stop VM
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={startDeployment}
          disabled={isRunning}
        >
          Start VM
        </Button>

        <Button variant="ghost" size="sm" onClick={refetch}>
          Refresh
        </Button>
      </div>

      {supervision && (
        <div style={{
          fontSize: "12px", color: "var(--muted-foreground, #9ca3af)",
          display: "flex", gap: "24px",
        }}>
          <span>Heartbeat: {supervision.heartbeatHealth}</span>
          <span>VM: {Math.round(supervision.vmMinutesPeriod)}m / {supervision.maxVmHoursPerDay * 60}m</span>
          <span>Tokens: {supervision.tokenUsed.toLocaleString()} / {supervision.tokenAllowance.toLocaleString()}</span>
          {supervision.lastHeartbeatAt && (
            <span>Last beat: {new Date(supervision.lastHeartbeatAt).toLocaleTimeString()}</span>
          )}
        </div>
      )}
    </div>
  );
};
