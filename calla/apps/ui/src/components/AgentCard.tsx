/**
 * AgentCard — fleet grid tile
 * ───────────────────────────
 * One agent: identity (emoji tile + name + runtime), live status, its
 * capabilities, how many HITL gates are waiting on a human, and the last
 * thing it did. The whole tile is clickable (Enter/Space too) and opens the
 * agent's chat tab.
 *
 * This module also exports the shared status-derivation helpers so the
 * sidebar and the fleet dashboard agree on what an agent's dot means.
 */

import * as React from "react";
import { Clock } from "lucide-react";
import type { AgentEvent, AgentEventType, AgentStatus } from "@calla/shared";
import { Badge, Card, StatusDot } from "@/components/ui";
import type { AgentConnectionStatus } from "@/types/agent";
import type { AgentRegistryEntry, AgentRuntimeKind } from "@/constants/agents";
import { cn, relativeTime } from "@/lib/utils";

// ─── Status derivation ───────────────────────────────────────────

/** Events newer than this count as "live" for status derivation. */
const RECENT_EVENT_WINDOW_MS = 5 * 60 * 1000;

type RuntimeBadgeVariant = "info" | "secondary" | "success" | "warning";

const RUNTIME_BADGE_VARIANT: Record<AgentRuntimeKind, RuntimeBadgeVariant> = {
  edge: "info",
  core: "secondary",
  brain: "success",
  classifier: "warning",
};

const EVENT_LABEL: Record<AgentEventType, string> = {
  state_change: "state change",
  tool_call: "tool call",
  approval_request: "requested approval",
  approval_resolved: "approval resolved",
  message: "message",
  error: "error",
  classification_completed: "classification completed",
};

export interface DeriveStatusInput {
  /** Pending approvals gated on this agent. */
  pendingCount?: number;
  /** Live connection status (edge agents only — from useAgentHealth). */
  connection?: AgentConnectionStatus;
  /** Events for this agent, oldest first (useCallaEvents order). */
  events?: AgentEvent[];
}

/**
 * Collapse every signal we have into one AgentStatus.
 * Precedence: pending approvals → deployment lifecycle → live connection →
 * recent event feed → runtime default.
 */
export function deriveAgentStatus(
  agent: AgentRegistryEntry,
  input: DeriveStatusInput = {},
): AgentStatus {
  const { pendingCount = 0, connection, events = [] } = input;

  if (pendingCount > 0) return "awaiting_approval";

  if (agent.deploymentStatus && agent.deploymentStatus !== "active") {
    return "offline";
  }

  if (connection) {
    switch (connection) {
      case "connected":
        return "running";
      case "degraded":
      case "error":
        return "error";
      case "disconnected":
        return "offline";
      case "connecting":
        return "idle";
      default:
        break;
    }
  }

  const now = Date.now();
  const recent = events.filter(
    (e) => now - new Date(e.timestamp).getTime() < RECENT_EVENT_WINDOW_MS,
  );
  if (recent.some((e) => e.type === "error")) return "error";
  if (recent.length > 0) return "running";
  if (events.length > 0) return "idle";

  // Edge agents with no reachable health endpoint and no frames are down;
  // core/brain/classifier planes report through their own channels.
  return agent.runtime === "edge" ? "offline" : "idle";
}

/** Most recent event for one agent (events arrive oldest-first). */
export function lastEventForAgent(
  events: AgentEvent[],
  agentId: string,
): AgentEvent | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i].agentId === agentId) return events[i];
  }
  return undefined;
}

/** Human-readable verb for an event type. */
export function eventLabel(type: AgentEventType): string {
  return EVENT_LABEL[type] ?? type;
}

// ─── Component ───────────────────────────────────────────────────

export interface AgentCardProps {
  agent: AgentRegistryEntry;
  /** Pending approvals waiting on this agent. */
  pendingCount: number;
  status?: AgentStatus;
  lastEvent?: AgentEvent;
  onOpen(): void;
}

export const AgentCard = React.memo<AgentCardProps>(
  ({ agent, pendingCount, status, lastEvent, onOpen }) => {
    const capabilities = agent.capabilities.slice(0, 3);
    const dot: AgentStatus | "unknown" = status ?? "unknown";

    return (
      <Card
        role="button"
        tabIndex={0}
        aria-label={`Open ${agent.name}`}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className={cn(
          "group cursor-pointer p-4 transition-shadow duration-150",
          "hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        )}
      >
        {/* Identity + status */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-center gap-3">
            <span
              aria-hidden
              className="flex size-10 shrink-0 items-center justify-center rounded-md bg-surface-tag text-xl leading-none"
            >
              {agent.icon}
            </span>
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold text-foreground">{agent.name}</div>
              <div className="truncate font-mono text-[0.6875rem] text-faint">{agent.id}</div>
            </div>
          </div>
          <StatusDot status={dot} withLabel className="mt-1" />
        </div>

        {/* Runtime + capabilities */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <Badge variant={RUNTIME_BADGE_VARIANT[agent.runtime] ?? "secondary"}>
            {agent.runtime}
          </Badge>
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded-full bg-surface-tag px-2 py-0.5 font-mono text-[0.625rem] text-muted-foreground"
            >
              {cap}
            </span>
          ))}
        </div>

        {/* Pending approvals — the HITL signal */}
        {pendingCount > 0 && (
          <div className="mt-3 flex items-center gap-1.5 rounded-md bg-warning/15 px-2 py-1.5 text-xs font-medium text-warning">
            <Clock className="size-3.5 shrink-0" />
            {pendingCount} awaiting approval
          </div>
        )}

        {/* Last activity */}
        <div className="mt-3 border-t border-border pt-2.5 text-[0.6875rem] text-muted-foreground">
          {lastEvent ? (
            <span className="truncate">
              {eventLabel(lastEvent.type)} · {relativeTime(lastEvent.timestamp)}
            </span>
          ) : (
            <span className="text-faint">No recent activity</span>
          )}
        </div>
      </Card>
    );
  },
);

AgentCard.displayName = "AgentCard";
