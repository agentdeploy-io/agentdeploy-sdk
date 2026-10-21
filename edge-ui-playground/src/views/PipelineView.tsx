import React from "react";
import { Card, MetricCard, Badge } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";
import { DeploymentSelector } from "../components/DeploymentSelector";
import { COLORS, RADIUS, STATUS_COLORS, TRANSITIONS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";
import { usePipeline, useRuns } from "../hooks/useDataApi";
import type { RunEntry } from "../hooks/useDataApi";

// ─── Props ───────────────────────────────────────────────────────

export interface PipelineViewProps {
  // no props needed
}

// ─── Stage Card ──────────────────────────────────────────────────

const STAGE_ORDER = ["raw", "verified", "classified", "researched", "approved", "sent", "replied"];

const STAGE_COLORS: Record<string, string> = {
  raw: STATUS_COLORS.info,
  verified: "var(--color-info)",
  classified: STATUS_COLORS.warning,
  researched: STATUS_COLORS.warning,
  approved: STATUS_COLORS.success,
  sent: STATUS_COLORS.success,
  replied: STATUS_COLORS.success,
};

const StageCard: React.FC<{
  name: string;
  count: number;
  delta: number;
  isLast: boolean;
}> = ({ name, count, delta, isLast }) => {
  const color = STAGE_COLORS[name] ?? COLORS.mutedForeground;
  const deltaPositive = delta > 0;
  const deltaColor = deltaPositive ? STATUS_COLORS.success : delta < 0 ? STATUS_COLORS.error : COLORS.mutedForeground;

  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0" }}>
      <div
        style={{
          flex: "1 0 120px",
          padding: "20px 16px",
          borderRadius: RADIUS.lg,
          border: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.card,
          display: "flex",
          flexDirection: "column",
          gap: "8px",
          transition: `box-shadow ${TRANSITIONS.fast}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <span
            style={{
              fontSize: "0.6875rem",
              fontWeight: 600,
              textTransform: "uppercase",
              letterSpacing: "0.06em",
              color,
            }}
          >
            {name}
          </span>
          <span
            style={{
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: color,
            }}
          />
        </div>
        <div style={{ fontSize: "1.875rem", fontWeight: 700, color: COLORS.foreground, lineHeight: 1.2 }}>
          {count.toLocaleString()}
        </div>
        <div style={{ fontSize: "0.75rem", color: deltaColor, fontWeight: 500 }}>
          {deltaPositive ? "+" : ""}{delta.toLocaleString()} in 24h
        </div>
      </div>
      {!isLast && (
        <svg
          width="24"
          height="24"
          viewBox="0 0 24 24"
          fill="none"
          stroke={COLORS.border}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{ flexShrink: 0, marginLeft: "-2px", marginRight: "-2px" }}
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      )}
    </div>
  );
};

// ─── Run Row ─────────────────────────────────────────────────────

const STATE_BADGE: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  completed: "success",
  running: "info",
  failed: "error",
  cancelled: "neutral",
};

const RunRow: React.FC<{ run: RunEntry }> = ({ run }) => (
  <tr
    style={{
      height: "48px",
      transition: `background-color ${TRANSITIONS.fast}`,
    }}
    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.cardHover)}
    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
  >
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", color: COLORS.foreground }}>
      {run.trigger}
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
      {new Date(run.startedAt).toLocaleString()}
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", fontFamily: "var(--font-mono)", color: COLORS.mutedForeground }}>
      {Math.round(run.duration / 1000)}s
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", fontFamily: "var(--font-mono)", color: COLORS.mutedForeground }}>
      {run.vmMinutes.toFixed(1)}m
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", fontFamily: "var(--font-mono)", color: COLORS.mutedForeground }}>
      {run.tokens.toLocaleString()}
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontSize: "0.8125rem", fontFamily: "var(--font-mono)", color: COLORS.mutedForeground }}>
      ${run.cost.toFixed(4)}
    </td>
    <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
      <Badge variant={STATE_BADGE[run.state] ?? "neutral"}>{run.state}</Badge>
    </td>
  </tr>
);

// ─── Component ───────────────────────────────────────────────────

export const PipelineView: React.FC<PipelineViewProps> = () => {
  const { deploymentId } = useDeploymentSelector();
  const { data: pipeline, status: pipelineStatus, loading: pipelineLoading, error: pipelineError, refetch: refetchPipeline } = usePipeline(deploymentId);
  const { runs, loading: runsLoading, error: runsError, refetch: refetchRuns } = useRuns(deploymentId);

  const isLoading = pipelineLoading || runsLoading;
  const hasError = pipelineError || runsError;

  const stages = pipeline?.stages ?? [];
  const stageMap = new Map(stages.map((s) => [s.name.toLowerCase(), s]));
  const orderedStages = STAGE_ORDER.map((name) => stageMap.get(name) ?? { name, count: 0, delta24h: 0 });

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
            Pipeline
          </h1>
          <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
            Live funnel visualization and run history
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <DeploymentSelector />
          <button
            onClick={() => { refetchPipeline(); refetchRuns(); }}
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

      {!deploymentId && (
        <EmptyState icon="🔄" title="No deployment selected" message="Select a deployment above to view pipeline data." />
      )}

      {deploymentId && isLoading && <LoadingState variant="spinner" message="Loading pipeline data..." height="200px" />}
      {deploymentId && hasError && (
        <Card>
          <div style={{ padding: "24px", textAlign: "center" }}>
            <p style={{ color: STATUS_COLORS.error, fontSize: "0.875rem", marginBottom: "12px" }}>{pipelineError ?? runsError}</p>
            <button
              onClick={() => { refetchPipeline(); refetchRuns(); }}
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
      )}

      {deploymentId && !isLoading && !hasError && (
        <>
          {/* Cron Indicators */}
          {pipelineStatus && (
            <div style={{ display: "flex", gap: "16px", flexWrap: "wrap" }}>
              {pipelineStatus.cronExpression && (
                <MetricCard label="Cron Schedule" value={pipelineStatus.cronExpression} />
              )}
              {pipelineStatus.nextRun && (
                <MetricCard
                  label="Next Run"
                  value={new Date(pipelineStatus.nextRun).toLocaleTimeString()}
                />
              )}
              {pipelineStatus.lastRun && (
                <MetricCard
                  label="Last Run"
                  value={new Date(pipelineStatus.lastRun).toLocaleTimeString()}
                />
              )}
              {pipelineStatus.lastFailure && (
                <Card>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <Badge variant="error" dot>Last Failure</Badge>
                    <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
                      {new Date(pipelineStatus.lastFailure).toLocaleString()}
                    </span>
                  </div>
                </Card>
              )}
            </div>
          )}

          {/* Stage Funnel */}
          <div>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
              Funnel Stages
            </h2>
            {orderedStages.length === 0 ? (
              <EmptyState icon="🔄" title="No pipeline data" message="The pipeline hasn't run yet. Configure and trigger a run to see the funnel." />
            ) : (
              <div data-tour="pipeline" style={{ display: "flex", overflowX: "auto", gap: "0", paddingBottom: "8px" }}>
                {orderedStages.map((stage, idx) => (
                  <StageCard
                    key={stage.name}
                    name={stage.name}
                    count={stage.count}
                    delta={stage.delta24h}
                    isLast={idx === orderedStages.length - 1}
                  />
                ))}
              </div>
            )}
          </div>

          {/* Run History */}
          <div>
            <h2 style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
              Run History
            </h2>
            {runs.length === 0 ? (
              <EmptyState icon="📋" title="No runs yet" message="Pipeline runs will appear here once triggered." />
            ) : (
              <Card padding="none">
                <div data-tour="cost" style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse" }}>
                    <thead>
                      <tr style={{ borderBottom: `1px solid ${COLORS.border}` }}>
                        {["Trigger", "Started", "Duration", "VM-Min", "Tokens", "Cost", "State"].map((h) => (
                          <th
                            key={h}
                            style={{
                              padding: "0 16px",
                              height: "40px",
                              textAlign: "left",
                              fontSize: "0.75rem",
                              fontWeight: 600,
                              color: COLORS.mutedForeground,
                              textTransform: "uppercase",
                              letterSpacing: "0.04em",
                            }}
                          >
                            {h}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((run) => (
                        <RunRow key={run.id} run={run} />
                      ))}
                    </tbody>
                  </table>
                </div>
              </Card>
            )}
          </div>
        </>
      )}
    </div>
  );
};
