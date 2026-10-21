import { useState, useEffect, useCallback, useRef } from "react";
import { authFetch } from "@/hooks/useAuthFetch";
import { toast } from "@/hooks/useToast";

// ─── Types ───────────────────────────────────────────────────────

export interface DataFilters {
  search?: string;
  stage?: string[];
  country?: string[];
  tier?: string[];
  status?: string[];
  website_status?: string[];
}

export interface DataPage<T = Record<string, unknown>> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface PipelineStage {
  name: string;
  count: number;
  delta24h: number;
}

export interface PipelineData {
  stages: PipelineStage[];
}

export interface RunEntry {
  id: string;
  trigger: string;
  startedAt: string;
  duration: number;
  vmMinutes: number;
  tokens: number;
  cost: number;
  stats: Record<string, number>;
  state: "running" | "completed" | "failed" | "cancelled";
}

export interface PipelineStatus {
  nextRun: string | null;
  lastRun: string | null;
  cronExpression: string | null;
  lastFailure: string | null;
}

export interface ImportDryRun {
  totalRows: number;
  newRows: number;
  updatedRows: number;
  errors: string[];
  preview: Record<string, unknown>[];
}

export interface ScheduleEntry {
  id: string;
  name: string;
  cron: string;
  enabled: boolean;
  lastRun: string | null;
  lastStatus: "success" | "failed" | null;
  runCount: number;
  successCount: number;
  avgDurationMs: number;
  avgCostUsd: number;
  history: { date: string; success: number; failed: number }[];
}

export interface WireTopology {
  agents: Array<{
    id: string;
    name: string;
    icon: string;
    runtime: string;
    health: string;
    state: string;
    lastHeartbeat: number;
    costToday: number;
    group: string;
  }>;
  connections: Array<{
    from: string;
    to: string;
    label: string;
    active: boolean;
  }>;
  events?: Array<{
    id: string;
    time: number;
    type: string;
    message: string;
    duration: string;
  }>;
}

export interface SettingsData {
  paused: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
  dailyCap: number;
  countries: string[];
  [key: string]: unknown;
}

export interface SecretEntry {
  key: string;
  configured: boolean;
  category?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────

function proxyBase(deploymentId: string): string {
  return `/d/${deploymentId}`;
}

function handleNetworkError(context: string, err: unknown) {
  const msg = err instanceof Error ? err.message : `${context} failed`;
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError") || msg.includes("timeout")) {
    toast.error("Network Error", `${context}: ${msg}`);
  }
}

// ─── useLeads ────────────────────────────────────────────────────

export function useLeads(
  filters: DataFilters,
  page: number,
  pageSize: number,
  deploymentId?: string,
) {
  const [data, setData] = useState<DataPage>({ rows: [], total: 0, page, pageSize });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const cancelRef = useRef(false);
  const [nonce, setNonce] = useState(0);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
    // Bump the nonce — the effect below depends on it, so the same
    // page/filters actually re-fire the request.
    setNonce((n) => n + 1);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setData({ rows: [], total: 0, page, pageSize });
      setLoading(false);
      return;
    }

    cancelRef.current = false;
    setLoading(true);

    const params = new URLSearchParams();
    params.set("page", String(page));
    params.set("pageSize", String(pageSize));
    if (filters.search) params.set("search", filters.search);
    if (filters.stage?.length) params.set("stage", filters.stage.join(","));
    if (filters.country?.length) params.set("country", filters.country.join(","));
    if (filters.tier?.length) params.set("tier", filters.tier.join(","));
    if (filters.status?.length) params.set("status", filters.status.join(","));
    if (filters.website_status?.length) params.set("website_status", filters.website_status.join(","));

    authFetch(`${proxyBase(deploymentId)}/cmd/data?${params}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(15000),
    })
      .then(async (res) => {
        if (cancelRef.current) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setData({ rows: json.rows ?? [], total: json.total ?? 0, page, pageSize });
        setError(null);
      })
      .catch((err) => {
        if (cancelRef.current) return;
        setError(err instanceof Error ? err.message : "Failed to load data");
        handleNetworkError("Load data", err);
      })
      .finally(() => {
        if (!cancelRef.current) setLoading(false);
      });

    return () => { cancelRef.current = true; };
  }, [page, pageSize, filters, deploymentId, nonce]);

  return { data, loading, error, refetch };
}

// ─── useLeadDetail ───────────────────────────────────────────────

export function useLeadDetail(key: string | null, deploymentId?: string) {
  const [detail, setDetail] = useState<Record<string, unknown> | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!key || !deploymentId) {
      setDetail(null);
      return;
    }

    let cancelled = false;
    setLoading(true);
    setError(null);

    authFetch(`${proxyBase(deploymentId)}/cmd/data/row?key=${encodeURIComponent(key)}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setDetail(json);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load detail");
        handleNetworkError("Load detail", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [key, deploymentId]);

  return { detail, loading, error };
}

// ─── useUpdateLead ───────────────────────────────────────────────

export function useUpdateLead(deploymentId?: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(async (key: string, patch: Record<string, unknown>) => {
    if (!deploymentId) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/data/row`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, ...patch }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Update failed");
      handleNetworkError("Update lead", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  return { update, loading, error };
}

// ─── useBulkAction ───────────────────────────────────────────────

export function useBulkAction(deploymentId?: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * POST /cmd/data/batch — flat body ({keys, ...patch}); the dev proxy shim
   * wraps it into {keys, patch} for the engine. Resolves to the engine's
   * `updated` row count, or null on failure.
   */
  const execute = useCallback(async (keys: string[], patch: Record<string, unknown>): Promise<number | null> => {
    if (!deploymentId) return null;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/data/batch`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ keys, ...patch }),
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = (await res.json().catch(() => null)) as { updated?: unknown } | null;
      return typeof json?.updated === "number" ? json.updated : keys.length;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Bulk action failed");
      handleNetworkError("Bulk action", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  return { execute, loading, error };
}

// ─── useExportCsv ────────────────────────────────────────────────

export function useExportCsv(deploymentId?: string) {
  const [loading, setLoading] = useState(false);

  /**
   * GET /cmd/data/export → blob → browser download.
   * `filename` overrides the default `data-export-{date}.csv` (the Data
   * screen passes `leads-{deploymentId}-{date}.csv`).
   */
  const download = useCallback(async (filters: DataFilters, filename?: string) => {
    if (!deploymentId) return;
    setLoading(true);
    try {
      const params = new URLSearchParams();
      params.set("format", "csv");
      if (filters.search) params.set("search", filters.search);
      if (filters.stage?.length) params.set("stage", filters.stage.join(","));
      if (filters.country?.length) params.set("country", filters.country.join(","));
      if (filters.tier?.length) params.set("tier", filters.tier.join(","));
      if (filters.status?.length) params.set("status", filters.status.join(","));

      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/data/export?${params}`, {
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        filename ?? `data-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      handleNetworkError("Export CSV", err);
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  return { download, loading };
}

// ─── useImportCsv ────────────────────────────────────────────────

export function useImportCsv(deploymentId?: string) {
  const [dryRun, setDryRun] = useState<ImportDryRun | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dryRunImport = useCallback(async (file: File) => {
    if (!deploymentId) return null;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("dryRun", "true");
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/data/import`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(30000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      const json = await res.json();
      setDryRun(json);
      return json;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import dry-run failed");
      handleNetworkError("Import dry-run", err);
      return null;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  const confirmImport = useCallback(async (file: File) => {
    if (!deploymentId) return false;
    setLoading(true);
    setError(null);
    try {
      const form = new FormData();
      form.append("file", file);
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/data/import`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      handleNetworkError("Import", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  const reset = useCallback(() => {
    setDryRun(null);
    setError(null);
  }, []);

  return { dryRunImport, confirmImport, dryRun, loading, error, reset };
}

// ─── usePipeline ─────────────────────────────────────────────────

export function usePipeline(deploymentId?: string) {
  const [data, setData] = useState<PipelineData | null>(null);
  const [status, setStatus] = useState<PipelineStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setData(null);
      setStatus(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/pipeline`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setData(json.data ?? json);
        setStatus(json.status ?? null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load pipeline");
        handleNetworkError("Load pipeline", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  return { data, status, loading, error, refetch };
}

// ─── useRuns ─────────────────────────────────────────────────────

export function useRuns(deploymentId?: string) {
  const [runs, setRuns] = useState<RunEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setRuns([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/runs?limit=20`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setRuns(json.runs ?? json ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load runs");
        handleNetworkError("Load runs", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  return { runs, loading, error, refetch };
}

// ─── useSchedules ────────────────────────────────────────────────

export function useSchedules(deploymentId?: string) {
  const [schedules, setSchedules] = useState<ScheduleEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setSchedules([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setSchedules(json.schedules ?? json ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load schedules");
        handleNetworkError("Load schedules", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  return { schedules, loading, error, refetch };
}

// ─── useScheduleActions ──────────────────────────────────────────

export function useScheduleActions(deploymentId?: string) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createOrUpdate = useCallback(async (schedule: Partial<ScheduleEntry>) => {
    if (!deploymentId) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(schedule),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save schedule failed");
      handleNetworkError("Save schedule", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  const remove = useCallback(async (scheduleId: string) => {
    if (!deploymentId) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules/${encodeURIComponent(scheduleId)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Delete schedule failed");
      handleNetworkError("Delete schedule", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  const runNow = useCallback(async (scheduleId: string) => {
    if (!deploymentId) return false;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules/${encodeURIComponent(scheduleId)}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return true;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Run now failed");
      handleNetworkError("Run schedule", err);
      return false;
    } finally {
      setLoading(false);
    }
  }, [deploymentId]);

  return { createOrUpdate, remove, runNow, loading, error };
}

// ─── useWire ─────────────────────────────────────────────────────

export function useWire(deploymentId?: string) {
  const [data, setData] = useState<WireTopology | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setData(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/wire`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setData(json);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load wire topology");
        handleNetworkError("Load wire", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  return { data, loading, error, refetch };
}

// ─── useSettings ─────────────────────────────────────────────────

export function useSettings(deploymentId?: string) {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setSettings(null);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/settings`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setSettings(json);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load settings");
        handleNetworkError("Load settings", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  const updateSettings = useCallback(async (patch: Partial<SettingsData>) => {
    if (!deploymentId) return false;
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      refetch();
      return true;
    } catch (err) {
      handleNetworkError("Update settings", err);
      return false;
    }
  }, [deploymentId, refetch]);

  return { settings, loading, error, refetch, updateSettings };
}

// ─── useSecrets ──────────────────────────────────────────────────

export function useSecrets(deploymentId?: string) {
  const [secrets, setSecrets] = useState<SecretEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refetch = useCallback(() => {
    setLoading(true);
    setError(null);
  }, []);

  useEffect(() => {
    if (!deploymentId) {
      setSecrets([]);
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);

    authFetch(`${proxyBase(deploymentId)}/cmd/secrets`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    })
      .then(async (res) => {
        if (cancelled) return;
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const json = await res.json();
        setSecrets(json.secrets ?? json ?? []);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "Failed to load secrets");
        handleNetworkError("Load secrets", err);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => { cancelled = true; };
  }, [deploymentId, refetch]);

  const saveSecret = useCallback(async (key: string, value: string) => {
    if (!deploymentId) return false;
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/secrets`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      refetch();
      return true;
    } catch (err) {
      handleNetworkError("Save secret", err);
      return false;
    }
  }, [deploymentId, refetch]);

  return { secrets, loading, error, refetch, saveSecret };
}
