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
  AGENTS,
  AGENT_STATUS_LABELS,
  AGENT_STATUS_BADGE_VARIANT,
} from "../constants/agents";
import { useAgentHealth } from "../hooks/useAgentHealth";
import type { AgentRegistryEntry } from "../constants/agents";

// ─── Props ───────────────────────────────────────────────────────

export interface AgentsViewProps {
  onNavigateAgent: (agentId: string) => void;
}

// ─── Agent Card ──────────────────────────────────────────────────

const AgentCard: React.FC<{
  agent: AgentRegistryEntry;
  onClick: () => void;
}> = ({ agent, onClick }) => {
  const { status, latencyMs } = useAgentHealth(agent);
  const statusVariant = AGENT_STATUS_BADGE_VARIANT[status];

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
        <Badge variant={statusVariant} dot>
          {AGENT_STATUS_LABELS[status]}
        </Badge>
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
        <Button variant="ghost" size="sm" onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onClick();
        }}>
          View Details →
        </Button>
      </div>
    </Card>
  );
};

// ─── Main View ───────────────────────────────────────────────────

export const AgentsView: React.FC<AgentsViewProps> = ({ onNavigateAgent }) => {
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
            {AGENTS.length} agents registered
          </p>
        </div>
        <Dropdown
          trigger={
            <Button variant="primary">
              + New Agent
            </Button>
          }
          align="right"
          width={220}
        >
          <Dropdown.Item icon={<span>💬</span>} onClick={() => { /* TODO: create chat agent */ }}>
            Chat Agent
          </Dropdown.Item>
          <Dropdown.Item icon={<span>🕐</span>} onClick={() => { /* TODO: create cron agent */ }}>
            Cron / Scheduled Agent
          </Dropdown.Item>
          <Dropdown.Item icon={<span>🔗</span>} onClick={() => { /* TODO: create API agent */ }}>
            API / Webhook Agent
          </Dropdown.Item>
          <Dropdown.Divider />
          <Dropdown.Item icon={<span>📦</span>} onClick={() => { /* TODO: import from template */ }}>
            Import from Template
          </Dropdown.Item>
        </Dropdown>
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
      {filteredAgents.length === 0 ? (
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
            />
          ))}
        </div>
      )}
    </div>
  );
};
