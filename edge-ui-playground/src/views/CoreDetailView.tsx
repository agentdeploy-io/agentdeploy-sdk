/**
 * CoreDetailView Component
 * ────────────────────────
 * Detail view for a single core (Fly.io VM) deployment with tabbed
 * sub-navigation: Controls | Cost & Budget | Tasks | Events | Approvals.
 */

import React from "react";
import { Card, Badge, Button, Tabs } from "../components/ui";
import { LoadingState, EmptyState, ErrorBoundary } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import { CORE_TABS } from "../constants/navigation";
import { useCoreDeployments } from "../hooks/useCoreDeployments";
import { useCoreDeployment } from "../hooks/useCoreDeployment";
import { CoreControlsView } from "./CoreControlsView";
import { CoreCostView } from "./CoreCostView";
import { CoreTaskListView } from "./CoreTaskListView";
import { CoreEventsView } from "./CoreEventsView";
import { CoreHITLInbox } from "./CoreHITLInbox";

export interface CoreDetailViewProps {
  deploymentId: string;
  tab: string;
  onNavigateTab: (tab: string) => void;
  onNavigateBack: () => void;
}

const HEALTH_VARIANT: Record<string, "success" | "warning" | "error" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  unresponsive: "error",
  unknown: "neutral",
};

export const CoreDetailView: React.FC<CoreDetailViewProps> = ({
  deploymentId,
  tab,
  onNavigateTab,
  onNavigateBack,
}) => {
  const { deployments, loading: listLoading } = useCoreDeployments();
  const { supervision, loading: supervLoading } = useCoreDeployment(deploymentId);

  const deployment = deployments.find((d) => d.id === deploymentId);

  if (listLoading) {
    return <LoadingState message="Loading core deployment…" />;
  }

  if (!deployment) {
    return (
      <EmptyState
        icon="🔍"
        title="Core Deployment Not Found"
        message={`The core deployment "${deploymentId}" does not exist or has been removed.`}
        action={{ label: "Back to Core VMs", onClick: onNavigateBack }}
      />
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <Button variant="ghost" size="sm" onClick={onNavigateBack} leftIcon={<span>←</span>}>
        Back to Core VMs
      </Button>

      <div style={{ display: "flex", alignItems: "flex-start", gap: "16px", marginTop: "12px" }}>
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
          🖥️
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground }}>
              {deployment.name}
            </h1>
            <Badge variant={HEALTH_VARIANT[deployment.heartbeatHealth] ?? "neutral"} dot>
              {deployment.heartbeatHealth}
            </Badge>
            {supervision && (
              <Badge variant="neutral">{supervision.supervisorState}</Badge>
            )}
          </div>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            Fly.io VM deployment {deployment.id}
            {deployment.model ? ` · ${deployment.model}` : ""}
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <Badge variant="neutral">status:{deployment.status}</Badge>
            <Badge variant="info">{Math.round(deployment.vmMinutesPeriod)} min VM this period</Badge>
          </div>
        </div>
      </div>

      {/* ─── Tabs ─────────────────────────────────────────────── */}
      <div style={{ marginTop: "16px" }}>
        <Tabs
          tabs={CORE_TABS.map((t) => ({ id: t.id, label: t.label }))}
          activeTab={tab}
          onChange={onNavigateTab}
        />
      </div>

      {/* ─── Tab Content ──────────────────────────────────────── */}
      <div style={{ marginTop: "24px" }}>
        <ErrorBoundary key={`${deploymentId}-${tab}`}>
          {supervLoading && tab === "cost" ? (
            <Card>
              <LoadingState message="Loading supervision data…" />
            </Card>
          ) : (
            <>
              {tab === "controls" && <CoreControlsView deploymentId={deploymentId} />}
              {tab === "cost" && <CoreCostView deploymentId={deploymentId} />}
              {tab === "tasks" && <CoreTaskListView deploymentId={deploymentId} />}
              {tab === "events" && <CoreEventsView deploymentId={deploymentId} />}
              {tab === "hitl" && <CoreHITLInbox deploymentId={deploymentId} />}
            </>
          )}
        </ErrorBoundary>
      </div>
    </div>
  );
};
