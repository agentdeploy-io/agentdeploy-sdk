/**
 * useDeployments Hook
 * ──────────────────────
 * Loads the buyer's purchased agent templates from the deployment-service API.
 *
 * In production (subdomain or custom domain):
 *   Fetches from {DEPLOYMENT_API_URL}/v1/deployments using authFetch.
 *   Returns AgentRegistryEntry[] built from the PurchasedTemplate data.
 *
 * In local dev (auth disabled):
 *   Returns the hardcoded AGENTS array from constants/agents.ts immediately.
 *   No API call is made.
 *
 * This hook is the bridge between the marketplace's deployment metadata
 * and the console's agent registry. When a buyer purchases templates on
 * agentdeploy.io, the deployment-service provisions them and this hook
 * fetches the list so the console can display them.
 */

import { useState, useEffect, useCallback } from "react";
import {
  type AgentRegistryEntry,
  AGENTS as LOCAL_DEV_AGENTS,
} from "../constants/agents";
import { AUTH_DISABLED, DEPLOYMENT_API_URL } from "../constants/auth";
import { authFetch } from "./useAuthFetch";
import { errorHandler } from "../errors/errorHandler";
import { ErrorCode } from "../constants/errors";
import type { PurchasedTemplate } from "../types/auth";

// ─── Types ───────────────────────────────────────────────────────

export interface UseDeploymentsResult {
  /** Loaded agents (empty array while loading in production) */
  agents: AgentRegistryEntry[];
  /** True during initial load */
  loading: boolean;
  /** Error message if load failed */
  error: string | null;
  /** Manually refetch deployments */
  refetch: () => void;
}

// ─── API Response Shape ──────────────────────────────────────────

interface DeploymentsApiResponse {
  deployments: PurchasedTemplate[];
}

// ─── Conversion ──────────────────────────────────────────────────

/**
 * Convert a PurchasedTemplate (marketplace shape) to an AgentRegistryEntry
 * (console internal shape).
 *
 * The key difference: PurchasedTemplate doesn't have a `port` field because
 * in production all agents are served from the same origin (the Worker
 * routes by path). The `port` field is only used for the Vite dev proxy.
 */
function templateToAgentEntry(t: PurchasedTemplate): AgentRegistryEntry {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    icon: t.icon,
    kind: t.kind,
    wsPath: t.wsPath,
    // In production, port is irrelevant — all requests are same-origin.
    // We set it to 0 to signal "not applicable" (the dev proxy won't be used).
    port: 0,
    supportsChat: t.supportsChat,
    hasCron: t.hasCron,
    capabilities: t.capabilities,
  };
}

// ─── Hook ────────────────────────────────────────────────────────

export function useDeployments(): UseDeploymentsResult {
  // In local dev, return hardcoded agents immediately — no loading state
  const [agents, setAgents] = useState<AgentRegistryEntry[]>(
    AUTH_DISABLED ? LOCAL_DEV_AGENTS : [],
  );
  const [loading, setLoading] = useState<boolean>(!AUTH_DISABLED);
  const [error, setError] = useState<string | null>(null);
  const [refetchKey, setRefetchKey] = useState(0);

  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1);
  }, []);

  useEffect(() => {
    // Local dev — agents are already set from the initializer
    if (AUTH_DISABLED) {
      setLoading(false);
      return;
    }

    // No deployment API configured — can't fetch
    if (!DEPLOYMENT_API_URL) {
      setError(
        "Deployment API URL is not configured. Set VITE_DEPLOYMENT_API_URL.",
      );
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchDeployments = async () => {
      try {
        const url = `${DEPLOYMENT_API_URL}/v1/deployments`;
        const response = await authFetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });

        if (cancelled) return;

        if (!response.ok) {
          throw new Error(
            `Failed to load deployments: ${response.status} ${response.statusText}`,
          );
        }

        const data: DeploymentsApiResponse = await response.json();
        if (cancelled) return;

        if (!data.deployments || !Array.isArray(data.deployments)) {
          throw new Error("Invalid response: missing deployments array");
        }

        // Filter out suspended/failed deployments
        const activeDeployments = data.deployments.filter(
          (d) =>
            !d.deploymentStatus || d.deploymentStatus === "active",
        );

        const entries = activeDeployments.map(templateToAgentEntry);
        setAgents(entries);
        setError(null);
      } catch (err) {
        if (cancelled) return;
        const msg =
          err instanceof Error ? err.message : "Failed to load deployments";
        setError(msg);
        errorHandler.handleError(err, {
          code: ErrorCode.NETWORK_REQUEST_FAILED,
          showToast: false,
        });
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchDeployments();

    return () => {
      cancelled = true;
    };
  }, [refetchKey]);

  return { agents, loading, error, refetch };
}
