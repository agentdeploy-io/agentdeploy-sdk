/**
 * ConversationsView Component
 * ────────────────────────────
 * List of all conversations across all agents.
 *
 * Data availability:
 *   The Cloudflare Agents SDK does not expose a cross-agent
 *   conversations list endpoint. Each agent's conversations
 *   live inside its own Durable Object state. This view shows
 *   an honest empty state explaining that, and lets the user
 *   navigate to individual agents to view their conversations.
 *
 * Layout (from edge.pen mockup Z5I9EH):
 *   ┌─────────────────────────────────────────────┐
 *   │ "Conversations" title + search              │
 *   ├──────────┬──────────┬──────────┬────────────┤
 *   │ Table: Agent | Preview | Messages | Updated │
 *   └─────────────────────────────────────────────┘
 */

import React from "react";
import { Card, Badge, Button } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS } from "../constants/theme";
import { AGENTS } from "../constants/agents";
import { useAgentHealth } from "../hooks/useAgentHealth";
import type { AgentRegistryEntry } from "../constants/agents";

// ─── Props ───────────────────────────────────────────────────────

export interface ConversationsViewProps {
  onNavigateAgent?: (agentId: string) => void;
}

// ─── Agent Health Row (visible — shows agents the user can open) ──

/**
 * Shows each registered agent with a live status badge and a
 * "View Conversations" link that navigates to the agent detail.
 * This replaces the fake conversation table with an honest
 * "per-agent entry point" list.
 */
const AgentConversationRow: React.FC<{
  agent: AgentRegistryEntry;
  onOpen: () => void;
}> = ({ agent, onOpen }) => {
  const { status } = useAgentHealth(agent);

  const variant =
    status === "connected"
      ? ("success" as const)
      : status === "error"
        ? ("error" as const)
        : status === "degraded"
          ? ("warning" as const)
          : ("neutral" as const);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "12px",
        padding: "12px 20px",
        borderBottom: `1px solid ${COLORS.border}`,
      }}
    >
      <span style={{ fontSize: "1.25rem", flexShrink: 0 }}>{agent.icon}</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
          {agent.name}
        </div>
        <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
          {agent.id} · port:{agent.port}
        </div>
      </div>
      {agent.supportsChat ? (
        <Badge variant="info">chat enabled</Badge>
      ) : (
        <Badge variant="neutral">no chat</Badge>
      )}
      <Badge variant={variant} dot>
        {status.charAt(0).toUpperCase() + status.slice(1)}
      </Badge>
      <Button variant="ghost" size="sm" onClick={onOpen} disabled={!agent.supportsChat}>
        Open →
      </Button>
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────

export const ConversationsView: React.FC<ConversationsViewProps> = ({ onNavigateAgent }) => {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
          Conversations
        </h1>
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          {AGENTS.length} agents registered · open an agent to view its conversations
        </p>
      </div>

      {/* ─── Info Banner ─────────────────────────────────────── */}
      <Card>
        <EmptyState
          icon="💬"
          title="Cross-Agent Conversation Index Not Available"
          message="The Cloudflare Agents SDK stores each agent's conversations inside its own Durable Object state. There is no central API to list conversations across agents yet. Open an individual agent below to view its conversations."
        />
      </Card>

      {/* ─── Per-Agent Entry Points ──────────────────────────── */}
      <Card padding="none">
        <div style={{ padding: "20px 20px 0" }}>
          <Card.Header
            title="Agents"
            subtitle="Open an agent to see its live conversations"
          />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {AGENTS.map((agent) => (
            <AgentConversationRow
              key={agent.id}
              agent={agent}
              onOpen={() => onNavigateAgent?.(agent.id)}
            />
          ))}
        </div>
      </Card>
    </div>
  );
};
