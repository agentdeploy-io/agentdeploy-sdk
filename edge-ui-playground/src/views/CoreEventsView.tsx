import React from "react";
import { useCoreDeployment } from "../hooks/useCoreDeployment";
import { LoadingState, EmptyState } from "../components/shared";

const EVENT_ICONS: Record<string, string> = {
  heartbeat: "💓",
  task_transition: "🔄",
  checkpoint: "💾",
  warning: "⚠️",
  tool_call: "🔧",
  progress: "📊",
};

export interface CoreEventsViewProps {
  deploymentId: string;
}

export const CoreEventsView: React.FC<CoreEventsViewProps> = ({ deploymentId }) => {
  const { events, loading, error, refetch } = useCoreDeployment(deploymentId);

  if (loading && events.length === 0) return <LoadingState message="Loading events..." />;
  if (error) return <EmptyState icon="⚠️" title="Error" message={error} action={{ label: "Retry", onClick: refetch }} />;
  if (events.length === 0) return <EmptyState icon="📜" title="No Events" message="No telemetry events received yet." />;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "8px" }}>
        <h3 style={{ margin: 0, fontSize: "14px", fontWeight: 600 }}>Event Log ({events.length})</h3>
        <button onClick={refetch} style={{ fontSize: "12px", color: "var(--muted-foreground, #9ca3af)", background: "none", border: "none", cursor: "pointer" }}>
          Refresh
        </button>
      </div>

      <div style={{ fontFamily: "monospace", fontSize: "12px", maxHeight: "600px", overflowY: "auto" }}>
        {events.map((event) => (
          <div
            key={event.id}
            style={{
              padding: "4px 8px",
              borderBottom: "1px solid var(--border, #374151)",
              display: "flex",
              gap: "8px",
              alignItems: "flex-start",
            }}
          >
            <span style={{ flexShrink: 0, width: "20px", textAlign: "center" }}>
              {EVENT_ICONS[event.eventType] || "📌"}
            </span>
            <span style={{ flexShrink: 0, width: "80px", color: "var(--muted-foreground, #9ca3af)" }}>
              {new Date(event.ts).toLocaleTimeString()}
            </span>
            <span style={{ flexShrink: 0, width: "120px", fontWeight: 500, color: "var(--foreground, #f9fafb)" }}>
              {event.eventType}
            </span>
            <span style={{ color: "var(--muted-foreground, #9ca3af)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {JSON.stringify(event.payload).slice(0, 200)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
