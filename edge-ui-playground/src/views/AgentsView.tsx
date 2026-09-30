/**
 * AgentsView Component
 * ────────────────────
 * Grid/list view of all registered agents with status indicators.
 * Clicking an agent navigates to its detail page.
 *
 * Layout (from edge.pen mockup N4r9Mb):
 *   ┌─────────────────────────────────────────────┐
 *   │ "Agents" title + "New Agent" button         │
 *   │ Search + filter bar                         │
 *   ├──────────┬──────────┬──────────┬────────────┤
 *   │ Agent    │ Agent    │ Agent    │ Agent      │
 *   │ Card     │ Card     │ Card     │ Card       │
 *   └──────────┴──────────┴──────────┴────────────┘
 *
 * Each card shows:
 *   - Icon + name
 *   - Status badge (live health check)
 *   - Description
 *   - Kind (chat/cron/api/worker)
 *   - Capabilities tags
 *   - "View Details" button
 */

import React from "react";
import { Card, Badge, Button, StatusDot, Dropdown, Tooltip } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_BADGE_VARIANT,
} from "../constants/agents";
import { DEPLOYMENT_API_URL } from "../constants/auth";
import { authFetch } from "../hooks/useAuthFetch";
import { useAgentHealth } from "../hooks/useAgentHealth";
import { useAgentRegistry } from "../hooks/useAgentRegistry";
import type { AgentRegistryEntry } from "../constants/agents";

// ─── Props ───────────────────────────────────────────────────────

export interface AgentsViewProps {
  onNavigateAgent: (agentId: string) => void;
}

// ─── Agent Card ──────────────────────────────────────────────────

/** Deployment lifecycle status → badge styling. */
const LIFECYCLE_BADGE: Record<string, { label: string; variant: "success" | "warning" | "error" | "neutral" }> = {
  active: { label: "Active", variant: "success" },
  pending: { label: "Provisioning", variant: "warning" },
  suspended: { label: "Suspended", variant: "warning" },
  failed: { label: "Failed", variant: "error" },
};

/** Call a deployment lifecycle action (resume/cancel) on the DS. */
async function callLifecycleAction(deploymentId: string, action: "resume" | "cancel"): Promise<boolean> {
  const apiBase = DEPLOYMENT_API_URL.replace(/\/+$/, "");
  try {
    const res = await authFetch(`${apiBase}/v1/deployments/${deploymentId}/${action}`, {
      method: "POST",
    });
    return res.ok;
  } catch {
    return false;
  }
}

const AgentCard: React.FC<{
  agent: AgentRegistryEntry;
  onClick: () => void;
  onLifecycleChanged: () => void;
}> = ({ agent, onClick, onLifecycleChanged }) => {
  const { status, latencyMs } = useAgentHealth(agent);
  const statusVariant = AGENT_STATUS_BADGE_VARIANT[status];
  const [acting, setActing] = React.useState<"" | "resume" | "cancel">("");
  const isInactive = agent.deploymentStatus && agent.deploymentStatus !== "active";
  const deploymentId = agent.id.split(":")[0];

  const handleLifecycle = async (e: React.MouseEvent, action: "resume" | "cancel") => {
    e.stopPropagation();
    if (action === "cancel" && !window.confirm(`Cancel deployment ${deploymentId}? This deletes its worker and cannot be undone.`)) return;
    setActing(action);
    const ok = await callLifecycleAction(deploymentId, action);
    setActing("");
    if (ok) onLifecycleChanged();
  };

  return (
    <Card hoverable onClick={onClick} style={{ cursor: "pointer" }}>
      {/* Header: icon + name + status */}
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
            {agent.icon}
          </div>
          <div>
            <div style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
              {agent.name}
            </div>
            <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
              {agent.id}
            </div>
          </div>
        </div>
        <div style={{ display: "flex", gap: "6px" }}>
          {isInactive && (
            <Badge variant={LIFECYCLE_BADGE[agent.deploymentStatus!]?.variant ?? "warning"}>
              {LIFECYCLE_BADGE[agent.deploymentStatus!]?.label ?? agent.deploymentStatus}
            </Badge>
          )}
          <Badge variant={statusVariant} dot>
            {AGENT_STATUS_LABELS[status]}
          </Badge>
        </div>
      </div>

      {/* Description */}
      <p
        style={{
          fontSize: "0.8125rem",
          color: COLORS.mutedForeground,
          marginBottom: "12px",
          lineHeight: 1.5,
        }}
        className="line-clamp-2"
      >
        {agent.description}
      </p>

      {/* Kind + Capabilities */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "12px" }}>
        <Badge variant="neutral">{agent.kind}</Badge>
        {agent.hasCron && <Badge variant="info">cron</Badge>}
        {agent.supportsChat && <Badge variant="info">chat</Badge>}
        <Badge variant="neutral">:{agent.port}</Badge>
      </div>

      {/* Footer: latency + button */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          paddingTop: "12px",
          borderTop: `1px solid ${COLORS.border}`,
        }}
      >
        <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
          {latencyMs !== null ? `${latencyMs}ms latency` : "Awaiting check…"}
        </span>
        <div style={{ display: "flex", gap: "6px" }}>
          {isInactive && (
            <>
              {agent.deploymentStatus !== "failed" && (
                <Button
                  variant="secondary"
                  size="sm"
                  loading={acting === "resume"}
                  disabled={acting !== ""}
                  onClick={(e) => handleLifecycle(e, "resume")}
                >
                  Resume
                </Button>
              )}
              <Button
                variant="ghost"
                size="sm"
                loading={acting === "cancel"}
                disabled={acting !== ""}
                onClick={(e) => handleLifecycle(e, "cancel")}
              >
                Cancel
              </Button>
            </>
          )}
          <Button variant="ghost" size="sm" onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            onClick();
          }}>
            View Details →
          </Button>
        </div>
      </div>
    </Card>
  );
};

// ─── Main View ───────────────────────────────────────────────────

export const AgentsView: React.FC<AgentsViewProps> = ({ onNavigateAgent }) => {
  const { agents: AGENTS, loading, error, refetch } = useAgentRegistry();
  const [searchQuery, setSearchQuery] = React.useState("");
  const [filterKind, setFilterKind] = React.useState<string>("all");

  // Filter agents
  const filteredAgents = React.useMemo(() => {
    return AGENTS.filter((agent) => {
      const matchesSearch =
        !searchQuery ||
        agent.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.description.toLowerCase().includes(searchQuery.toLowerCase()) ||
        agent.id.toLowerCase().includes(searchQuery.toLowerCase());

      const matchesKind = filterKind === "all" || agent.kind === filterKind;

      return matchesSearch && matchesKind;
    });
  }, [searchQuery, filterKind]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
            Agents
          </h1>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
            {AGENTS.length} agents registered — new agents are purchased from the marketplace
          </p>
        </div>
      </div>

      {/* ─── Filter Bar ──────────────────────────────────────── */}
      <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
        {/* Search */}
        <div style={{ position: "relative", flex: 1, maxWidth: "320px" }}>
          <input
            type="text"
            placeholder="Search agents…"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            style={{
              width: "100%",
              height: "36px",
              padding: "0 12px 0 36px",
              borderRadius: RADIUS.md,
              border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.card,
              color: COLORS.foreground,
              fontSize: "0.8125rem",
              outline: "none",
            }}
          />
          <span
            style={{
              position: "absolute",
              left: "10px",
              top: "50%",
              transform: "translateY(-50%)",
              color: COLORS.mutedForeground,
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </span>
        </div>

        {/* Kind Filter */}
        <div style={{ display: "flex", gap: "4px" }}>
          {["all", "chat", "cron", "api", "worker"].map((kind) => (
            <button
              key={kind}
              onClick={() => setFilterKind(kind)}
              style={{
                height: "36px",
                padding: "0 12px",
                borderRadius: RADIUS.md,
                fontSize: "0.8125rem",
                fontWeight: 500,
                backgroundColor: filterKind === kind ? COLORS.secondary : "transparent",
                color: filterKind === kind ? COLORS.foreground : COLORS.mutedForeground,
                border: `1px solid ${filterKind === kind ? COLORS.border : "transparent"}`,
                cursor: "pointer",
                textTransform: "capitalize",
                transition: "background-color 150ms ease",
              }}
            >
              {kind}
            </button>
          ))}
        </div>
      </div>

      {/* ─── Agent Grid ──────────────────────────────────────── */}
      {error ? (
        <Card>
          <EmptyState
            icon="⚠️"
            title="Couldn't Load Agents"
            message={`${error} If this keeps happening, reload the page to re-authenticate.`}
            action={{ label: "Retry", onClick: refetch }}
          />
        </Card>
      ) : loading ? (
        <Card>
          <EmptyState icon="⏳" title="Loading Agents…" message="Fetching your deployments." />
        </Card>
      ) : filteredAgents.length === 0 ? (
        <Card>
          <EmptyState
            icon={searchQuery ? "🔍" : "🤖"}
            title={searchQuery ? "No Agents Found" : "No Agents Configured"}
            message={
              searchQuery
                ? `No agents match "${searchQuery}". Try a different search term or filter.`
                : "No agents are registered in the console. Add agents to your registry to see them here."
            }
            action={
              searchQuery
                ? { label: "Clear Filters", onClick: () => { setSearchQuery(""); setFilterKind("all"); } }
                : undefined
            }
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
          {filteredAgents.map((agent) => (
            <AgentCard
              key={agent.id}
              agent={agent}
              onClick={() => onNavigateAgent(agent.id)}
              onLifecycleChanged={refetch}
            />
          ))}
        </div>
      )}
    </div>
  );
};
