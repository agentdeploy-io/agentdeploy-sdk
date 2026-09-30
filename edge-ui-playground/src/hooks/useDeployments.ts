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
  /** Personal/demo agents are filtered out unless VITE_PERSONAL_AGENTS=true */
  VISIBLE_LOCAL_AGENTS as LOCAL_DEV_AGENTS,
} from "../constants/agents";
import { AUTH_DISABLED, DEPLOYMENT_API_URL, EDGE_JWT_STORAGE_KEY, isCustomDomain, buildTokenExchangeUrl } from "../constants/auth";
import { authFetch } from "./useAuthFetch";
import { useAuth } from "./useAuth";
import { errorHandler } from "../errors/errorHandler";
import { redirectWithAuthTransition } from "../components/shared/AuthTransition";
import { ErrorCode } from "../constants/errors";
import type { PurchasedTemplate, PurchasedTemplateAgent } from "../types/auth";

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
function templateToAgentEntry(
  t: PurchasedTemplate,
  agent?: PurchasedTemplateAgent,
): AgentRegistryEntry {
  return {
    // Multi-agent deployments get one entry per agent, keyed by class name.
    id: agent ? `${t.id}:${agent.className}` : t.id,
    name: agent && t.agents && t.agents.length > 1 ? `${t.name} — ${agent.name}` : t.name,
    description: agent?.description || t.description,
    icon: t.icon,
    kind: t.kind,
    wsPath: agent?.wsPath ?? t.wsPath,
    className: agent?.className,
    // In production, port is irrelevant — all requests are same-origin.
    // We set it to 0 to signal "not applicable" (the dev proxy won't be used).
    port: 0,
    supportsChat: t.supportsChat,
    hasCron: t.hasCron,
    capabilities: t.capabilities,
    deploymentStatus: t.deploymentStatus,
  };
}

/**
 * Expand a deployment into console entries: one per declared agent for
 * multi-agent templates, one for single/legacy deployments (which always
 * carry a synthetic one-entry agents list from the API).
 */
function templateToAgentEntries(t: PurchasedTemplate): AgentRegistryEntry[] {
  if (t.agents && t.agents.length > 0) {
    return t.agents.map((a) => templateToAgentEntry(t, a));
  }
  return [templateToAgentEntry(t)];
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
  // Gate on auth readiness: AuthProvider is a parent, so its checkAuth effect
  // runs AFTER this one. On a token-exchange redirect-back, checkAuth is what
  // stores ?edge_token into localStorage — fetching before it runs sends a
  // stale/missing token and 401s (the "Couldn't Load Agents" flake).
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const refetch = useCallback(() => {
    setRefetchKey((k) => k + 1);
  }, []);

  useEffect(() => {
    // Local dev — agents are already set from the initializer
    if (AUTH_DISABLED) {
      setLoading(false);
      return;
    }

    // Wait for auth to resolve before firing (token must be in localStorage).
    if (authLoading || !isAuthenticated) return;

    // Empty DEPLOYMENT_API_URL means same-origin: the console Worker
    // proxies /v1/* to the marketplace BFF (avoids CORS entirely).
    const apiBase = DEPLOYMENT_API_URL.replace(/\/+$/, "");

    let cancelled = false;
    setLoading(true);
    setError(null);

    const fetchDeployments = async () => {
      try {
        const url = `${apiBase}/v1/deployments`;
        const response = await authFetch(url, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });

        if (cancelled) return;

        if (!response.ok) {
          // 401 on a custom-domain console means the edge JWT is stale/expired.
          // Drop it and re-run the token exchange instead of failing silently.
          if (response.status === 401 && isCustomDomain()) {
            // Just returned from an exchange (token still in the URL — the
            // provider stores it on this pass). The 401 is from a stale
            // in-flight request; retry once with the fresh token instead of
            // looping into another exchange.
            if (new URLSearchParams(window.location.search).has("edge_token")) {
              refetch();
              return;
            }
            // Loop guard: if we just came back from an exchange and still got
            // 401, surface the error instead of redirecting forever.
            const justExchanged = sessionStorage.getItem("edge_exchange_attempt");
            if (justExchanged) {
              sessionStorage.removeItem("edge_exchange_attempt");
              throw new Error("Authentication failed (401). Please log in again and reload.");
            }
            try {
              localStorage.removeItem(EDGE_JWT_STORAGE_KEY);
              sessionStorage.setItem("edge_exchange_attempt", "1");
            } catch {
              // ignore
            }
            // Show branded overlay so the 401 re-exchange doesn't flash raw UI
            redirectWithAuthTransition(buildTokenExchangeUrl(window.location.href));
            return;
          }
          throw new Error(
            `Failed to load deployments: ${response.status} ${response.statusText}`,
          );
        }

        const data: DeploymentsApiResponse = await response.json();
        if (cancelled) return;

        if (!data.deployments || !Array.isArray(data.deployments)) {
          throw new Error("Invalid response: missing deployments array");
        }

        // Keep suspended/failed deployments visible (with resume/cancel
        // actions in the UI) — only drop fully cancelled ones.
        const visibleDeployments = data.deployments.filter(
          (d) => d.deploymentStatus !== "cancelled",
        );

        const entries = visibleDeployments.flatMap(templateToAgentEntries);
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
  }, [refetchKey, authLoading, isAuthenticated, refetch]);

  return { agents, loading, error, refetch };
}
