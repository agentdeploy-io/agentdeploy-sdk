/**
 * useAgentHealth Hook
 * ────────────────────
 * Periodically checks agent health via HTTP endpoint.
 * Used to display status indicators in lists/grids even when
 * the agent doesn't have an active WebSocket connection.
 *
 * Features:
 *   - Polling at configurable interval
 *   - Latency measurement
 *   - Graceful error handling (3 consecutive failures → degraded)
 *   - Pauses when tab is hidden (saves resources)
 *
 * Usage:
 *   const { healthy, latencyMs, lastChecked } = useAgentHealth(agent)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { type AgentRegistryEntry, DEFAULT_AGENT_CONFIG } from "../constants/agents";
import { errorHandler } from "../errors/errorHandler";
import { ErrorCode } from "../constants/errors";
import { toast } from "./useToast";
import { authFetch } from "./useAuthFetch";
import type { HealthCheck, AgentConnectionStatus } from "../types/agent";

export interface UseAgentHealthResult {
  status: AgentConnectionStatus;
  latencyMs: number | null;
  lastChecked: string | null;
  error: string | null;
}

export function useAgentHealth(
  agent: AgentRegistryEntry | null,
  intervalMs: number = DEFAULT_AGENT_CONFIG.healthCheckInterval,
): UseAgentHealthResult {
  const [status, setStatus] = useState<AgentConnectionStatus>("unknown");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [lastChecked, setLastChecked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const failureCountRef = useRef(0);
  const isMountedRef = useRef(true);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const checkHealth = useCallback(async () => {
    if (!agent || !isMountedRef.current) return;

    // Don't poll if tab is hidden (save resources)
    if (document.hidden) return;

    const startTime = performance.now();

    try {
      const protocol = window.location.protocol === "https:" ? "https:" : "http:";
      const host = window.location.host;
      // Health check via the Vite proxy: /health/{port} → backend /health
      const healthUrl = `${protocol}//${host}/health/${agent.port}`;

      const response = await authFetch(healthUrl, {
        method: "GET",
        signal: AbortSignal.timeout(5000),
      });

      if (!isMountedRef.current) return;

      if (response.ok) {
        const latency = Math.round(performance.now() - startTime);
        setLatencyMs(latency);
        setStatus("connected");
        setError(null);
        failureCountRef.current = 0;
      } else {
        throw new Error(`Health check returned ${response.status}`);
      }
    } catch (err) {
      if (!isMountedRef.current) return;

      failureCountRef.current += 1;
      setLatencyMs(null);

      // On first failure, mark as "disconnected" (might be starting up)
      if (failureCountRef.current === 1) {
        setStatus("disconnected");
      }
      // After 3 consecutive failures, mark as "degraded"
      else if (failureCountRef.current >= 3) {
        setStatus("degraded");
        setError("Agent is not responding to health checks");

        // Only log to errorHandler after sustained failure (not every poll)
        if (failureCountRef.current === 3) {
          errorHandler.handleError(err, {
            code: ErrorCode.AGENT_UNHEALTHY,
            showToast: false,
            agentId: agent.id,
          });
          // Show a toast once on transition to degraded
          toast.warning(
            "Agent Degraded",
            `${agent.name} is not responding to health checks.`,
          );
        }
      }
    }

    setLastChecked(new Date().toISOString());
  }, [agent]);

  useEffect(() => {
    isMountedRef.current = true;

    if (!agent) {
      setStatus("unknown");
      setLatencyMs(null);
      setError(null);
      return;
    }

    // Stagger initial checks to avoid thundering herd
    // (4 agents polling at the exact same time creates proxy noise)
    const jitter = Math.random() * 2000;

    const initialTimer = setTimeout(() => {
      checkHealth();

      // Set up polling after initial check
      intervalRef.current = setInterval(checkHealth, intervalMs);
    }, jitter);

    // Check when tab becomes visible again
    const handleVisibilityChange = () => {
      if (!document.hidden) {
        checkHealth();
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      isMountedRef.current = false;
      clearTimeout(initialTimer);
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [agent, checkHealth, intervalMs]);

  return { status, latencyMs, lastChecked, error };
}
