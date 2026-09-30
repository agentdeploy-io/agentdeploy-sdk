import React, { useState } from "react";
import { useCoreDeployment, type CoreTask } from "../hooks/useCoreDeployment";
import { Card, Button } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";

export interface CoreHITLInboxProps {
  deploymentId: string;
}

export const CoreHITLInbox: React.FC<CoreHITLInboxProps> = ({ deploymentId }) => {
  const { tasks, loading, resumeTask } = useCoreDeployment(deploymentId);
  const [responding, setResponding] = useState<string | null>(null);
  const [textInput, setTextInput] = useState<Record<string, string>>({});

  const awaitingTasks = tasks.filter((t) => t.state === "awaiting_input");

  const handleRespond = async (task: CoreTask, action: string) => {
    setResponding(task.id);
    await resumeTask(task.id, { action, input: textInput[task.id] });
    setResponding(null);
    setTextInput((prev) => ({ ...prev, [task.id]: "" }));
  };

  if (loading) return <LoadingState message="Loading inbox..." />;

  if (awaitingTasks.length === 0) {
    return (
      <EmptyState
        icon="✅"
        title="Inbox Empty"
        message="No tasks are currently awaiting human input."
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>
        Awaiting Input ({awaitingTasks.length})
      </h3>

      {awaitingTasks.map((task) => {
        const lastTransition = task.transitions[task.transitions.length - 1];
        const promptData = lastTransition?.at ? undefined : undefined;
        const isBusy = responding === task.id;

        return (
          <Card key={task.id} style={{ padding: "16px", borderLeft: "3px solid #f59e0b" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 600, fontSize: "13px" }}>{task.taskType}</div>
                <div style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)", marginTop: "2px" }}>
                  Task: {task.id.length > 30 ? task.id.slice(0, 30) + "…" : task.id}
                </div>
              </div>
              <span style={{
                padding: "2px 8px", borderRadius: "9999px", fontSize: "11px",
                backgroundColor: "#f59e0b20", color: "#f59e0b",
              }}>
                awaiting_input
              </span>
            </div>

            <div style={{ marginTop: "12px", display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <input
                type="text"
                placeholder="Type a response (optional)..."
                value={textInput[task.id] || ""}
                onChange={(e) => setTextInput((prev) => ({ ...prev, [task.id]: e.target.value }))}
                style={{
                  flex: 1, minWidth: "200px", padding: "6px 12px",
                  border: "1px solid var(--border, #374151)", borderRadius: "6px",
                  backgroundColor: "var(--surface-elevated, #1f2937)",
                  color: "var(--foreground, #f9fafb)", fontSize: "13px",
                }}
                onKeyDown={(e) => { if (e.key === "Enter") handleRespond(task, "approve"); }}
              />
              <Button
                variant="primary"
                size="sm"
                onClick={() => handleRespond(task, "approve")}
                disabled={isBusy}
              >
                {isBusy ? "..." : "Approve"}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => handleRespond(task, "reject")}
                disabled={isBusy}
              >
                Reject
              </Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
};
