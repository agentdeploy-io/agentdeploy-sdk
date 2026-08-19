/**
 * useAgentInfo Hook
 * ──────────────────
 * Fetches metadata from an agent backend's /health endpoint.
 * Returns real deployment info: model, template ID, version, etc.
 *
 * This is a one-shot fetch (not polling) — the metadata doesn't change
 * at runtime. If the agent restarts with different config, the user
 * can manually refresh.
 *
 * Usage:
 *   const { info, loading, error, refetch } = useAgentInfo(agent);
 */

import { useState, useEffect, useCallback } from "react";
import { type AgentRegistryEntry } from "../constants/agents";
import { API_CONFIG, type HealthResponse } from "../constants/api";
import { errorHandler } from "../errors/errorHandler";
import { ErrorCode } from "../constants/errors";
import { authFetch } from "./useAuthFetch";

export interface AgentInfo {
  deploymentId: string;
  templateId: string;
  model: string;
  agents: string[];
  version: string;
}

export interface UseAgentInfoResult {
  info: AgentInfo | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useAgentInfo(agent: AgentRegistryEntry | null): UseAgentInfoResult {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1);
  }, []);

  useEffect(() => {
    if (!agent) {
      setInfo(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchInfo = async () => {
      try {
        const url = `${window.location.origin}${API_CONFIG.healthPath(agent.port)}`;
        const response = await authFetch(url, {
          signal: AbortSignal.timeout(API_CONFIG.timeoutMs),
        });

        if (cancelled) return;

        if (!response.ok) {
          throw new Error(`Failed to fetch agent info: ${response.status}`);
        }

        const data: HealthResponse = await response.json();
        if (cancelled) return;

        setInfo({
          deploymentId: data.deploymentId,
          templateId: data.templateId,
          model: data.model,
          agents: data.agents,
          version: data.version,
        });
        setError(null);
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to fetch agent info");
        // Don't use errorHandler here — health check failures are expected
        // when backends are down. The health hook handles toasts.
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchInfo();

    return () => {
      cancelled = true;
    };
  }, [agent, refetchKey]);

  return { info, loading, error, refetch };
}
