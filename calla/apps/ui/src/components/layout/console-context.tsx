/**
 * Console data contexts
 * ─────────────────────
 * The shell owns exactly ONE /events WebSocket and ONE approval aggregator,
 * mounted by <ConsoleLayout>. Every screen (sidebar badge, fleet dashboard,
 * approval inbox) reads from these contexts instead of instantiating its own
 * hook — otherwise each consumer opens another socket and another poll loop
 * over the same four approval sources.
 *
 * Two separate contexts so an events frame doesn't re-render approval-only
 * consumers and vice versa.
 */

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useAgentRegistry,
  useApprovals,
  useCallaEvents,
  useDeploymentSelector,
  type UseApprovalsResult,
  type UseCallaEventsResult,
} from "@/hooks";
import { authFetch } from "@/hooks/useAuthFetch";

// ─── Events feed ─────────────────────────────────────────────────

const CallaEventsContext = createContext<UseCallaEventsResult | null>(null);

export function ConsoleEventsProvider({ children }: { children: ReactNode }) {
  const events = useCallaEvents();
  return <CallaEventsContext.Provider value={events}>{children}</CallaEventsContext.Provider>;
}

export function useConsoleEvents(): UseCallaEventsResult {
  const ctx = useContext(CallaEventsContext);
  if (!ctx) {
    throw new Error("useConsoleEvents must be used inside <ConsoleEventsProvider>");
  }
  return ctx;
}

// ─── Approvals ───────────────────────────────────────────────────

const ApprovalsContext = createContext<UseApprovalsResult | null>(null);

/** How often the edge agents' durable approval state is re-polled. */
const AGENT_STATE_POLL_MS = 10_000;

/**
 * Durable approval state for every edge agent, keyed by agent id.
 *
 * The event feed's replayed `approval_request` frames carry NO status, so a
 * refreshed page would resurrect decided gates as "pending". The agent DO's
 * `state.pendingApprovals` is the durable record of truth (decided gates keep
 * their terminal status), so the inbox consults it per agent. A key present
 * here means the snapshot loaded; a missing key means "not loaded yet" (the
 * inbox falls back to frames for that agent).
 */
function useEdgeAgentStates(): Record<string, Record<string, unknown> | null> {
  const { agents } = useAgentRegistry();
  const events = useConsoleEvents();

  // Edge agents from the registry, plus any agent that has published an
  // approval frame (covers agents outside the UI registry).
  const agentIds = useMemo(() => {
    const ids = new Set<string>();
    for (const a of agents) {
      if (a.runtime === "edge" && a.id) ids.add(a.id);
    }
    for (const evt of events.events) {
      if (evt.type === "approval_request" && evt.agentId) ids.add(evt.agentId);
    }
    return Array.from(ids);
  }, [agents, events.events]);
  const agentIdsKey = agentIds.join(",");

  const [agentStates, setAgentStates] = useState<Record<string, Record<string, unknown> | null>>({});

  useEffect(() => {
    if (agentIds.length === 0) return;
    let cancelled = false;

    const fetchAll = async () => {
      const results = await Promise.allSettled(
        agentIds.map(async (id) => {
          const res = await authFetch(`/state/${encodeURIComponent(id)}`, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(8000),
          });
          if (!res.ok) throw new Error(`state fetch ${res.status}`);
          const data = (await res.json()) as { state?: Record<string, unknown> | null };
          return [id, data.state ?? null] as const;
        }),
      );
      if (cancelled) return;
      // Merge, never wholesale-replace: a transiently failing agent keeps its
      // last known snapshot (a wholesale clear would demote it to frames,
      // which is exactly the phantom-approval path we're fixing).
      setAgentStates((prev) => {
        const next = { ...prev };
        for (const r of results) {
          if (r.status === "fulfilled") next[r.value[0]] = r.value[1];
        }
        return next;
      });
    };

    fetchAll();
    const interval = setInterval(fetchAll, AGENT_STATE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentIdsKey]);

  return agentStates;
}

export function ConsoleApprovalsProvider({ children }: { children: ReactNode }) {
  const { deploymentId } = useDeploymentSelector();
  const agentStates = useEdgeAgentStates();
  const approvals = useApprovals({ deploymentId, agentStates });
  return <ApprovalsContext.Provider value={approvals}>{children}</ApprovalsContext.Provider>;
}

export function useConsoleApprovals(): UseApprovalsResult {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) {
    throw new Error("useConsoleApprovals must be used inside <ConsoleApprovalsProvider>");
  }
  return ctx;
}
