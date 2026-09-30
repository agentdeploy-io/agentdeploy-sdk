import React, { useState } from "react";
import { useCoreDeployment, type CoreTask } from "../hooks/useCoreDeployment";
import { Card, Badge, Button } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";

const STATE_COLORS: Record<string, string> = {
  queued: "#6b7280",
  running: "#3b82f6",
  awaiting_input: "#f59e0b",
  checkpointed: "#8b5cf6",
  resumed: "#3b82f6",
  succeeded: "#10b981",
  failed: "#ef4444",
  cancelled: "#6b7280",
  expired: "#ef4444",
};

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export interface CoreTaskListViewProps {
  deploymentId: string;
  onSelectTask?: (taskId: string) => void;
}

export const CoreTaskListView: React.FC<CoreTaskListViewProps> = ({
  deploymentId,
  onSelectTask,
}) => {
  const { tasks, loading, error, refetch, cancelTask } = useCoreDeployment(deploymentId);
  const [cancelling, setCancelling] = useState<string | null>(null);

  if (loading && tasks.length === 0) return <LoadingState message="Loading tasks..." />;
  if (error) return <EmptyState icon="⚠️" title="Error" message={error} action={{ label: "Retry", onClick: refetch }} />;
  if (tasks.length === 0) return <EmptyState icon="📋" title="No Tasks" message="No tasks have been submitted to this agent yet." />;

  const handleCancel = async (taskId: string) => {
    setCancelling(taskId);
    await cancelTask(taskId);
    setCancelling(null);
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Tasks ({tasks.length})</h3>
        <Button variant="ghost" size="sm" onClick={refetch}>Refresh</Button>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "13px" }}>
          <thead>
            <tr style={{ borderBottom: "1px solid var(--border, #374151)" }}>
              <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>Task ID</th>
              <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>Type</th>
              <th style={{ textAlign: "left", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>State</th>
              <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>Tokens</th>
              <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>Updated</th>
              <th style={{ textAlign: "right", padding: "8px 12px", fontWeight: 500, color: "var(--muted-foreground, #9ca3af)" }}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => {
              const lastTransition = task.transitions[task.transitions.length - 1];
              const isCancellable = ["queued", "running", "awaiting_input"].includes(task.state);
              return (
                <tr
                  key={task.id}
                  style={{
                    borderBottom: "1px solid var(--border, #374151)",
                    cursor: onSelectTask ? "pointer" : "default",
                  }}
                  onClick={() => onSelectTask?.(task.id)}
                >
                  <td style={{ padding: "8px 12px", fontFamily: "monospace", fontSize: "12px" }}>
                    {task.id.length > 24 ? task.id.slice(0, 24) + "…" : task.id}
                  </td>
                  <td style={{ padding: "8px 12px" }}>{task.taskType}</td>
                  <td style={{ padding: "8px 12px" }}>
                    <span style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "6px",
                      padding: "2px 8px",
                      borderRadius: "9999px",
                      fontSize: "11px",
                      fontWeight: 500,
                      backgroundColor: `${STATE_COLORS[task.state] || "#6b7280"}20`,
                      color: STATE_COLORS[task.state] || "#6b7280",
                    }}>
                      <span style={{
                        width: "6px",
                        height: "6px",
                        borderRadius: "50%",
                        backgroundColor: STATE_COLORS[task.state] || "#6b7280",
                      }} />
                      {task.state}
                    </span>
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontFamily: "monospace", fontSize: "12px" }}>
                    {task.budgetUsed?.tokens?.toLocaleString() || "0"}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right", fontSize: "12px", color: "var(--muted-foreground, #9ca3af)" }}>
                    {lastTransition ? timeAgo(lastTransition.at) : "—"}
                  </td>
                  <td style={{ padding: "8px 12px", textAlign: "right" }} onClick={(e) => e.stopPropagation()}>
                    {isCancellable && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleCancel(task.id)}
                        disabled={cancelling === task.id}
                      >
                        {cancelling === task.id ? "..." : "Cancel"}
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
