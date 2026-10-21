/**
 * useAgentRegistry — live agent registry context
 * ────────────────────────────────────────────────
 * Single source of truth for the agent list across all views.
 *
 * In production it is backed by useDeployments (fetched from
 * {DEPLOYMENT_API_URL}/v1/deployments — one entry per deployment agent,
 * with same-origin /d/{id}/agents/{segment}/{instance} wsPaths).
 * In local dev (AUTH_DISABLED) it falls back to CALLA_DEV_AGENTS.
 *
 * Views must use this hook instead of importing CALLA_DEV_AGENTS directly,
 * otherwise production consoles connect to dev-only wsPaths (no /d/{id}
 * prefix) and the WebSocket handshake 404s.
 */

import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useDeployments } from "@/hooks/useDeployments";
import type { AgentRegistryEntry } from "@/constants/agents";

export interface AgentRegistryContextValue {
  /** Live agents (hardcoded in dev, from the API in production) */
  agents: AgentRegistryEntry[];
  /** True during initial production load */
  loading: boolean;
  /** Error message if the deployment list failed to load */
  error: string | null;
  /** Manually refetch deployments */
  refetch: () => void;
  /** Agent lookup by id */
  getAgentById: (id: string) => AgentRegistryEntry | undefined;
}

const AgentRegistryContext = createContext<AgentRegistryContextValue | null>(null);

export function AgentRegistryProvider({ children }: { children: ReactNode }) {
  const { agents, loading, error, refetch } = useDeployments();

  const value = useMemo<AgentRegistryContextValue>(
    () => ({
      agents,
      loading,
      error,
      refetch,
      getAgentById: (id: string) => agents.find((a) => a.id === id),
    }),
    [agents, loading, error, refetch],
  );

  return <AgentRegistryContext.Provider value={value}>{children}</AgentRegistryContext.Provider>;
}

export function useAgentRegistry(): AgentRegistryContextValue {
  const ctx = useContext(AgentRegistryContext);
  if (!ctx) {
    throw new Error("useAgentRegistry must be used within <AgentRegistryProvider>");
  }
  return ctx;
}
