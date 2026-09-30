import { useState, useEffect, useCallback } from "react";
import { authFetch } from "./useAuthFetch";
import { DEPLOYMENT_API_URL } from "../constants/auth";

export interface CoreTask {
  id: string;
  state: string;
  taskType: string;
  transitions: Array<{ from: string | null; to: string; at: string }>;
  budgetUsed?: { tokens: number };
  outputTail?: string;
  startedAt?: string;
  updatedAt?: string;
}

export interface CoreSupervision {
  supervisorState: string;
  lastHeartbeatAt: string | null;
  heartbeatHealth: "healthy" | "degraded" | "unresponsive" | "unknown";
  vmMinutesPeriod: number;
  maxVmHoursPerDay: number;
  projectedPeriodCost: number;
  tokenUsed: number;
  tokenAllowance: number;
}

export interface CoreEvent {
  id: string;
  eventType: string;
  payload: Record<string, unknown>;
  ts: string;
}

export interface UseCoreDeploymentResult {
  tasks: CoreTask[];
  supervision: CoreSupervision | null;
  events: CoreEvent[];
  loading: boolean;
  error: string | null;
  refetch: () => void;
  cancelTask: (taskId: string) => Promise<boolean>;
  resumeTask: (taskId: string, response: { action: string; input?: string }) => Promise<boolean>;
  stopDeployment: () => Promise<boolean>;
  startDeployment: () => Promise<boolean>;
}

const apiBase = DEPLOYMENT_API_URL.replace(/\/+$/, "");

export function useCoreDeployment(deploymentId: string): UseCoreDeploymentResult {
  const [tasks, setTasks] = useState<CoreTask[]>([]);
  const [supervision, setSupervision] = useState<CoreSupervision | null>(null);
  const [events, setEvents] = useState<CoreEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  const refetch = useCallback(() => setRefreshKey((k) => k + 1), []);

  useEffect(() => {
    if (!deploymentId) return;
    let cancelled = false;

    const fetchData = async () => {
      try {
        const [tasksRes, supervRes, eventsRes] = await Promise.allSettled([
          authFetch(`${apiBase}/v1/core/${deploymentId}/tasks`),
          authFetch(`${apiBase}/v1/core/${deploymentId}/supervision`),
          authFetch(`${apiBase}/v1/core/${deploymentId}/events?limit=50`),
        ]);

        if (cancelled) return;

        if (tasksRes.status === "fulfilled" && tasksRes.value.ok) {
          const data = await tasksRes.value.json();
          setTasks(data.tasks || []);
        }

        if (supervRes.status === "fulfilled" && supervRes.value.ok) {
          const data = await supervRes.value.json();
          setSupervision(data);
        }

        if (eventsRes.status === "fulfilled" && eventsRes.value.ok) {
          const data = await eventsRes.value.json();
          setEvents(data.events || []);
        }

        setError(null);
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchData();
    const interval = setInterval(fetchData, 15000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [deploymentId, refreshKey]);

  const cancelTask = useCallback(async (taskId: string) => {
    const res = await authFetch(`${apiBase}/v1/core/${deploymentId}/tasks/${taskId}/cancel`, { method: "POST" });
    if (res.ok) refetch();
    return res.ok;
  }, [deploymentId, refetch]);

  const resumeTask = useCallback(async (taskId: string, response: { action: string; input?: string }) => {
    const res = await authFetch(`${apiBase}/v1/core/${deploymentId}/tasks/${taskId}/resume`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
    if (res.ok) refetch();
    return res.ok;
  }, [deploymentId, refetch]);

  const stopDeployment = useCallback(async () => {
    const res = await authFetch(`${apiBase}/v1/core/${deploymentId}/stop`, { method: "POST" });
    if (res.ok) refetch();
    return res.ok;
  }, [deploymentId, refetch]);

  const startDeployment = useCallback(async () => {
    const res = await authFetch(`${apiBase}/v1/core/${deploymentId}/start`, { method: "POST" });
    if (res.ok) refetch();
    return res.ok;
  }, [deploymentId, refetch]);

  return { tasks, supervision, events, loading, error, refetch, cancelTask, resumeTask, stopDeployment, startDeployment };
}
