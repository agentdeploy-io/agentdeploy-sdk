/**
 * OperationsSection — /operations
 * ───────────────────────────────
 * The operator's "is it running, and can I steer it?" screen for the
 * data plane (bi-edge). Four live panels, all editable at runtime —
 * no restart, no redeploy:
 *
 *   a. Pipeline     pause/resume the whole agent (start/stop the crawler)
 *                   + run a crawl on demand + crawler health (CORE_URL,
 *                   last crawl run)
 *   b. Schedules    the four cron schedules — edit the expression, enable/
 *                   disable, run-now, see the last run. Stored in the
 *                   engine DB; the DO alarm tick picks changes up ≤5 min.
 *   c. Sending      dryRun / sendEnabled / dailyCap + Brevo key status
 *   d. Activity     recent sends (sent log) + pending reply-draft count
 *
 * Graceful degradation: no deployment selected → honest empty state;
 * engine 4xx/5xx → panel shows the error + Retry. Nothing throws into
 * render.
 */

import * as React from "react";
import {
  AlertTriangle,
  Bot,
  CalendarClock,
  CheckCircle2,
  Pause,
  Play,
  RefreshCw,
  Send,
  Square,
  Timer,
  Zap,
} from "lucide-react";
import { Badge, Button, Card, Skeleton } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { authFetch, toast, useDeploymentSelector, useRuns } from "@/hooks";

interface CrawlRunEntry {
  id: string;
  trigger: string;
  started_at?: string;
  startedAt?: string;
  state: string;
  stats?: Record<string, unknown>;
}
import { CRON_PRESETS, cronToHumanReadable, validateCron } from "@/lib/cron";
import { relativeTime } from "@/lib/utils";

// ─── Types (engine GET /cmd/schedules contract) ──────────────────

interface OpSchedule {
  name: string;
  description: string;
  cron: string;
  defaultCron: string;
  enabled: boolean;
  lastRun: string | null;
}

interface OpSecrets {
  [key: string]: boolean;
}

interface SentEntry {
  id: number;
  lead_key: string;
  email: string;
  subject: string;
  message_id: string | null;
  status: string;
  at: string;
}

function proxyBase(deploymentId: string): string {
  return `/d/${deploymentId}`;
}

// ─── Panel shell (same convention as ReportsSection) ─────────────

function Panel({
  title,
  icon,
  subtitle,
  action,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  subtitle?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <div className="mb-3 flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">{subtitle}</p>
            )}
          </div>
        </div>
        {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Card>
  );
}

function ErrorNote({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
      <AlertTriangle className="size-4 shrink-0" />
      <span className="min-w-0 flex-1">{message}</span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}

// ─── Schedule row with local edit state ──────────────────────────

function ScheduleRow({
  schedule,
  deploymentId,
  onSaved,
  onRunNow,
}: {
  schedule: OpSchedule;
  deploymentId: string;
  onSaved: () => void;
  onRunNow: (name: string) => Promise<void>;
}) {
  const [cron, setCron] = React.useState(schedule.cron);
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [cronError, setCronError] = React.useState<string | null>(null);

  React.useEffect(() => setCron(schedule.cron), [schedule.cron]);

  const dirty = cron !== schedule.cron;

  const save = async () => {
    if (!validateCron(cron)) {
      setCronError("Invalid cron expression (5 fields: min hour dom month dow)");
      return;
    }
    setCronError(null);
    setSaving(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: schedule.name, cron: cron.trim() }),
        signal: AbortSignal.timeout(10000),
      });
      const json = (await res.json()) as { error?: string };
      if (!res.ok) throw new Error(json.error ?? `${res.status}`);
      toast.success("Schedule updated", `${schedule.name} now runs on "${cron.trim()}" — effective within one tick, no restart.`);
      onSaved();
    } catch (err) {
      toast.error("Schedule update failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: schedule.name, enabled: !schedule.enabled }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(schedule.enabled ? "Schedule disabled" : "Schedule enabled", schedule.name);
      onSaved();
    } catch (err) {
      toast.error("Toggle failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const runNow = async () => {
    setRunning(true);
    try {
      await onRunNow(schedule.name);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-canvas px-3 py-2.5 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[0.8125rem] font-semibold text-foreground">{schedule.name}</span>
          {!schedule.enabled && <Badge variant="muted">disabled</Badge>}
        </div>
        <div className="mt-0.5 text-[0.6875rem] text-muted-foreground">
          {cronToHumanReadable(schedule.cron)} · last run {schedule.lastRun ? relativeTime(schedule.lastRun) : "never"}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={cron}
          onChange={(e) => {
            setCron(e.target.value);
            setCronError(null);
          }}
          list="cron-presets"
          spellCheck={false}
          aria-label={`cron for ${schedule.name}`}
          className="h-8 w-36 rounded-md border border-border-strong bg-background px-2 font-mono text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
        />
        <Button size="sm" variant="outline" onClick={toggleEnabled} disabled={saving} aria-pressed={schedule.enabled}>
          {schedule.enabled ? "Disable" : "Enable"}
        </Button>
        <Button size="sm" variant={dirty ? "default" : "outline"} onClick={save} disabled={!dirty || saving}>
          {saving ? "…" : "Save"}
        </Button>
        <Button size="sm" variant="ghost" onClick={runNow} disabled={running || !schedule.enabled}>
          {running ? "Running…" : "Run now"}
        </Button>
      </div>
      {cronError && <p className="text-[0.6875rem] text-destructive">{cronError}</p>}
    </div>
  );
}

// ─── Page ────────────────────────────────────────────────────────

export function OperationsSection({ onNavigate }: { onNavigate: (path: string) => void }) {
  const { deploymentId } = useDeploymentSelector();

  const [schedules, setSchedules] = React.useState<OpSchedule[] | null>(null);
  const [paused, setPaused] = React.useState(false);
  const [schedulesError, setSchedulesError] = React.useState<string | null>(null);
  const [schedulesLoading, setSchedulesLoading] = React.useState(true);

  const [secrets, setSecrets] = React.useState<OpSecrets | null>(null);

  const [settings, setSettings] = React.useState<Record<string, string> | null>(null);
  const [capInput, setCapInput] = React.useState("");
  const [settingsBusy, setSettingsBusy] = React.useState(false);

  const [sent, setSent] = React.useState<SentEntry[] | null>(null);
  const [pendingDrafts, setPendingDrafts] = React.useState<number | null>(null);
  const [funnel, setFunnel] = React.useState<Array<{ stage: string; count: number }> | null>(null);
  const { runs, loading: runsLoading, refetch: refetchRuns } = useRuns(deploymentId) as {
    runs: CrawlRunEntry[];
    loading: boolean;
    refetch: () => void;
  };

  const loadAll = React.useCallback(async () => {
    if (!deploymentId) return;
    setSchedulesLoading(true);
    setSchedulesError(null);
    try {
      const [schedRes, sentRes, repliesRes, secretsRes, settingsRes, pipelineRes] = await Promise.all([
        authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, { signal: AbortSignal.timeout(10000) }),
        authFetch(`${proxyBase(deploymentId)}/cmd/sent?limit=20`, { signal: AbortSignal.timeout(10000) }),
        authFetch(`${proxyBase(deploymentId)}/cmd/replies?status=pending`, { signal: AbortSignal.timeout(10000) }),
        authFetch(`${proxyBase(deploymentId)}/cmd/secrets`, { signal: AbortSignal.timeout(10000) }),
        authFetch(`${proxyBase(deploymentId)}/cmd/settings`, { signal: AbortSignal.timeout(10000) }),
        authFetch(`${proxyBase(deploymentId)}/cmd/pipeline`, { signal: AbortSignal.timeout(10000) }),
      ]);
      if (schedRes.ok) {
        const j = (await schedRes.json()) as { schedules: OpSchedule[]; paused: boolean };
        setSchedules(j.schedules ?? []);
        setPaused(!!j.paused);
      } else {
        setSchedulesError(`Schedules: ${schedRes.status}`);
      }
      if (sentRes.ok) {
        const j = (await sentRes.json()) as { sent: SentEntry[] };
        setSent(j.sent ?? []);
      }
      if (repliesRes.ok) {
        const j = (await repliesRes.json()) as { replies: unknown[] };
        setPendingDrafts(j.replies?.length ?? 0);
      }
      if (secretsRes.ok) {
        const j = (await secretsRes.json()) as { secrets: OpSecrets };
        setSecrets(j.secrets ?? {});
      }
      if (settingsRes.ok) {
        const j = (await settingsRes.json()) as { settings: Record<string, string>; defaults: Record<string, unknown> };
        setSettings(j.settings ?? {});
        setCapInput(String(j.settings?.dailyCap ?? j.defaults?.dailyCap ?? "10"));
      }
      if (pipelineRes.ok) {
        const j = (await pipelineRes.json()) as { funnel?: Array<{ stage: string; count: number }> };
        setFunnel(j.funnel ?? []);
      }
    } catch (err) {
      setSchedulesError(err instanceof Error ? err.message : "Failed to load operations state");
    } finally {
      setSchedulesLoading(false);
    }
  }, [deploymentId]);

  React.useEffect(() => {
    loadAll();
  }, [loadAll]);

  const lastRun: CrawlRunEntry | undefined = runs[0];
  const lastRunAt = lastRun?.started_at ?? lastRun?.startedAt ?? null;
  const coreConfigured = !!secrets?.CORE_URL;

  const setPausedState = async (value: boolean) => {
    if (!deploymentId) return;
    setSettingsBusy(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: String(value) }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setPaused(value);
      toast.success(
        value ? "Pipeline stopped" : "Pipeline started",
        value ? "Crawler and all schedules are paused." : "Schedules resume on their next due tick.",
      );
    } catch (err) {
      toast.error("Failed to update pipeline state", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSettingsBusy(false);
    }
  };

  const setSendSetting = async (key: string, value: string) => {
    if (!deploymentId) return;
    setSettingsBusy(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [key]: value }),
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      setSettings((prev) => ({ ...(prev ?? {}), [key]: value }));
    } catch (err) {
      toast.error("Failed to update setting", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSettingsBusy(false);
    }
  };

  const runNow = async (name: string) => {
    if (!deploymentId) return;
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules/${encodeURIComponent(name)}/run`, {
        method: "POST",
        signal: AbortSignal.timeout(180_000),
      });
      const json = (await res.json()) as { error?: string; result?: Record<string, unknown> };
      if (!res.ok) throw new Error(json.error ?? `${res.status}`);
      const state = json.result?.state as string | undefined;
      toast.success(
        `${name} run triggered`,
        state ? `State: ${state}` : "Run started.",
      );
      setTimeout(() => {
        loadAll();
        refetchRuns();
      }, 3000);
    } catch (err) {
      toast.error(`${name} run failed`, err instanceof Error ? err.message : "Unknown error");
    }
  };

  if (!deploymentId) {
    return (
      <div className="p-6">
        <EmptyState
          icon={<Bot className="size-6 text-muted-foreground" />}
          title="No deployment selected"
          message="Select a deployment in the top bar to operate its engine."
        />
      </div>
    );
  }

  const dryRun = settings?.dryRun === "true";
  const sendEnabled = settings?.sendEnabled === "true";

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-4 p-4 sm:p-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-lg font-bold text-foreground">Operations</h1>
          <p className="text-[0.8125rem] text-muted-foreground">
            Steer the data plane — schedules, crawler and sending change live, no restart.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Badge variant={paused ? "warning" : "success"}>
            {paused ? "Paused" : "Running"}
          </Badge>
          <Button variant="outline" size="sm" onClick={loadAll}>
            <RefreshCw className={schedulesLoading ? "animate-spin" : ""} />
            Refresh
          </Button>
        </div>
      </div>

      {/* ── Pipeline / crawler ─────────────────────────────── */}
      <Panel
        title="Pipeline"
        icon={<Bot className="size-4" />}
        subtitle="Start/stop the whole agent — pause halts the crawler and every schedule."
        action={
          paused ? (
            <Button size="sm" variant="success" onClick={() => setPausedState(false)} disabled={settingsBusy}>
              <Play /> Start pipeline
            </Button>
          ) : (
            <Button size="sm" variant="destructive" onClick={() => setPausedState(true)} disabled={settingsBusy}>
              <Square /> Stop pipeline
            </Button>
          )
        }
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => runNow("crawl")}
              disabled={paused}
              title={paused ? "Pipeline is stopped — start it first" : "Trigger a crawl now"}
            >
              <Zap /> Run crawl now
            </Button>
            <span className="text-[0.8125rem] text-muted-foreground">
              Crawler (bi-core){" "}
              {coreConfigured === false ? (
                <Badge variant="error" className="ml-1">CORE_URL not configured</Badge>
              ) : (
                <Badge variant={coreConfigured ? "success" : "muted"} className="ml-1">
                  {coreConfigured ? "CORE_URL set" : "checking…"}
                </Badge>
              )}
            </span>
          </div>
          {lastRun && lastRunAt && (
            <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-canvas px-3 py-2 text-[0.8125rem]">
              <CalendarClock className="size-4 text-muted-foreground" />
              <span className="text-foreground">Last crawl {relativeTime(lastRunAt)}</span>
              <Badge
                variant={
                  lastRun.state === "succeeded" || lastRun.state === "completed"
                    ? "success"
                    : lastRun.state === "running"
                      ? "info"
                      : lastRun.state === "skipped"
                        ? "muted"
                        : "error"
                }
              >
                {lastRun.state}
              </Badge>
            </div>
          )}
          {runsLoading && <Skeleton className="h-9 w-full" />}
          {funnel && (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-surface-canvas px-3 py-2 text-[0.75rem] text-muted-foreground">
              <span className="font-medium text-foreground">Pipeline:</span>
              {funnel.map((f) => (
                <span key={f.stage} className="whitespace-nowrap">
                  {f.stage} <b className="text-foreground tabular-nums">{f.count}</b>
                </span>
              ))}
            </div>
          )}
          {paused && (
            <p className="text-[0.6875rem] text-warning">
              Pipeline stopped — schedules are armed but will not fire until you start it.
            </p>
          )}
        </div>
      </Panel>

      {/* ── Schedules ──────────────────────────────────────── */}
      <Panel
        title="Schedules"
        icon={<Timer className="size-4" />}
        subtitle="Cron expressions (UTC). Presets appear as you type in a cron field. Changes apply within one 5-minute tick — no restart, no redeploy."
      >
        <datalist id="cron-presets">
          {CRON_PRESETS.map((p) => (
            <option key={p.value} value={p.value}>
              {p.label}
            </option>
          ))}
        </datalist>
        <div className="flex flex-col gap-2">
          {schedulesLoading && <Skeleton className="h-14 w-full" />}
          {schedulesError && <ErrorNote message={schedulesError} onRetry={loadAll} />}
          {!schedulesLoading && !schedulesError && schedules?.length === 0 && (
            <p className="text-[0.8125rem] text-muted-foreground">No schedules found.</p>
          )}
          {schedules?.map((s) => (
            <ScheduleRow key={s.name} schedule={s} deploymentId={deploymentId} onSaved={loadAll} onRunNow={runNow} />
          ))}
        </div>
      </Panel>

      {/* ── Sending ────────────────────────────────────────── */}
      <Panel
        title="Sending"
        icon={<Send className="size-4" />}
        subtitle="Brevo outbound. Dry-run logs emails without sending anything."
      >
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              variant={dryRun ? "default" : "outline"}
              onClick={() => setSendSetting("dryRun", String(!dryRun))}
              disabled={settingsBusy}
              aria-pressed={dryRun}
            >
              {dryRun ? "Dry-run ON" : "Dry-run OFF"}
            </Button>
            <Button
              size="sm"
              variant={sendEnabled ? "success" : "outline"}
              onClick={() => setSendSetting("sendEnabled", String(!sendEnabled))}
              disabled={settingsBusy}
              aria-pressed={sendEnabled}
            >
              {sendEnabled ? "Sending ENABLED" : "Sending disabled"}
            </Button>
            <label className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
              Daily cap
              <input
                value={capInput}
                onChange={(e) => setCapInput(e.target.value)}
                onBlur={() => {
                  const n = Number(capInput);
                  if (Number.isInteger(n) && n > 0 && String(n) !== (settings?.dailyCap ?? "10")) {
                    setSendSetting("dailyCap", String(n));
                  }
                }}
                aria-label="daily send cap"
                className="h-8 w-16 rounded-md border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              />
            </label>
            <span className="text-[0.8125rem] text-muted-foreground">
              Brevo API key{" "}
              {secrets === null ? (
                "…"
              ) : secrets.BREVO_API_KEY ? (
                <Badge variant="success">configured</Badge>
              ) : (
                <Badge variant="error">missing</Badge>
              )}
            </span>
          </div>
          {dryRun && (
            <p className="text-[0.6875rem] text-warning">
              Dry-run is ON — outbound emails are only logged, nothing is delivered.
            </p>
          )}
          {!dryRun && !sendEnabled && (
            <p className="text-[0.6875rem] text-warning">
              Dry-run is OFF but sending is disabled — emails will be blocked by the gate stack.
            </p>
          )}
        </div>
      </Panel>

      {/* ── Activity ───────────────────────────────────────── */}
      <Panel
        title="Recent activity"
        icon={<CheckCircle2 className="size-4" />}
        subtitle="Latest sends and reply drafts awaiting you."
        action={
          pendingDrafts !== null && pendingDrafts > 0 ? (
            <Button size="sm" variant="outline" onClick={() => onNavigate("/inbox")}>
              {pendingDrafts} draft{pendingDrafts === 1 ? "" : "s"} to review →
            </Button>
          ) : undefined
        }
      >
        {sent === null ? (
          <Skeleton className="h-24 w-full" />
        ) : sent.length === 0 ? (
          <p className="text-[0.8125rem] text-muted-foreground">
            Nothing sent yet. Approve a lead in Data, then run a send.
          </p>
        ) : (
          <div className="scrollbar-thin -mx-1 overflow-x-auto px-1">
            <table className="w-full min-w-[540px] text-left text-[0.8125rem]">
              <thead>
                <tr className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground">
                  <th className="pb-2 pr-3 font-medium">When</th>
                  <th className="pb-2 pr-3 font-medium">Lead</th>
                  <th className="pb-2 pr-3 font-medium">To</th>
                  <th className="pb-2 pr-3 font-medium">Subject</th>
                  <th className="pb-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {sent.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{relativeTime(e.at)}</td>
                    <td className="max-w-40 truncate py-1.5 pr-3 text-foreground">{e.lead_key}</td>
                    <td className="max-w-44 truncate py-1.5 pr-3 text-muted-foreground">{e.email}</td>
                    <td className="max-w-56 truncate py-1.5 pr-3 text-foreground">{e.subject}</td>
                    <td className="py-1.5">
                      <Badge variant={e.status === "sent" ? "success" : "info"}>{e.status}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </div>
  );
}
