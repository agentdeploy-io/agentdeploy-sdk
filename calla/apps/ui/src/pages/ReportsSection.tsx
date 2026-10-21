/**
 * ReportsSection — Screen G (/reports)
 * ────────────────────────────────────
 * The operator's "is it working?" screen. Five read-only panels, each with
 * its own data source so one dead source never blanks the page:
 *
 *   a. Pipeline funnel      usePipeline      GET /d/{id}/cmd/pipeline
 *   b. Lead sources         useLeads         GET /d/{id}/cmd/data (grouped client-side)
 *   c. Qualification flows  opsClient        GET {brain}/flows/runs
 *   d. Appointments         opsClient        GET {brain}/booking/appointments
 *   e. Recent engine runs   useRuns          GET /d/{id}/cmd/runs
 *
 * Graceful degradation is the whole design constraint here:
 *   - no deployment selected → engine panels show an honest empty state
 *   - engine 4xx/5xx         → panel shows the error string + Retry
 *   - brain disabled/404/down → flows panel shows a muted "Brain not
 *                               connected" note; the appointments panel hides
 *                               itself entirely (it is best-effort by nature)
 * Lead identities in the flows panel are masked — this screen is for
 * throughput, not for reading contact data (that's /data).
 */

import * as React from "react";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  BarChart3,
  CalendarClock,
  CalendarDays,
  Clock,
  ExternalLink,
  Gauge,
  History,
  Minus,
  RefreshCw,
  Unplug,
  User,
  Users,
  Workflow,
} from "lucide-react";
import { EmptyState } from "@/components/shared";
import { STATUS_BADGE_VARIANT } from "@/components/data";
import { Badge, Button, Card, Dialog, Skeleton } from "@/components/ui";
import {
  useDeploymentSelector,
  useLeads,
  usePipeline,
  useRuns,
  type DataFilters,
  type PipelineData,
  type PipelineStatus,
} from "@/hooks";
import {
  conversationsClient,
  type ConversationFlowRun,
  type ConversationsResult,
} from "@/lib/conversations-client";
import { cronToHumanReadable } from "@/lib/cron";
import {
  opsClient,
  asRecord,
  firstNumber,
  firstString,
  type Appointment,
  type FlowRun,
  type OpsResult,
} from "@/lib/ops-client";
import { cn, formatDublinTime, humanizeFieldName, relativeTime, timeUntil } from "@/lib/utils";

// ─── Constants ───────────────────────────────────────────────────

/** bi-engine stage order — unknown stages sort after these, in arrival order. */
const FUNNEL_ORDER = [
  "raw",
  "verified",
  "classified",
  "researched",
  "approved",
  "sent",
  "replied",
];

/** Same broad fetch DataSection uses — sources/statuses are grouped locally. */
const LEAD_FETCH_PAGE_SIZE = 500;
/** Source bars before the tail collapses into "other". */
const MAX_SOURCE_BARS = 6;
/** Statuses the lead-source panel always chips, even at zero. */
const CORE_LEAD_STATUSES = ["pending_review", "approved", "sent", "rejected"];

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DONE_FLOW_STATUSES = new Set(["completed", "complete", "done", "succeeded", "success"]);
const DEAD_FLOW_STATUSES = new Set([
  "failed",
  "error",
  "cancelled",
  "canceled",
  "expired",
  "abandoned",
]);
/** Flow runs requested per read — the weekly summary is bounded by this. */
const FLOW_FETCH_LIMIT = 200;
const MAX_FLOW_ROWS = 8;
const MAX_APPOINTMENT_ROWS = 8;
const MAX_RUN_ROWS = 10;

/** Timezone the booking calendar is operated in. */
const REPORT_TZ = "Europe/Dublin";

// ─── Small helpers ───────────────────────────────────────────────

function tsOf(value: string): number {
  const t = Date.parse(value);
  return Number.isNaN(t) ? 0 : t;
}

/** Lead keys / chat refs are shown masked — throughput, not contact data. */
function maskIdentifier(value: string): string {
  if (value.length <= 4) return "•".repeat(Math.max(value.length, 3));
  const dots = "•".repeat(Math.min(6, Math.max(3, value.length - 4)));
  return `${value.slice(0, 2)}${dots}${value.slice(-2)}`;
}

let dublinFormatter: Intl.DateTimeFormat | null = null;

/** e.g. "Mon, 06 Oct 2025, 14:30" — always in Europe/Dublin. */
function formatDublin(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso || "-";
  try {
    dublinFormatter ??= new Intl.DateTimeFormat("en-IE", {
      timeZone: REPORT_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return dublinFormatter.format(date);
  } catch {
    // Runtime without the tz database — honest local time beats a crash.
    return date.toLocaleString();
  }
}

function pct(part: number, total: number): number {
  if (total <= 0) return 0;
  return Math.round((part / total) * 100);
}

/** Bar width — a non-zero count always shows a visible sliver. */
function barWidth(count: number, max: number): number {
  if (max <= 0 || count <= 0) return 0;
  return Math.max(2, Math.round((count / max) * 100));
}

// ─── Funnel normalization ────────────────────────────────────────

export interface FunnelStage {
  name: string;
  count: number;
  delta24h: number | null;
}

/**
 * The engine's /cmd/pipeline shape is not stable across builds: the hook
 * types `{stages:[{name,count,delta24h}]}`, bi-edge returns
 * `{stages:{raw:n,…}, funnel:[{stage,count}], total}`. Accept every variant
 * so the funnel renders whatever the connected engine actually reports.
 */
export function normalizeStages(data: PipelineData | null): FunnelStage[] {
  if (!data) return [];
  const rec = asRecord(data);
  const byName = new Map<string, FunnelStage>();

  const add = (name: string, count: number, delta: number | null) => {
    const key = name.trim().toLowerCase();
    if (!key) return;
    const existing = byName.get(key);
    if (existing) {
      existing.count = Math.max(existing.count, count);
      if (existing.delta24h === null) existing.delta24h = delta;
      return;
    }
    byName.set(key, { name: key, count, delta24h: delta });
  };

  const consumeList = (list: unknown[]) => {
    for (const item of list) {
      const row = asRecord(item);
      const name = firstString(row.name, row.stage, row.id);
      if (!name) continue;
      add(
        name,
        firstNumber(row.count, row.total, row.value) ?? 0,
        firstNumber(row.delta24h, row.delta_24h, row.delta) ?? null,
      );
    }
  };

  const stages = rec.stages;
  if (Array.isArray(stages)) {
    consumeList(stages);
  } else if (stages && typeof stages === "object") {
    for (const [name, value] of Object.entries(asRecord(stages))) {
      const row = asRecord(value);
      add(name, firstNumber(value, row.count, row.total) ?? 0, firstNumber(row.delta24h, row.delta_24h) ?? null);
    }
  }
  if (Array.isArray(rec.funnel)) consumeList(rec.funnel);

  const rank = (name: string) => {
    const i = FUNNEL_ORDER.indexOf(name);
    return i === -1 ? FUNNEL_ORDER.length : i;
  };
  // Stable sort — unknown stages keep their arrival order after the funnel.
  return Array.from(byName.values()).sort((a, b) => rank(a.name) - rank(b.name));
}

// ─── Shared panel chrome ─────────────────────────────────────────

const Panel: React.FC<{
  title: string;
  icon: React.ReactNode;
  subtitle?: string;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, icon, subtitle, action, className, children }) => (
  <Card className={cn("flex flex-col p-4 sm:p-5", className)}>
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="flex min-w-0 items-start gap-2.5">
        <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
          {icon}
        </span>
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
          {subtitle && (
            <p className="mt-0.5 text-[0.6875rem] leading-snug text-muted-foreground">
              {subtitle}
            </p>
          )}
        </div>
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
    <div className="min-w-0 flex-1">{children}</div>
  </Card>
);

const PanelSkeleton: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="space-y-2.5">
    {Array.from({ length: rows }).map((_, i) => (
      <Skeleton key={i} className="h-7 w-full" />
    ))}
  </div>
);

const InlineError: React.FC<{ message: string; onRetry: () => void }> = ({ message, onRetry }) => (
  <div className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
    <span className="min-w-0 flex-1">{message}</span>
    <Button variant="outline" size="sm" onClick={onRetry}>
      <RefreshCw className="size-3.5" />
      Retry
    </Button>
  </div>
);

/** Muted, non-alarming note for a brain surface that isn't there. */
const BrainOfflineNote: React.FC<{
  result: OpsResult<unknown> | null;
  onRetry: () => void;
}> = ({ result, onRetry }) => {
  const detail = !result
    ? "Waiting for the brain…"
    : result.disabled
      ? "BRAIN_URL is not configured on this console."
      : result.status === 404
        ? "This brain build doesn't expose the endpoint yet."
        : (result.error ?? "The brain didn't answer.");

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-canvas px-3 py-2.5">
      <Unplug className="size-4 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1">
        <span className="block text-[0.8125rem] font-medium text-body">Brain not connected</span>
        <span className="block truncate text-[0.6875rem] text-muted-foreground">{detail}</span>
      </span>
      <Button variant="ghost" size="sm" onClick={onRetry}>
        <RefreshCw className="size-3.5" />
        Retry
      </Button>
    </div>
  );
};

/** Plain read-only table (DataGrid's selection chrome would be noise here). */
const SimpleTable: React.FC<{
  head: React.ReactNode[];
  children: React.ReactNode;
  minWidth?: string;
}> = ({ head, children, minWidth = "520px" }) => (
  <div className="scrollbar-thin -mx-1 overflow-x-auto px-1">
    <table className="w-full border-collapse text-left text-xs" style={{ minWidth }}>
      <thead>
        <tr className="border-b border-border text-[0.625rem] uppercase tracking-[0.05em] text-faint">
          {head.map((cell, i) => (
            <th key={i} className="whitespace-nowrap py-1.5 pr-3 font-semibold last:pr-0">
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  </div>
);

const DeltaBadge: React.FC<{ delta: number | null }> = ({ delta }) => {
  if (delta === null) return null;
  if (delta === 0) {
    return (
      <Badge variant="muted" className="gap-0.5 tabular-nums">
        <Minus className="size-3" />0 24h
      </Badge>
    );
  }
  const up = delta > 0;
  return (
    <Badge variant={up ? "success" : "error"} className="gap-0.5 tabular-nums">
      {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}
      {up ? "+" : ""}
      {delta.toLocaleString()} 24h
    </Badge>
  );
};

const CountBar: React.FC<{ label: React.ReactNode; count: number; width: number }> = ({
  label,
  count,
  width,
}) => (
  <div className="space-y-1">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="flex min-w-0 items-center gap-2 font-medium text-foreground">{label}</span>
      <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
        {count.toLocaleString()}
      </span>
    </div>
    <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
      <div
        className="h-full rounded-full bg-primary/75 transition-[width] duration-300"
        style={{ width: `${width}%` }}
      />
    </div>
  </div>
);

const NoDeploymentNote: React.FC = () => (
  <EmptyState
    className="px-2 py-6"
    icon={<BarChart3 className="size-6 text-muted-foreground" />}
    title="No deployment selected"
    message="Pick a deployment in the Fleet to load its funnel, leads and runs."
  />
);

// ─── Flow-run detail dialog ──────────────────────────────────────

/** Proposed slots arrive as ISO strings or {start|startTime} objects. */
function formatSlot(slot: unknown): string {
  if (typeof slot === "string" || typeof slot === "number") return formatDublinTime(slot);
  if (slot && typeof slot === "object") {
    const rec = slot as Record<string, unknown>;
    const value = rec.start ?? rec.startTime ?? rec.start_time ?? rec.value;
    if (typeof value === "string" || typeof value === "number") return formatDublinTime(value);
    return JSON.stringify(slot);
  }
  return String(slot);
}

function answerText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Read-only drill-down for one qualification flow run: Q&A transcript,
 * score/tier, routing and the lead link. Data comes from the brain's
 * GET /flows/runs/:id via conversationsClient (never throws — an older
 * brain shows the honest offline note instead).
 */
const FlowRunDialog: React.FC<{
  runId: string | null;
  result: ConversationsResult<ConversationFlowRun> | null;
  loading: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
}> = ({ runId, result, loading, onClose, onNavigate }) => {
  const run = result?.data;
  const answers = run ? Object.entries(run.answers) : [];
  const routing = run?.routing;

  return (
    <Dialog
      open={!!runId}
      onClose={onClose}
      className="max-w-xl"
      title={
        <span className="flex items-center gap-2">
          Flow run
          {run && (
            <Badge
              variant={
                run.status === "completed"
                  ? "success"
                  : ["failed", "error", "cancelled"].includes(run.status)
                    ? "error"
                    : "info"
              }
            >
              {run.status}
            </Badge>
          )}
        </span>
      }
      description={run ? run.flowId : runId ? runId.slice(0, 12) : undefined}
      footer={
        <>
          {run?.leadKey && (
            <Button
              variant="outline"
              size="sm"
              className="mr-auto"
              onClick={() => {
                onClose();
                onNavigate("/data");
              }}
            >
              View lead in Data
            </Button>
          )}
          <Button variant="ghost" size="sm" onClick={onClose}>
            Close
          </Button>
        </>
      }
    >
      {loading ? (
        <div className="space-y-2 py-1">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </div>
      ) : (
        !run && (
          <div className="flex items-start gap-2 rounded-md border border-border bg-surface-canvas px-3 py-2.5">
            <Unplug className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div className="min-w-0 text-[0.8125rem] text-muted-foreground">
              <span className="block font-medium text-body">Couldn't load this run</span>
              <span className="block truncate">
                {!result
                  ? "Waiting for the brain…"
                  : result.disabled
                    ? "BRAIN_URL is not configured on this console."
                    : result.status === 404
                      ? "This brain build doesn't expose /flows/runs/:id yet."
                      : (result.error ?? "The brain didn't answer.")}
              </span>
            </div>
          </div>
        )
      )}
      {run && (
        <div className="scrollbar-thin max-h-[55vh] space-y-3 overflow-y-auto pb-1">
          {/* Score / tier / routing summary */}
          <div className="flex flex-wrap items-center gap-1.5">
            {typeof run.score === "number" && (
              <Badge variant="outline" className="tabular-nums">
                score {run.score.toFixed(2)}
              </Badge>
            )}
            {run.tier && (
              <Badge
                variant={
                  run.tier.toLowerCase() === "hot"
                    ? "error"
                    : run.tier.toLowerCase() === "warm"
                      ? "warning"
                      : "muted"
                }
              >
                {run.tier.toUpperCase()}
              </Badge>
            )}
            {run.leadKey && (
              <Badge variant="muted" className="font-mono font-normal">
                lead {maskIdentifier(run.leadKey)}
              </Badge>
            )}
          </div>

          {routing && (
            <div className="space-y-1.5 rounded-md border border-border bg-surface-canvas p-3">
              <div className="text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
                Routing
              </div>
              {(routing.repName || routing.repId) && (
                <div className="flex items-center gap-1.5 text-[0.8125rem] text-body">
                  <User className="size-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{routing.repName ?? routing.repId}</span>
                  {routing.bookedAppointmentId && (
                    <Badge variant="success" className="ml-auto shrink-0">
                      <CalendarDays className="size-3" />
                      Booked
                    </Badge>
                  )}
                </div>
              )}
              {Array.isArray(routing.proposedSlots) && routing.proposedSlots.length > 0 && (
                <ul className="space-y-0.5">
                  {routing.proposedSlots.slice(0, 5).map((slot, i) => (
                    <li key={i} className="text-[0.6875rem] text-muted-foreground">
                      {formatSlot(slot)}
                    </li>
                  ))}
                </ul>
              )}
              {routing.link && (
                <a
                  href={routing.link}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-[0.6875rem] text-primary hover:underline"
                >
                  Booking link
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          )}

          {/* Q&A transcript */}
          <div>
            <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
              Q&A transcript
            </div>
            {answers.length === 0 ? (
              <p className="text-[0.8125rem] text-muted-foreground">
                No answers recorded{run.currentField ? ` — awaiting “${humanizeFieldName(run.currentField)}”.` : "."}
              </p>
            ) : (
              <dl className="space-y-1.5">
                {answers.map(([field, value]) => {
                  const awaiting = run.currentField === field;
                  return (
                    <div
                      key={field}
                      className={cn(
                        "rounded-md border border-border bg-surface-canvas px-2.5 py-1.5",
                        awaiting && "border-warning/40 bg-warning/10",
                      )}
                    >
                      <dt className="flex items-center gap-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.04em] text-faint">
                        {humanizeFieldName(field)}
                        {awaiting && (
                          <Badge variant="warning" className="px-1 py-0 text-[0.5625rem]">
                            awaiting answer
                          </Badge>
                        )}
                      </dt>
                      <dd className="mt-0.5 text-[0.8125rem] text-body">{answerText(value)}</dd>
                    </div>
                  );
                })}
              </dl>
            )}
          </div>
        </div>
      )}
    </Dialog>
  );
};

// ─── Screen ──────────────────────────────────────────────────────

export interface ReportsSectionProps {
  onNavigate: (path: string) => void;
}

export const ReportsSection: React.FC<ReportsSectionProps> = ({ onNavigate }) => {
  const { deploymentId } = useDeploymentSelector();

  // a. funnel + e. runs come from the engine proxy
  const {
    data: pipeline,
    status: pipelineStatus,
    loading: pipelineLoading,
    error: pipelineError,
    refetch: refetchPipeline,
  } = usePipeline(deploymentId);
  const { runs, loading: runsLoading, error: runsError, refetch: refetchRuns } =
    useRuns(deploymentId);

  // b. lead sources — one broad fetch, grouped client-side (same rationale as DataSection)
  const leadFilters = React.useMemo<DataFilters>(() => ({}), []);
  const {
    data: leadsPage,
    loading: leadsLoading,
    error: leadsError,
    refetch: refetchLeads,
  } = useLeads(leadFilters, 1, LEAD_FETCH_PAGE_SIZE, deploymentId);

  // c + d. brain surfaces
  const [flowsResult, setFlowsResult] = React.useState<OpsResult<FlowRun> | null>(null);
  const [appointmentsResult, setAppointmentsResult] =
    React.useState<OpsResult<Appointment> | null>(null);
  const [opsLoading, setOpsLoading] = React.useState(true);

  const loadOps = React.useCallback(async () => {
    setOpsLoading(true);
    try {
      const [flows, appointments] = await Promise.all([
        opsClient.listFlowRuns(undefined, FLOW_FETCH_LIMIT),
        opsClient.listAppointments(7),
      ]);
      setFlowsResult(flows);
      setAppointmentsResult(appointments);
    } finally {
      setOpsLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void loadOps();
  }, [loadOps]);

  const refreshAll = React.useCallback(() => {
    refetchPipeline();
    refetchLeads();
    refetchRuns();
    void loadOps();
  }, [refetchPipeline, refetchLeads, refetchRuns, loadOps]);

  // ─── a. funnel ─────────────────────────────────────────────────

  const stages = React.useMemo(() => normalizeStages(pipeline), [pipeline]);
  const maxStageCount = React.useMemo(
    () => stages.reduce((max, s) => Math.max(max, s.count), 0),
    [stages],
  );
  const funnelTotal = React.useMemo(
    () => stages.reduce((sum, s) => sum + s.count, 0),
    [stages],
  );
  const statusInfo: PipelineStatus | null = pipelineStatus;
  const hasStatusInfo =
    !!statusInfo &&
    !!(
      statusInfo.nextRun ||
      statusInfo.lastRun ||
      statusInfo.cronExpression ||
      statusInfo.lastFailure
    );
  const cronHuman = React.useMemo(() => {
    const expr = statusInfo?.cronExpression;
    if (!expr) return null;
    try {
      return cronToHumanReadable(expr);
    } catch {
      return null;
    }
  }, [statusInfo]);

  // ─── b. lead sources ───────────────────────────────────────────

  const leadStats = React.useMemo(() => {
    const rows = leadsPage.rows;
    const bySource = new Map<string, number>();
    const byStatus = new Map<string, number>();

    for (const row of rows) {
      const rec = asRecord(row);
      const source =
        firstString(rec.source, rec.lead_source, rec.origin)?.toLowerCase() ?? "unknown";
      bySource.set(source, (bySource.get(source) ?? 0) + 1);
      const status = firstString(rec.status)?.toLowerCase() ?? "unset";
      byStatus.set(status, (byStatus.get(status) ?? 0) + 1);
    }

    const sorted = Array.from(bySource, ([source, count]) => ({ source, count })).sort(
      (a, b) => b.count - a.count || a.source.localeCompare(b.source),
    );
    const bars = sorted.slice(0, MAX_SOURCE_BARS);
    const tail = sorted.slice(MAX_SOURCE_BARS);
    if (tail.length > 0) {
      bars.push({
        source: `other (${tail.length} sources)`,
        count: tail.reduce((sum, s) => sum + s.count, 0),
      });
    }

    const coreStatuses = CORE_LEAD_STATUSES.filter((s) => byStatus.has(s));
    const extraStatuses = Array.from(byStatus.keys())
      .filter((s) => !CORE_LEAD_STATUSES.includes(s))
      .sort();
    const statusChips = [...coreStatuses, ...extraStatuses].map((status) => ({
      status,
      count: byStatus.get(status) ?? 0,
    }));

    return {
      bars,
      maxSourceCount: bars.reduce((max, b) => Math.max(max, b.count), 0),
      statusChips,
      sampled: rows.length,
      distinctSources: sorted.length,
    };
  }, [leadsPage.rows]);

  // ─── c. qualification flows ────────────────────────────────────

  const flowRuns = flowsResult?.items ?? [];
  const activeFlows = React.useMemo(
    () =>
      flowRuns
        .filter((r) => !DONE_FLOW_STATUSES.has(r.status) && !DEAD_FLOW_STATUSES.has(r.status))
        .sort((a, b) => tsOf(b.updatedAt) - tsOf(a.updatedAt)),
    [flowRuns],
  );
  const completedThisWeek = React.useMemo(() => {
    const cutoff = Date.now() - WEEK_MS;
    return flowRuns.filter(
      (r) => DONE_FLOW_STATUSES.has(r.status) && tsOf(r.updatedAt) >= cutoff,
    );
  }, [flowRuns]);
  const flowSummary = React.useMemo(() => {
    const scored = completedThisWeek.filter((r) => typeof r.score === "number");
    const avgScore = scored.length
      ? scored.reduce((sum, r) => sum + (r.score ?? 0), 0) / scored.length
      : null;
    const tiers = new Map<string, number>();
    for (const run of completedThisWeek) {
      const tier = (run.tier ?? "unrated").toLowerCase();
      tiers.set(tier, (tiers.get(tier) ?? 0) + 1);
    }
    return { count: completedThisWeek.length, avgScore, tiers };
  }, [completedThisWeek]);

  // ─── d. appointments ───────────────────────────────────────────

  const appointments = appointmentsResult?.items ?? [];
  const appointmentStats = React.useMemo(() => {
    const now = Date.now();
    const upcoming = appointments
      .filter((a) => tsOf(a.start) >= now - 30 * 60 * 1000)
      .sort((a, b) => tsOf(a.start) - tsOf(b.start));
    const countBy = (statuses: string[]) =>
      upcoming.filter((a) => statuses.includes(a.status)).length;
    return {
      upcoming,
      confirmed: countBy(["confirmed", "accepted", "booked"]),
      pending: countBy(["pending", "tentative", "requested"]),
      cancelled: countBy(["cancelled", "canceled", "declined"]),
    };
  }, [appointments]);

  // The booking panel is best-effort: no brain, no route, no panel.
  const showAppointments = !!appointmentsResult && !appointmentsResult.unreachable;
  /** Per-rep calendar failures the brain reported alongside a good response. */
  const appointmentWarnings = appointmentsResult?.warnings ?? [];

  // ─── e. engine runs ────────────────────────────────────────────

  const runTotals = React.useMemo(
    () =>
      runs.reduce(
        (acc, r) => ({
          tokens: acc.tokens + (Number.isFinite(r.tokens) ? r.tokens : 0),
          cost: acc.cost + (Number.isFinite(r.cost) ? r.cost : 0),
          vmMinutes: acc.vmMinutes + (Number.isFinite(r.vmMinutes) ? r.vmMinutes : 0),
        }),
        { tokens: 0, cost: 0, vmMinutes: 0 },
      ),
    [runs],
  );

  const goToData = React.useCallback(() => onNavigate("/data"), [onNavigate]);

  // ─── Flow-run drill-down dialog ────────────────────────────────

  const [flowDialogRunId, setFlowDialogRunId] = React.useState<string | null>(null);
  const [flowDialogResult, setFlowDialogResult] =
    React.useState<ConversationsResult<ConversationFlowRun> | null>(null);
  const [flowDialogLoading, setFlowDialogLoading] = React.useState(false);

  const openFlowRun = React.useCallback(async (id: string) => {
    setFlowDialogRunId(id);
    setFlowDialogResult(null);
    setFlowDialogLoading(true);
    const res = await conversationsClient.getFlowRun(id);
    setFlowDialogResult(res);
    setFlowDialogLoading(false);
  }, []);

  const closeFlowDialog = React.useCallback(() => setFlowDialogRunId(null), []);

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Reports</h1>
          <p className="text-[0.8125rem] text-muted-foreground">
            Funnel, lead sources, qualification flows, bookings and engine runs
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {deploymentId ?? "no deployment"}
          </Badge>
          <Button variant="outline" size="sm" onClick={refreshAll}>
            <RefreshCw className={cn("size-3.5", opsLoading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* ─── a. Pipeline funnel ─────────────────────────────── */}
        <Panel
          className="lg:col-span-2"
          title="Pipeline funnel"
          subtitle={
            stages.length > 0
              ? `${funnelTotal.toLocaleString()} rows across ${stages.length} stages`
              : "Stage counts from the engine"
          }
          icon={<Gauge className="size-4" />}
          action={
            <Button variant="ghost" size="icon-sm" onClick={refetchPipeline} aria-label="Refresh funnel">
              <RefreshCw className="size-3.5" />
            </Button>
          }
        >
          {pipelineLoading ? (
            <PanelSkeleton rows={5} />
          ) : !deploymentId ? (
            <NoDeploymentNote />
          ) : pipelineError ? (
            <InlineError message={pipelineError} onRetry={refetchPipeline} />
          ) : stages.length === 0 ? (
            <EmptyState
              className="px-2 py-6"
              icon={<Gauge className="size-6 text-muted-foreground" />}
              title="No stage counts yet"
              message="The engine reports a funnel once discovery has written rows for this deployment."
            />
          ) : (
            <>
              <div className="grid gap-x-6 gap-y-2.5 sm:grid-cols-2">
                {stages.map((stage) => (
                  <CountBar
                    key={stage.name}
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate capitalize">
                          {stage.name.replace(/_/g, " ")}
                        </span>
                        <DeltaBadge delta={stage.delta24h} />
                      </span>
                    }
                    count={stage.count}
                    width={barWidth(stage.count, maxStageCount)}
                  />
                ))}
              </div>

              {hasStatusInfo && statusInfo && (
                <div className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1.5 border-t border-border pt-3 text-[0.6875rem] text-muted-foreground">
                  {statusInfo.nextRun && (
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="size-3 shrink-0" />
                      Next run {timeUntil(statusInfo.nextRun)}
                    </span>
                  )}
                  {statusInfo.lastRun && (
                    <span className="inline-flex items-center gap-1.5">
                      <History className="size-3 shrink-0" />
                      Last run {relativeTime(statusInfo.lastRun)}
                    </span>
                  )}
                  {statusInfo.cronExpression && (
                    <span className="inline-flex items-center gap-1.5">
                      <CalendarClock className="size-3 shrink-0" />
                      <span className="font-mono">{statusInfo.cronExpression}</span>
                      {cronHuman && <span className="text-faint">· {cronHuman}</span>}
                    </span>
                  )}
                  {statusInfo.lastFailure && (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <AlertTriangle className="size-3 shrink-0" />
                      Last failure {relativeTime(statusInfo.lastFailure)}
                    </span>
                  )}
                </div>
              )}
            </>
          )}
        </Panel>

        {/* ─── b. Lead sources ────────────────────────────────── */}
        <Panel
          title="Lead sources"
          subtitle={
            leadStats.sampled > 0
              ? `${leadStats.sampled.toLocaleString()} rows sampled · ${leadStats.distinctSources} distinct sources`
              : "Where the leads in this deployment came from"
          }
          icon={<Users className="size-4" />}
          action={
            <Button variant="ghost" size="icon-sm" onClick={refetchLeads} aria-label="Refresh lead sources">
              <RefreshCw className="size-3.5" />
            </Button>
          }
        >
          {leadsLoading ? (
            <PanelSkeleton rows={4} />
          ) : !deploymentId ? (
            <NoDeploymentNote />
          ) : leadsError ? (
            <InlineError message={leadsError} onRetry={refetchLeads} />
          ) : leadStats.sampled === 0 ? (
            <EmptyState
              className="px-2 py-6"
              icon={<Users className="size-6 text-muted-foreground" />}
              title="No leads to attribute"
              message="Import a CSV from Data or let discovery seed rows — sources appear here."
              action={{ label: "Go to Data", onClick: goToData }}
              actionVariant="outline"
            />
          ) : (
            <div className="space-y-4">
              <div className="space-y-2.5">
                {leadStats.bars.map((bucket) => (
                  <CountBar
                    key={bucket.source}
                    label={
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="min-w-0 truncate font-mono text-[0.6875rem]">
                          {bucket.source}
                        </span>
                        <span className="shrink-0 text-[0.625rem] text-faint tabular-nums">
                          {pct(bucket.count, leadStats.sampled)}%
                        </span>
                      </span>
                    }
                    count={bucket.count}
                    width={barWidth(bucket.count, leadStats.maxSourceCount)}
                  />
                ))}
              </div>

              <div className="border-t border-border pt-3">
                <div className="mb-2 text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
                  Status breakdown
                </div>
                {leadStats.statusChips.length === 0 ? (
                  <span className="text-xs text-muted-foreground">No status values on these rows.</span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {leadStats.statusChips.map(({ status, count }) => (
                      <Badge
                        key={status}
                        variant={STATUS_BADGE_VARIANT[status] ?? "muted"}
                        className="tabular-nums"
                      >
                        {status} {count.toLocaleString()}
                      </Badge>
                    ))}
                  </div>
                )}
              </div>

              {leadsPage.total > leadStats.sampled && (
                <p className="text-[0.625rem] text-faint">
                  Counted from the first {leadStats.sampled.toLocaleString()} of{" "}
                  {leadsPage.total.toLocaleString()} rows.
                </p>
              )}
            </div>
          )}
        </Panel>

        {/* ─── c. Qualification flows ─────────────────────────── */}
        <Panel
          title="Qualification flows"
          subtitle="Brain flow runs — active now, plus completions from the last 7 days"
          icon={<Workflow className="size-4" />}
          action={
            <Button variant="ghost" size="icon-sm" onClick={() => void loadOps()} aria-label="Refresh flows">
              <RefreshCw className={cn("size-3.5", opsLoading && "animate-spin")} />
            </Button>
          }
        >
          {opsLoading && !flowsResult ? (
            <PanelSkeleton rows={4} />
          ) : !flowsResult || flowsResult.unreachable ? (
            <BrainOfflineNote result={flowsResult} onRetry={() => void loadOps()} />
          ) : (
            <div className="space-y-4">
              {/* Active runs */}
              {activeFlows.length === 0 ? (
                <div className="rounded-md border border-border bg-surface-canvas px-3 py-2.5 text-[0.8125rem] text-muted-foreground">
                  No qualification flows running right now.
                </div>
              ) : (
                <SimpleTable
                  head={["Flow", "Lead / channel", "Progress", "Priority", "Updated", ""]}
                >
                  {activeFlows.slice(0, MAX_FLOW_ROWS).map((run) => (
                    <tr
                      key={run.id}
                      onClick={() => void openFlowRun(run.id)}
                      title="Open the run's Q&A transcript, score and routing"
                      className="cursor-pointer border-b border-border/60 align-middle last:border-0 hover:bg-surface-hover/60"
                    >
                      <td className="max-w-[10rem] truncate py-1.5 pr-3 font-mono text-[0.6875rem] text-body">
                        {run.flowId}
                      </td>
                      <td className="py-1.5 pr-3 font-mono text-[0.6875rem] text-muted-foreground">
                        {run.leadKey
                          ? maskIdentifier(run.leadKey)
                          : run.chatRef
                            ? maskIdentifier(run.chatRef)
                            : "—"}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                        {run.answersCount !== null ? (
                          <span className="tabular-nums">{run.answersCount} answers</span>
                        ) : (
                          <Badge variant="info">{run.status}</Badge>
                        )}
                      </td>
                      <td className="py-1.5 pr-3">
                        {run.priority === "high" ? (
                          <Badge variant="error">HIGH</Badge>
                        ) : run.priority ? (
                          <Badge variant="muted">{run.priority.toUpperCase()}</Badge>
                        ) : (
                          <span className="text-faint">—</span>
                        )}
                      </td>
                      <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                        {run.updatedAt ? relativeTime(run.updatedAt) : "—"}
                      </td>
                      <td className="py-1.5 text-right">
                        {run.leadKey && (
                          <Button
                            variant="link"
                            size="sm"
                            className="h-auto p-0 text-xs"
                            onClick={(e) => {
                              e.stopPropagation();
                              goToData();
                            }}
                          >
                            View in Data
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </SimpleTable>
              )}

              {activeFlows.length > MAX_FLOW_ROWS && (
                <p className="text-[0.625rem] text-faint">
                  +{activeFlows.length - MAX_FLOW_ROWS} more active runs.
                </p>
              )}

              {/* Completed this week */}
              <div className="border-t border-border pt-3">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                  <span className="text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
                    Completed this week
                  </span>
                  <Badge variant="outline" className="tabular-nums">
                    {flowSummary.count.toLocaleString()} runs
                  </Badge>
                  <Badge variant="muted" className="tabular-nums">
                    avg score{" "}
                    {flowSummary.avgScore === null ? "—" : flowSummary.avgScore.toFixed(2)}
                  </Badge>
                </div>
                {flowSummary.tiers.size === 0 ? (
                  <span className="text-xs text-muted-foreground">
                    Nothing completed in the last 7 days.
                  </span>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {Array.from(flowSummary.tiers.entries())
                      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
                      .map(([tier, count]) => (
                        <Badge
                          key={tier}
                          variant={
                            tier === "hot" ? "success" : tier === "warm" ? "warning" : "muted"
                          }
                          className="tabular-nums"
                        >
                          {tier} {count.toLocaleString()}
                        </Badge>
                      ))}
                  </div>
                )}
                {flowRuns.length >= FLOW_FETCH_LIMIT && (
                  <p className="mt-1.5 text-[0.625rem] text-faint">
                    Counted from the last {FLOW_FETCH_LIMIT} runs the brain returned — older
                    completions this week may be missing.
                  </p>
                )}
              </div>
            </div>
          )}
        </Panel>

        {/* ─── d. Appointments (best-effort) ──────────────────── */}
        {showAppointments && (
          <Panel
            title={`Appointments · next 7 days (${REPORT_TZ})`}
            subtitle={
              appointmentStats.upcoming.length > 0
                ? `${appointmentStats.upcoming.length} upcoming · ${appointmentStats.confirmed} confirmed · ${appointmentStats.pending} pending`
                : "Booked by the brain's scheduling flows"
            }
            icon={<CalendarDays className="size-4" />}
            action={
              <Button variant="ghost" size="icon-sm" onClick={() => void loadOps()} aria-label="Refresh appointments">
                <RefreshCw className="size-3.5" />
              </Button>
            }
          >
            {opsLoading && appointments.length === 0 ? (
              <PanelSkeleton rows={3} />
            ) : appointmentStats.upcoming.length === 0 ? (
              <EmptyState
                className="px-2 py-6"
                icon={<CalendarDays className="size-6 text-muted-foreground" />}
                title="Nothing booked in the next 7 days"
                message={
                  appointmentStats.cancelled > 0
                    ? `${appointmentStats.cancelled} cancelled booking(s) hidden from this list.`
                    : "Bookings land here as soon as a flow proposes a slot and the lead accepts."
                }
              />
            ) : (
              <div className="divide-y divide-border/60">
                {appointmentStats.upcoming.slice(0, MAX_APPOINTMENT_ROWS).map((appt) => (
                  <div key={appt.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[0.8125rem] font-medium text-foreground">
                        {appt.attendeeName}
                      </div>
                      <div className="truncate text-[0.6875rem] text-muted-foreground">
                        {formatDublin(appt.start)}
                        {appt.repId && <span className="font-mono"> · rep {appt.repId}</span>}
                        <span className="text-faint"> · {appt.provider}</span>
                      </div>
                      {appt.title && (
                        <div className="truncate text-[0.625rem] text-faint">{appt.title}</div>
                      )}
                    </div>
                    <Badge
                      variant={
                        ["confirmed", "accepted", "booked"].includes(appt.status)
                          ? "success"
                          : ["cancelled", "canceled", "declined"].includes(appt.status)
                            ? "error"
                            : ["pending", "tentative", "requested"].includes(appt.status)
                              ? "warning"
                              : "muted"
                      }
                    >
                      {appt.status}
                    </Badge>
                    {appt.leadKey ? (
                      <Button
                        variant="link"
                        size="sm"
                        className="h-auto p-0 text-xs"
                        onClick={goToData}
                        title="Open the lead in Data"
                      >
                        {maskIdentifier(appt.leadKey)}
                      </Button>
                    ) : null}
                  </div>
                ))}
                {appointmentStats.upcoming.length > MAX_APPOINTMENT_ROWS && (
                  <p className="pt-2 text-[0.625rem] text-faint">
                    +{appointmentStats.upcoming.length - MAX_APPOINTMENT_ROWS} more booked.
                  </p>
                )}
              </div>
            )}

            {appointmentWarnings.length > 0 && (
              <p className="mt-3 border-t border-border pt-2 text-[0.625rem] text-faint">
                {appointmentWarnings.length} calendar
                {appointmentWarnings.length === 1 ? "" : "s"} couldn't be read —{" "}
                {appointmentWarnings[0]}
                {appointmentWarnings.length > 1 && ` +${appointmentWarnings.length - 1} more`}
              </p>
            )}
          </Panel>
        )}

        {/* ─── e. Recent engine runs ──────────────────────────── */}
        <Panel
          className={showAppointments ? undefined : "lg:col-span-2"}
          title="Recent runs"
          subtitle={
            runs.length > 0
              ? `${runs.length} engine runs · ${runTotals.tokens.toLocaleString()} tokens · €${runTotals.cost.toFixed(2)}`
              : "Crawl / outreach runs recorded by the engine"
          }
          icon={<BarChart3 className="size-4" />}
          action={
            <Button variant="ghost" size="icon-sm" onClick={refetchRuns} aria-label="Refresh runs">
              <RefreshCw className="size-3.5" />
            </Button>
          }
        >
          {runsLoading ? (
            <PanelSkeleton rows={4} />
          ) : !deploymentId ? (
            <NoDeploymentNote />
          ) : runsError ? (
            <InlineError message={runsError} onRetry={refetchRuns} />
          ) : runs.length === 0 ? (
            <EmptyState
              className="px-2 py-6"
              icon={<BarChart3 className="size-6 text-muted-foreground" />}
              title="No runs recorded yet"
              message="Engine runs (crawl, classify, send) show up here with their duration, token spend and cost."
            />
          ) : (
            <SimpleTable
              head={["Trigger", "Started", "Duration", "Tokens", "Cost", "State"]}
              minWidth="560px"
            >
              {runs.slice(0, MAX_RUN_ROWS).map((run) => (
                <tr
                  key={run.id}
                  className="border-b border-border/60 last:border-0 hover:bg-surface-hover/60"
                >
                  <td className="max-w-[12rem] truncate py-1.5 pr-3 text-body">{run.trigger}</td>
                  <td className="whitespace-nowrap py-1.5 pr-3 text-muted-foreground">
                    {run.startedAt ? relativeTime(run.startedAt) : "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {Number.isFinite(run.duration) ? `${Math.round(run.duration)}s` : "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {Number.isFinite(run.tokens) ? run.tokens.toLocaleString() : "—"}
                  </td>
                  <td className="whitespace-nowrap py-1.5 pr-3 tabular-nums text-muted-foreground">
                    {Number.isFinite(run.cost) ? `€${run.cost.toFixed(2)}` : "—"}
                  </td>
                  <td className="py-1.5">
                    <Badge
                      variant={
                        run.state === "completed"
                          ? "success"
                          : run.state === "running"
                            ? "info"
                            : run.state === "failed"
                              ? "error"
                              : "muted"
                      }
                    >
                      {run.state}
                    </Badge>
                  </td>
                </tr>
              ))}
            </SimpleTable>
          )}
        </Panel>
      </div>

      {/* ─── Flow-run drill-down (active/completed rows) ──────── */}
      <FlowRunDialog
        runId={flowDialogRunId}
        result={flowDialogResult}
        loading={flowDialogLoading}
        onClose={closeFlowDialog}
        onNavigate={onNavigate}
      />
    </div>
  );
};

ReportsSection.displayName = "ReportsSection";
