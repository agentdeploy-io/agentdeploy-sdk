/**
 * useDeploymentSelector — active deployment context
 * ──────────────────────────────────────────────────
 * Tracks which deployment (data-plane /d/{id}) the data-driven views
 * operate on. Derived from the live agent registry; persisted to
 * localStorage across sessions.
 */

import { createContext, useContext, useState, useCallback, useEffect, useMemo, type ReactNode } from "react";
import { useAgentRegistry } from "@/hooks/useAgentRegistry";

const STORAGE_KEY = "calla-selected-deployment";

interface DeploymentSelectorContextValue {
  deploymentId: string | undefined;
  deploymentName: string | undefined;
  deployments: Array<{ id: string; name: string }>;
  setDeploymentId: (id: string) => void;
  loading: boolean;
}

const DeploymentSelectorContext = createContext<DeploymentSelectorContextValue | null>(null);

export function DeploymentSelectorProvider({ children }: { children: ReactNode }) {
  const { agents, loading } = useAgentRegistry();

  const deployments = useMemo(() => {
    const seen = new Map<string, string>();
    for (const agent of agents) {
      const baseId = agent.id.includes(":") ? agent.id.split(":")[0] : agent.id;
      if (!seen.has(baseId)) {
        seen.set(baseId, agent.name);
      }
    }
    return Array.from(seen, ([id, name]) => ({ id, name }));
  }, [agents]);

  const [deploymentId, setDeploymentIdRaw] = useState<string | undefined>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) ?? undefined;
    } catch {
      return undefined;
    }
  });

  const setDeploymentId = useCallback((id: string) => {
    setDeploymentIdRaw(id);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // storage blocked — in-memory only
    }
  }, []);

  useEffect(() => {
    if (deploymentId && deployments.some((d) => d.id === deploymentId)) return;
    if (deployments.length > 0) {
      setDeploymentId(deployments[0].id);
    }
  }, [deployments, deploymentId, setDeploymentId]);

  const deploymentName = useMemo(
    () => deployments.find((d) => d.id === deploymentId)?.name,
    [deployments, deploymentId],
  );

  const value = useMemo<DeploymentSelectorContextValue>(
    () => ({ deploymentId, deploymentName, deployments, setDeploymentId, loading }),
    [deploymentId, deploymentName, deployments, setDeploymentId, loading],
  );

  return (
    <DeploymentSelectorContext.Provider value={value}>
      {children}
    </DeploymentSelectorContext.Provider>
  );
}

export function useDeploymentSelector(): DeploymentSelectorContextValue {
  const ctx = useContext(DeploymentSelectorContext);
  if (!ctx) {
    throw new Error("useDeploymentSelector must be used within <DeploymentSelectorProvider>");
  }
  return ctx;
}
