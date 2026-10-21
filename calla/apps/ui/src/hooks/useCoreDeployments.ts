/**
 * useCoreDeployments Hook
 * ────────────────────────
 * Loads the buyer's core (Fly.io VM) deployments from the deployment-service
 * console API (GET /v1/core, edge-JWT authed via authFetch).
 */

import { useState, useEffect, useCallback } from "react";
import { AUTH_DISABLED, DEPLOYMENT_API_URL } from "@/constants/auth";
import { authFetch } from "@/hooks/useAuthFetch";

export interface CoreDeploymentSummary {
  id: string;
  name: string;
  status: string;
  model: string | null;
  supervisorState: string | null;
  lastHeartbeatAt: string | null;
  heartbeatHealth: "healthy" | "degraded" | "unresponsive" | "unknown";
  vmMinutesPeriod: number;
  hasMachine: boolean;
  createdAt: string | null;
}

export interface UseCoreDeploymentsResult {
  deployments: CoreDeploymentSummary[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useCoreDeployments(): UseCoreDeploymentsResult {
  const [deployments, setDeployments] = useState<CoreDeploymentSummary[]>([]);
  const [loading, setLoading] = useState<boolean>(!AUTH_DISABLED);
  const [error, setError] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const refetch = useCallback(() => setRefetchKey((k) => k + 1), []);

  useEffect(() => {
    if (AUTH_DISABLED) {
      // No core deployments in local dev.
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchList = async () => {
      const apiBase = DEPLOYMENT_API_URL.replace(/\/+$/, "");
      try {
        const res = await authFetch(`${apiBase}/v1/core`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (cancelled) return;
        if (!res.ok) {
          throw new Error(`Failed to load core deployments: ${res.status}`);
        }
        const data: { deployments: CoreDeploymentSummary[] } = await res.json();
        if (cancelled) return;
        setDeployments(Array.isArray(data.deployments) ? data.deployments : []);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load core deployments");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchList();
    return () => {
      cancelled = true;
    };
  }, [refetchKey]);

  return { deployments, loading, error, refetch };
}
