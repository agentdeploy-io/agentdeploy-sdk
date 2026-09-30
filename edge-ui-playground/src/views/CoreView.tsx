/**
 * CoreView Component
 * ──────────────────
 * List of the buyer's core (Fly.io VM) deployments. Clicking one opens the
 * core detail view (controls / cost / tasks / events / approvals tabs).
 */

import React from "react";
import { Card, Badge, Button } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import { useCoreDeployments } from "../hooks/useCoreDeployments";

const HEALTH_VARIANT: Record<string, "success" | "warning" | "error" | "neutral"> = {
  healthy: "success",
  degraded: "warning",
  unresponsive: "error",
  unknown: "neutral",
};

const STATUS_LABEL: Record<string, string> = {
  active: "Active",
  suspended: "Suspended",
  failed: "Failed",
  provisioning: "Provisioning",
};

export interface CoreViewProps {
  onNavigate: (path: string) => void;
}

export const CoreView: React.FC<CoreViewProps> = ({ onNavigate }) => {
  const { deployments, loading, error, refetch } = useCoreDeployments();

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
          Core VMs
        </h1>
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          Fly.io VM deployments — always-on agents with tasks, budgets, and human-in-the-loop approvals.
        </p>
      </div>

      {error ? (
        <Card>
          <EmptyState
            icon="⚠️"
            title="Couldn't Load Core Deployments"
            message={error}
            action={{ label: "Retry", onClick: refetch }}
          />
        </Card>
      ) : loading ? (
        <Card>
          <EmptyState icon="⏳" title="Loading…" message="Fetching your core deployments." />
        </Card>
      ) : deployments.length === 0 ? (
        <Card>
          <EmptyState
            icon="🖥️"
            title="No Core Deployments"
            message="You don't have any core (Fly.io VM) deployments yet. Edge agents appear under Agents."
          />
        </Card>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))",
            gap: "16px",
          }}
        >
          {deployments.map((d) => (
            <Card
              key={d.id}
              hoverable
              style={{ cursor: "pointer" }}
              onClick={() => onNavigate(`/core/${d.id}/controls`)}
            >
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: "12px" }}>
                <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
                  <div
                    style={{
                      width: "40px",
                      height: "40px",
                      borderRadius: RADIUS.md,
                      backgroundColor: COLORS.secondary,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      fontSize: "1.25rem",
                    }}
                  >
                    🖥️
                  </div>
                  <div>
                    <div style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
                      {d.name}
                    </div>
                    <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                      {d.id}
                    </div>
                  </div>
                </div>
                <Badge variant={HEALTH_VARIANT[d.heartbeatHealth] ?? "neutral"} dot>
                  {d.heartbeatHealth}
                </Badge>
              </div>
              <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, marginBottom: "12px", lineHeight: 1.5 }}>
                {d.model ? `Model: ${d.model}` : "Core VM runtime"}
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}>
                <Badge variant="neutral">{STATUS_LABEL[d.status] ?? d.status}</Badge>
                <Badge variant="info">{Math.round(d.vmMinutesPeriod)} min VM this period</Badge>
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "flex-end",
                  paddingTop: "12px",
                  borderTop: `1px solid ${COLORS.border}`,
                }}
              >
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={(e: React.MouseEvent) => {
                    e.stopPropagation();
                    onNavigate(`/core/${d.id}/controls`);
                  }}
                >
                  Manage →
                </Button>
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
};
