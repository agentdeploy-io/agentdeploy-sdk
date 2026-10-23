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
  BrainCircuit,
  CalendarClock,
  CheckCircle2,
  FlaskConical,
  MessageSquareText,
  Pause,
  Play,
  RefreshCw,
  Send,
  Square,
  Timer,
  Trash2,
  Wand2,
  Zap,
} from "lucide-react";
import { Badge, Button, Card, Dialog, Skeleton, Textarea } from "@/components/ui";
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

// Engine GET/POST /cmd/campaign contract
interface Campaign {
  campaign: {
    brandName: string;
    brandOneLiner: string;
    brandSiteUrl: string;
    brandLogoUrl: string;
    calendlyUrl: string;
    icpNotes: string;
  };
  testMode: boolean;
  testRecipient: string;
  countries: string;
  crawlLimit: number;
}

// Engine GET /cmd/traces contract
interface LlmTrace {
  id: number;
  stage: string;
  lead_key: string | null;
  model: string | null;
  prompt_excerpt: string | null;
  raw_response: string | null;
  latency_ms: number | null;
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

// ─── Campaign & Test panel ───────────────────────────────────────

const fieldCls =
  "h-8 w-full rounded-md border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring";

function CampaignPanel({
  deploymentId,
  onSaved,
}: {
  deploymentId: string;
  onSaved: () => void;
}) {
  const [data, setData] = React.useState<Campaign | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string>>({});

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/campaign`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as Campaign;
      setData(j);
      setForm({
        brandName: j.campaign.brandName ?? "",
        brandOneLiner: j.campaign.brandOneLiner ?? "",
        brandSiteUrl: j.campaign.brandSiteUrl ?? "",
        brandLogoUrl: j.campaign.brandLogoUrl ?? "",
        calendlyUrl: j.campaign.calendlyUrl ?? "",
        icpNotes: j.campaign.icpNotes ?? "",
        testRecipient: j.testRecipient ?? "",
        countries: j.countries ?? "",
        crawlLimit: String(j.crawlLimit ?? 50),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load campaign");
    }
  }, [deploymentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));

  const save = async () => {
    setSaving(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/campaign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
        signal: AbortSignal.timeout(10000),
      });
      const j = (await res.json()) as Campaign & { error?: string };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      setData(j);
      toast.success("Campaign saved", "Applies to every new classification, pitch and reply immediately.");
      onSaved();
    } catch (err) {
      toast.error("Campaign save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const setTestMode = async (on: boolean) => {
    setSaving(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/campaign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testMode: String(on) }),
        signal: AbortSignal.timeout(10000),
      });
      const j = (await res.json()) as Campaign;
      if (!res.ok) throw new Error(`${res.status}`);
      setData(j);
      toast.success(on ? "Test mode ON" : "Test mode OFF", on
        ? `Every send now goes to ${j.testRecipient || "your test inbox"} — real leads are never touched.`
        : "Sends go to the lead's own address again.");
      onSaved();
    } catch (err) {
      toast.error("Test mode toggle failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  if (error) return <ErrorNote message={error} onRetry={load} />;
  if (!data) return <Skeleton className="h-24 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Brand name
          <input className={fieldCls} value={form.brandName ?? ""} onChange={(e) => set("brandName", e.target.value)} placeholder="Agent Miles" />
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          One-liner
          <input className={fieldCls} value={form.brandOneLiner ?? ""} onChange={(e) => set("brandOneLiner", e.target.value)} placeholder="We build AI employees for small businesses." />
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Brand site
          <input className={fieldCls} value={form.brandSiteUrl ?? ""} onChange={(e) => set("brandSiteUrl", e.target.value)} placeholder="https://gradient3.io" />
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Logo URL (https)
          <input className={fieldCls} value={form.brandLogoUrl ?? ""} onChange={(e) => set("brandLogoUrl", e.target.value)} placeholder="https://gradient3.io/favicon.svg" />
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Booking link
          <input className={fieldCls} value={form.calendlyUrl ?? ""} onChange={(e) => set("calendlyUrl", e.target.value)} placeholder="https://calendly.com/…" />
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Countries (comma-separated crawl targets)
          <input className={fieldCls} value={form.countries ?? ""} onChange={(e) => set("countries", e.target.value)} placeholder="uk,ie,fr" />
          <span className="text-[0.625rem] opacity-70">
            Supported: uk, ie, fr, ee, pt — full names work too ("Ireland" → ie). Unsupported names make the crawl fail loudly.
          </span>
        </label>
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Crawl limit (leads per run)
          <input className={fieldCls} value={form.crawlLimit ?? ""} onChange={(e) => set("crawlLimit", e.target.value)} inputMode="numeric" placeholder="50" />
        </label>
      </div>
      <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
        ICP notes (steer the classifier — the structured NACE/size gates still apply)
        <Textarea
          className="min-h-16 text-xs"
          value={form.icpNotes ?? ""}
          onChange={(e) => set("icpNotes", e.target.value)}
          placeholder="e.g. prioritise practices with a front desk; skip companies already using chatbots"
        />
      </label>

      <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-canvas px-3 py-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <FlaskConical className="size-4 text-muted-foreground" />
          <span className="text-[0.8125rem] font-semibold text-foreground">Test mode</span>
          <Button
            size="sm"
            variant={data.testMode ? "success" : "outline"}
            onClick={() => setTestMode(!data.testMode)}
            disabled={saving}
            aria-pressed={data.testMode}
          >
            {data.testMode ? "Test mode ON" : "Test mode OFF"}
          </Button>
          <label className="flex items-center gap-1.5 text-[0.8125rem] text-muted-foreground">
            Test inbox
            <input
              className="h-8 w-56 rounded-md border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
              value={form.testRecipient ?? ""}
              onChange={(e) => set("testRecipient", e.target.value)}
              placeholder="you@yourdomain.com"
            />
          </label>
        </div>
        <p className="text-[0.6875rem] leading-snug text-muted-foreground">
          When on, every pitch and reply send is redirected to your test inbox — the
          lead keeps its own address on record and is never emailed. Dry-run /
          send-enabled still apply, so nothing leaves until you allow it.
        </p>
      </div>

      <div className="flex justify-end">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving ? "Saving…" : "Save campaign"}
        </Button>
      </div>
    </div>
  );
}

// ─── Verticals (crawl configuration) panel ───────────────────────

// Engine GET/POST /cmd/verticals contract
interface Vertical {
  id: string;
  name: string;
  icp: string;
  countries: string[];
  dorks: string[];
  cities?: string[];
  sicInclude?: string[];
  sicExclude?: string[];
  requireWebsite: boolean;
  useRegistry: boolean;
  llmEnrich: boolean;
  mxGuess: boolean;
  minScore: number;
  perCountryLimit: number;
  sources?: string[];
  probes?: string[];
  ccFilters?: string[];
  githubTopics?: string[];
  urlscanQueries?: string[];
  defillamaChains?: string[];
  registryWindowMonths?: number;
  isDefault: boolean;
}

interface SourceMeta {
  id: string;
  label: string;
  hint: string;
}

const SOURCE_META: SourceMeta[] = [
  { id: "dorks", label: "dorks", hint: "search stack — Brave → URLScan/DDG/Bing → LLM judge" },
  { id: "registry", label: "registry", hint: "Companies House / SIRENE / CRO harvest + website link" },
  { id: "commoncrawl", label: "commoncrawl", hint: "CC index URL mining (regex filters)" },
  { id: "github", label: "github", hint: "repo topics → deployed homepage URLs" },
  { id: "urlscan", label: "urlscan", hint: "raw URLScan search queries" },
  { id: "defillama", label: "defillama", hint: "DeFi protocols by chain (crypto verticals)" },
];

const PROBE_META: SourceMeta[] = [
  { id: "monetization", label: "monetization", hint: "payment infra / pricing signals" },
  { id: "techstack", label: "techstack", hint: "builder & platform detection (webflow, lovable…)" },
  { id: "intent", label: "intent", hint: "Wayback recency + OpenPageRank authority" },
];

interface GeneratedScraper {
  id: string;
  description: string;
  code: string;
}

interface ScraperEntry {
  id: string;
  description: string;
  createdAt: string;
}

/**
 * ScraperBuilderPanel — Phase 3: describe a source in plain language, the
 * LLM writes a sandboxed CommonJS module, you smoke-test it against a live
 * vertical, review the code, and register it. Registered scrapers show up as
 * selectable sources on every vertical (and persist across core restarts).
 */
function ScraperBuilderPanel({
  deploymentId,
  registered,
  onChanged,
}: {
  deploymentId: string;
  registered: ScraperEntry[] | null;
  onChanged: () => void;
}) {
  const [prompt, setPrompt] = React.useState("");
  const [genTask, setGenTask] = React.useState<{ id: string; state: "running" | "done" | "failed" } | null>(null);
  const [generated, setGenerated] = React.useState<GeneratedScraper | null>(null);
  const [genError, setGenError] = React.useState<string | null>(null);

  const [testTask, setTestTask] = React.useState<{ id: string; state: "running" | "done" | "failed" } | null>(null);
  const [testHits, setTestHits] = React.useState<Array<{ url: string; title: string; description: string }> | null>(null);
  const [testError, setTestError] = React.useState<string | null>(null);

  const [verticals, setVerticals] = React.useState<Vertical[]>([]);
  const [testVerticalId, setTestVerticalId] = React.useState<string>("");
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    authFetch(`${proxyBase(deploymentId)}/cmd/verticals`, { signal: AbortSignal.timeout(10000) })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => {
        if (cancelled) return;
        const list: Vertical[] = j?.verticals ?? [];
        setVerticals(list);
        if (!testVerticalId) {
          setTestVerticalId((list.find((v) => v.isDefault) ?? list[0])?.id ?? "");
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [deploymentId]);

  // Poll the LLM generation task.
  React.useEffect(() => {
    if (!genTask || genTask.state !== "running") return;
    const id = setInterval(async () => {
      try {
        const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers/generate/${genTask.id}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const j = (await res.json()) as { state: string; result?: GeneratedScraper; error?: string };
        if (j.state === "done" && j.result) {
          setGenTask({ id: genTask.id, state: "done" });
          setGenerated(j.result);
          setGenError(null);
          setTestHits(null);
          setTestError(null);
        } else if (j.state === "failed") {
          setGenTask({ id: genTask.id, state: "failed" });
          setGenError(j.error ?? "generation failed");
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [genTask, deploymentId]);

  // Poll the sandboxed smoke-test task.
  React.useEffect(() => {
    if (!testTask || testTask.state !== "running") return;
    const id = setInterval(async () => {
      try {
        const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers/test/${testTask.id}`, { signal: AbortSignal.timeout(10000) });
        if (!res.ok) return;
        const j = (await res.json()) as { state: string; result?: { ok: boolean; hits?: Array<{ url: string; title: string; description: string }>; error?: string }; error?: string };
        if (j.state === "failed") {
          setTestTask({ id: testTask.id, state: "failed" });
          setTestError(j.error ?? "smoke test failed");
        } else if (j.state === "done" && j.result) {
          setTestTask({ id: testTask.id, state: "done" });
          if (j.result.ok) {
            setTestHits(j.result.hits ?? []);
            setTestError(null);
          } else {
            setTestError(j.result.error ?? "smoke test failed");
          }
        }
      } catch {
        /* transient — keep polling */
      }
    }, 2500);
    return () => clearInterval(id);
  }, [testTask, deploymentId]);

  const generate = async () => {
    if (!prompt.trim()) return;
    setBusy(true);
    setGenError(null);
    setGenerated(null);
    setTestHits(null);
    setTestError(null);
    setTestTask(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: prompt.trim() }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as { taskId?: string };
      if (!j.taskId) throw new Error("no taskId");
      setGenTask({ id: j.taskId, state: "running" });
    } catch (e) {
      setGenError(e instanceof Error ? e.message : "generate failed");
    } finally {
      setBusy(false);
    }
  };

  const smokeTest = async () => {
    if (!generated) return;
    const vertical = verticals.find((v) => v.id === testVerticalId) ?? null;
    setBusy(true);
    setTestError(null);
    setTestHits(null);
    setTestTask(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: generated.code, vertical: vertical ?? undefined }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as { taskId?: string };
      if (!j.taskId) throw new Error("no taskId");
      setTestTask({ id: j.taskId, state: "running" });
    } catch (e) {
      setTestError(e instanceof Error ? e.message : "smoke test failed");
    } finally {
      setBusy(false);
    }
  };

  const register = async () => {
    if (!generated) return;
    setBusy(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: generated.id, description: generated.description, code: generated.code }),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        const j = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(j.error ?? `${res.status}`);
      }
      toast.success(`Scraper "${generated.id}" registered`, "It now appears as a source on every vertical.");
      setGenerated(null);
      setPrompt("");
      setTestHits(null);
      setTestError(null);
      onChanged();
    } catch (e) {
      toast.error("Failed to register scraper", e instanceof Error ? e.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const remove = async (id: string) => {
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/scrapers/${encodeURIComponent(id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success(`Scraper "${id}" removed`);
      onChanged();
    } catch (e) {
      toast.error("Failed to remove scraper", e instanceof Error ? e.message : "Unknown error");
    }
  };

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {/* ── Builder ─────────────────────────────────────────── */}
      <div className="flex flex-col gap-2">
        <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
          Describe the source you want
          <Textarea
            className="min-h-20 font-mono text-[0.75rem]"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder={'e.g. "find UK web design agencies from the GitHub topic web-design and return their homepage sites"'}
          />
        </label>
        <div className="flex items-center gap-2">
          <Button onClick={generate} disabled={busy || !prompt.trim()}>
            <Wand2 className="size-3.5" /> Generate scraper
          </Button>
          {genTask?.state === "running" && (
            <span className="text-[0.6875rem] text-muted-foreground">writing module…</span>
          )}
        </div>
        {genError && <p className="text-[0.6875rem] text-destructive">{genError}</p>}
        {generated && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-canvas p-2.5">
            <div className="text-[0.75rem]">
              <span className="font-mono font-medium">{generated.id}</span>
              <span className="ml-2 text-[0.6875rem] text-muted-foreground">{generated.description}</span>
            </div>
            <pre className="max-h-56 overflow-auto rounded bg-surface p-2 text-[0.65rem] leading-snug">{generated.code}</pre>
            <div className="flex flex-wrap items-center gap-2">
              <select
                className={fieldCls}
                value={testVerticalId}
                onChange={(e) => setTestVerticalId(e.target.value)}
                disabled={verticals.length === 0}
              >
                {verticals.length === 0 && <option value="">no verticals</option>}
                {verticals.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
              <Button size="sm" variant="outline" onClick={smokeTest} disabled={busy}>
                <FlaskConical className="size-3.5" />
                {testTask?.state === "running" ? "Testing…" : "Smoke test"}
              </Button>
              <Button size="sm" onClick={register} disabled={busy}>
                Register
              </Button>
            </div>
            {testTask?.state === "running" && <p className="text-[0.6875rem] text-muted-foreground">running sandboxed…</p>}
            {testError && <p className="text-[0.6875rem] text-destructive">{testError}</p>}
            {testHits && (
              <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                {testHits.length === 0 && (
                  <p className="text-[0.6875rem] opacity-70">
                    0 hits — the source ran clean but found nothing. Adjust the prompt or try another vertical.
                  </p>
                )}
                {testHits.map((h, i) => (
                  <div key={i} className="text-[0.6875rem]">
                    <span className="font-medium">{h.title}</span>
                    <span className="ml-1 font-mono opacity-70">{h.url}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Registered scrapers ─────────────────────────────── */}
      <div className="flex flex-col gap-1.5">
        <span className="text-[0.6875rem] font-medium text-muted-foreground">
          Registered scrapers <span className="opacity-60">({registered?.length ?? 0})</span>
        </span>
        <div className="flex flex-col gap-1">
          {registered == null && <p className="text-[0.6875rem] text-muted-foreground">loading…</p>}
          {registered?.length === 0 && (
            <p className="text-[0.6875rem] opacity-70">
              None yet — generate one on the left. Registered scrapers are selectable sources on every vertical and survive core restarts.
            </p>
          )}
          {registered?.map((s) => (
            <div key={s.id} className="flex items-center gap-2 rounded-md border border-dashed border-border px-2 py-1.5">
              <div className="min-w-0 flex-1">
                <div className="font-mono text-[0.75rem]">{s.id}</div>
                <div className="truncate text-[0.625rem] text-muted-foreground" title={s.description}>{s.description}</div>
              </div>
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[0.6875rem] text-destructive" onClick={() => remove(s.id)}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function VerticalsPanel({
  deploymentId,
  onRunVertical,
  customSources,
}: {
  deploymentId: string;
  onRunVertical: (id: string) => Promise<void>;
  customSources?: Array<{ id: string; description: string }>;
}) {
  const [verticals, setVerticals] = React.useState<Vertical[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [selectedId, setSelectedId] = React.useState<string | null>(null); // null = new
  const [saving, setSaving] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [form, setForm] = React.useState<Record<string, string>>({});
  const [sourcesSel, setSourcesSel] = React.useState<string[]>(["dorks"]);
  const [probesSel, setProbesSel] = React.useState<string[]>(["monetization", "techstack"]);
  const [test, setTest] = React.useState<{ source: string; taskId: string; state: "running" | "done" | "failed"; candidates?: Array<{ name: string; website?: string; description?: string }>; error?: string } | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/verticals`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as { verticals: Vertical[] };
      const list = j.verticals ?? [];
      setVerticals(list);
      if (list.length > 0) {
        setSelectedId((prev) => (prev && list.some((v) => v.id === prev) ? prev : (list.find((v) => v.isDefault) ?? list[0])?.id ?? null));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load verticals");
    }
  }, [deploymentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  const select = (v: Vertical | null) => {
    setSelectedId(v?.id ?? null);
    setTest(null);
    setSourcesSel(v ? v.sources?.length ? v.sources : ["dorks"] : ["dorks"]);
    setProbesSel(v ? v.probes?.length ? v.probes : ["monetization", "techstack"] : ["monetization", "techstack"]);
    setForm(
      v
        ? {
            name: v.name,
            icp: v.icp,
            countries: v.countries.join(", "),
            dorks: v.dorks.join("\n"),
            cities: (v.cities ?? []).join(", "),
            sicInclude: (v.sicInclude ?? []).join(", "),
            sicExclude: (v.sicExclude ?? []).join(", "),
            minScore: String(v.minScore),
            perCountryLimit: String(v.perCountryLimit),
            requireWebsite: String(v.requireWebsite),
            useRegistry: String(v.useRegistry),
            llmEnrich: String(v.llmEnrich),
            mxGuess: String(v.mxGuess),
            ccFilters: (v.ccFilters ?? []).join("\n"),
            githubTopics: (v.githubTopics ?? []).join(", "),
            urlscanQueries: (v.urlscanQueries ?? []).join("\n"),
            defillamaChains: (v.defillamaChains ?? []).join(", "),
            registryWindowMonths: v.registryWindowMonths != null ? String(v.registryWindowMonths) : "",
            isDefault: String(v.isDefault),
          }
        : {
            name: "",
            icp: "",
            countries: "uk",
            dorks: "",
            cities: "",
            sicInclude: "",
            sicExclude: "",
            minScore: "50",
            perCountryLimit: "20",
            requireWebsite: "true",
            useRegistry: "true",
            llmEnrich: "true",
            mxGuess: "true",
            ccFilters: "",
            githubTopics: "",
            urlscanQueries: "",
            defillamaChains: "",
            registryWindowMonths: "",
            isDefault: "false",
          },
    );
  };

  const set = (k: string, v: string) => setForm((f) => ({ ...f, [k]: v }));
  const selected = verticals?.find((v) => v.id === selectedId) ?? null;

  const save = async () => {
    setSaving(true);
    try {
      const payload = {
        ...(selected ? { id: selected.id } : {}),
        name: (form.name ?? "").trim(),
        icp: (form.icp ?? "").trim(),
        countries: (form.countries ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        dorks: (form.dorks ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        cities: (form.cities ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        sicInclude: (form.sicInclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        sicExclude: (form.sicExclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        minScore: Number(form.minScore ?? 50),
        perCountryLimit: Number(form.perCountryLimit ?? 20),
        requireWebsite: form.requireWebsite === "true",
        useRegistry: form.useRegistry === "true",
        llmEnrich: form.llmEnrich === "true",
        mxGuess: form.mxGuess === "true",
        sources: sourcesSel,
        probes: probesSel,
        ccFilters: (form.ccFilters ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        githubTopics: (form.githubTopics ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        urlscanQueries: (form.urlscanQueries ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        defillamaChains: (form.defillamaChains ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        registryWindowMonths: form.registryWindowMonths ? Number(form.registryWindowMonths) : undefined,
        isDefault: form.isDefault === "true",
      };
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/verticals`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(10000),
      });
      const j = (await res.json()) as { vertical?: Vertical; error?: string };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      if (j.vertical) setSelectedId(j.vertical.id);
      toast.success("Vertical saved", "The next crawl (now or cron) uses this configuration.");
      await load();
    } catch (err) {
      toast.error("Vertical save failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!selected) return;
    if (!window.confirm(`Delete vertical "${selected.name}"?`)) return;
    setSaving(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/verticals?id=${encodeURIComponent(selected.id)}`, {
        method: "DELETE",
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      toast.success("Vertical deleted");
      select(null);
      await load();
    } catch (err) {
      toast.error("Delete failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  };

  const runVertical = async () => {
    if (!selected) return;
    setRunning(true);
    try {
      await onRunVertical(selected.id);
    } finally {
      setRunning(false);
    }
  };

  // Smoke-test one discovery source against the CURRENT form (unsaved), so the
  // operator previews what a source will feed the pipeline before committing.
  const testSource = async (source: string) => {
    const verticalId = selected?.id;
    setTest({ source, taskId: "", state: "running" });
    try {
      // Build a throwaway pack from the live form so unsaved edits are tested.
      const pack = {
        id: verticalId ?? "preview",
        name: (form.name ?? "").trim() || "preview",
        icp: (form.icp ?? "").trim(),
        countries: (form.countries ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        dorks: (form.dorks ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        cities: (form.cities ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        sicInclude: (form.sicInclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        sicExclude: (form.sicExclude ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        minScore: Number(form.minScore ?? 50),
        perCountryLimit: Number(form.perCountryLimit ?? 20),
        ccFilters: (form.ccFilters ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        githubTopics: (form.githubTopics ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        urlscanQueries: (form.urlscanQueries ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        defillamaChains: (form.defillamaChains ?? "").split(",").map((s) => s.trim()).filter(Boolean),
        registryWindowMonths: form.registryWindowMonths ? Number(form.registryWindowMonths) : undefined,
      };
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/sources/test`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ vertical: pack, source }),
        signal: AbortSignal.timeout(15000),
      });
      const j = (await res.json()) as { taskId?: string; error?: string };
      if (!res.ok || !j.taskId) throw new Error(j.error ?? `${res.status}`);
      setTest((t) => (t && t.source === source ? { ...t, taskId: j.taskId! } : t));
    } catch (err) {
      setTest({ source, taskId: "", state: "failed", error: err instanceof Error ? err.message : "Unknown error" });
    }
  };

  // Poll the source test until it finishes (core does the work async).
  React.useEffect(() => {
    if (!test || test.state !== "running" || !test.taskId) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const res = await authFetch(`${proxyBase(deploymentId)}/cmd/sources/test/${test.taskId}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        const j = (await res.json()) as { state: "running" | "done" | "failed"; candidates?: Array<{ name: string; website?: string; description?: string }>; error?: string };
        if (cancelled) return;
        if (j.state === "running") {
          setTimeout(poll, 2000);
        } else {
          setTest((t) => (t && t.taskId === test.taskId ? { ...t, state: j.state, candidates: j.candidates, error: j.error } : t));
        }
      } catch (err) {
        if (cancelled) return;
        setTest((t) => (t && t.taskId === test.taskId ? { ...t, state: "failed", error: err instanceof Error ? err.message : "poll failed" } : t));
      }
    };
    const timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [test, deploymentId]);

  if (error) return <ErrorNote message={error} onRetry={load} />;
  if (verticals === null) return <Skeleton className="h-24 w-full" />;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-2">
        {verticals.map((v) => (
          <button
            key={v.id}
            onClick={() => select(v)}
            className={`flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[0.75rem] transition-colors ${
              v.id === selectedId
                ? "border-ring bg-surface-tag text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            {v.name}
            {v.isDefault && <Badge variant="info" className="px-1 py-0 text-[0.5625rem]">default</Badge>}
          </button>
        ))}
        <Button size="sm" variant="outline" onClick={() => select(null)}>
          + New vertical
        </Button>
      </div>

      {verticals.length === 0 && selectedId === null && (
        <p className="text-[0.8125rem] text-muted-foreground">
          No verticals yet. Create one — a vertical is the crawl's ICP, countries and
          discovery dorks. Until one exists, the cron falls back to the legacy registry harvest.
        </p>
      )}

      {(selected || selectedId === null) && (
        <div className="flex flex-col gap-3 rounded-md border border-border bg-surface-canvas px-3 py-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
              Name
              <input className={fieldCls} value={form.name ?? ""} onChange={(e) => set("name", e.target.value)} placeholder="UK Web Agencies" />
            </label>
            <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
              Countries (comma-separated)
              <input className={fieldCls} value={form.countries ?? ""} onChange={(e) => set("countries", e.target.value)} placeholder="uk, ie" />
              <span className="text-[0.625rem] opacity-70">Supported: uk, ie, fr, ee, pt — full names work too.</span>
            </label>
          </div>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
            ICP (what a perfect lead looks like — drives LLM relevance + summaries)
            <Textarea
              className="min-h-16 text-xs"
              value={form.icp ?? ""}
              onChange={(e) => set("icp", e.target.value)}
              placeholder="e.g. Small UK web design / digital marketing agencies (2-20 people) that build websites for local businesses…"
            />
          </label>
          <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
            Discovery dorks (one per line — search queries that surface the vertical)
            <Textarea
              className="min-h-20 font-mono text-xs"
              value={form.dorks ?? ""}
              onChange={(e) => set("dorks", e.target.value)}
              placeholder={'"web design" "our services" site:co.uk\n"digital agency" "contact us" site:co.uk'}
            />
          </label>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
              Cities (optional — each dork × city)
              <input className={fieldCls} value={form.cities ?? ""} onChange={(e) => set("cities", e.target.value)} placeholder="London, Manchester" />
            </label>
            <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
              SIC include (optional — registry filter)
              <input className={fieldCls} value={form.sicInclude ?? ""} onChange={(e) => set("sicInclude", e.target.value)} placeholder="62010, 73110" />
            </label>
            <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
              SIC exclude (optional)
              <input className={fieldCls} value={form.sicExclude ?? ""} onChange={(e) => set("sicExclude", e.target.value)} placeholder="70102" />
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
                Min score (0-100)
                <input className={fieldCls} value={form.minScore ?? ""} onChange={(e) => set("minScore", e.target.value)} inputMode="numeric" />
              </label>
              <label className="flex flex-col gap-1 text-[0.6875rem] text-muted-foreground">
                Leads per country
                <input className={fieldCls} value={form.perCountryLimit ?? ""} onChange={(e) => set("perCountryLimit", e.target.value)} inputMode="numeric" />
              </label>
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">Discovery sources</span>
            <div className="flex flex-col gap-1">
              {SOURCE_META.map((s) => {
                const on = sourcesSel.includes(s.id);
                return (
                  <div key={s.id} className="rounded-md border border-border px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <label className="flex flex-1 items-center gap-1.5 text-[0.75rem]">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => setSourcesSel((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                        />
                        <span className="font-mono">{s.label}</span>
                        <span className="text-[0.625rem] opacity-60">{s.hint}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[0.6875rem]"
                        onClick={() => testSource(s.id)}
                        disabled={test?.state === "running" && test.source === s.id}
                      >
                        {test?.state === "running" && test.source === s.id ? "Testing…" : "Test"}
                      </Button>
                    </div>
                    {on && (
                      <div className="mt-1.5 grid grid-cols-1 gap-2 pl-6 sm:grid-cols-2">
                        {s.id === "commoncrawl" && (
                          <label className="flex flex-col gap-1 text-[0.625rem] text-muted-foreground">
                            CDX filters (one per line, optional — defaults from dorks)
                            <Textarea className="min-h-14 font-mono text-[0.6875rem]" value={form.ccFilters ?? ""} onChange={(e) => set("ccFilters", e.target.value)} placeholder={'url:.*\\.co\\.uk.*web[-_]?design.*'} />
                          </label>
                        )}
                        {s.id === "github" && (
                          <label className="flex flex-col gap-1 text-[0.625rem] text-muted-foreground">
                            Topics (comma-separated, optional)
                            <input className={fieldCls} value={form.githubTopics ?? ""} onChange={(e) => set("githubTopics", e.target.value)} placeholder="web-agency, web-design" />
                          </label>
                        )}
                        {s.id === "urlscan" && (
                          <label className="flex flex-col gap-1 text-[0.625rem] text-muted-foreground">
                            Queries (one per line, optional — defaults from dorks)
                            <Textarea className="min-h-14 font-mono text-[0.6875rem]" value={form.urlscanQueries ?? ""} onChange={(e) => set("urlscanQueries", e.target.value)} placeholder={'domain:co.uk page.url:"web design"'} />
                          </label>
                        )}
                        {s.id === "defillama" && (
                          <label className="flex flex-col gap-1 text-[0.625rem] text-muted-foreground">
                            Chain filter (comma-separated, optional)
                            <input className={fieldCls} value={form.defillamaChains ?? ""} onChange={(e) => set("defillamaChains", e.target.value)} placeholder="eth, solana" />
                          </label>
                        )}
                        {s.id === "registry" && (
                          <label className="flex flex-col gap-1 text-[0.625rem] text-muted-foreground">
                            Incorporated within (months, optional)
                            <input className={fieldCls} value={form.registryWindowMonths ?? ""} onChange={(e) => set("registryWindowMonths", e.target.value)} inputMode="numeric" placeholder="e.g. 36" />
                          </label>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
              {customSources?.map((s) => {
                const on = sourcesSel.includes(s.id);
                return (
                  <div key={s.id} className="rounded-md border border-dashed border-border px-2 py-1.5">
                    <div className="flex items-center gap-2">
                      <label className="flex flex-1 items-center gap-1.5 text-[0.75rem]">
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={(e) => setSourcesSel((cur) => (e.target.checked ? [...cur, s.id] : cur.filter((x) => x !== s.id)))}
                        />
                        <span className="font-mono">{s.id}</span>
                        <span className="truncate text-[0.625rem] opacity-60" title={s.description}>{s.description || "custom scraper"}</span>
                      </label>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2 text-[0.6875rem]"
                        onClick={() => testSource(s.id)}
                        disabled={test?.state === "running" && test.source === s.id}
                      >
                        {test?.state === "running" && test.source === s.id ? "Testing…" : "Test"}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="text-[0.6875rem] font-medium text-muted-foreground">Enrichment probes</span>
            <div className="flex flex-wrap gap-x-4 gap-y-1.5">
              {PROBE_META.map((p) => (
                <label key={p.id} className="flex items-center gap-1.5 text-[0.75rem] text-muted-foreground" title={p.hint}>
                  <input
                    type="checkbox"
                    checked={probesSel.includes(p.id)}
                    onChange={(e) => setProbesSel((cur) => (e.target.checked ? [...cur, p.id] : cur.filter((x) => x !== p.id)))}
                  />
                  <span className="font-mono">{p.label}</span>
                </label>
              ))}
            </div>
          </div>
          {test && (
            <div className="rounded-md border border-border bg-surface-canvas px-2.5 py-2 text-[0.6875rem]">
              <div className="mb-1 flex items-center justify-between">
                <span className="font-medium">
                  Test: <span className="font-mono">{test.source}</span>
                  {test.state === "running" && <span className="ml-2 opacity-70">running…</span>}
                  {test.state === "done" && (
                    <span className="ml-2 text-info">
                      {test.candidates?.length ?? 0} candidates
                    </span>
                  )}
                  {test.state === "failed" && <span className="ml-2 text-destructive">{test.error ?? "failed"}</span>}
                </span>
                <button className="text-muted-foreground hover:text-foreground" onClick={() => setTest(null)}>
                  ✕
                </button>
              </div>
              {test.state === "done" && (
                <div className="flex max-h-44 flex-col gap-1 overflow-y-auto">
                  {(test.candidates ?? []).length === 0 && (
                    <p className="opacity-70">No candidates — try different dorks/ICP or another country.</p>
                  )}
                  {(test.candidates ?? []).map((c, i) => (
                    <div key={i} className="flex flex-col">
                      <span className="truncate">{c.name}</span>
                      <span className="truncate opacity-60">{c.website ?? ""} {c.description ? `· ${c.description}` : ""}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 text-[0.75rem] text-muted-foreground">
            {(["requireWebsite", "useRegistry", "llmEnrich", "mxGuess"] as const).map((k) => (
              <label key={k} className="flex items-center gap-1.5">
                <input type="checkbox" checked={form[k] === "true"} onChange={(e) => set(k, String(e.target.checked))} />
                {k === "requireWebsite" && "require website"}
                {k === "useRegistry" && "verify via Companies House (UK)"}
                {k === "llmEnrich" && "LLM enrichment (ICP fit + summary)"}
                {k === "mxGuess" && "guess info@/hello@ when MX ok"}
              </label>
            ))}
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={form.isDefault === "true"} onChange={(e) => set("isDefault", String(e.target.checked))} />
              default for cron
            </label>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={save} disabled={saving || !(form.name ?? "").trim() || !(form.countries ?? "").trim()}>
                {saving ? "Saving…" : selected ? "Save vertical" : "Create vertical"}
              </Button>
              {selected && (
                <>
                  <Button size="sm" variant="outline" onClick={runVertical} disabled={running}>
                    <Zap /> {running ? "Running…" : "Run now"}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={remove} disabled={saving}>
                    Delete
                  </Button>
                </>
              )}
            </div>
            <p className="text-[0.6875rem] text-muted-foreground">
              Cron crawl uses the <b>default</b> vertical; "Run crawl now" above also uses it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Thinking (LLM traces) panel ─────────────────────────────────

function ThinkingPanel({ deploymentId }: { deploymentId: string }) {
  const [traces, setTraces] = React.useState<LlmTrace[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [openId, setOpenId] = React.useState<number | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/traces?limit=30`, {
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) throw new Error(`${res.status}`);
      const j = (await res.json()) as { traces: LlmTrace[] };
      setTraces(j.traces ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load traces");
    }
  }, [deploymentId]);

  React.useEffect(() => {
    load();
  }, [load]);

  if (error) return <ErrorNote message={error} onRetry={load} />;
  if (traces === null) return <Skeleton className="h-24 w-full" />;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <p className="text-[0.6875rem] text-muted-foreground">
          Every LLM call the engine makes — prompt input + raw model output. Expand a row to debug.
        </p>
        <Button variant="ghost" size="sm" onClick={load}>
          <RefreshCw /> Refresh
        </Button>
      </div>
      {traces.length === 0 ? (
        <p className="text-[0.8125rem] text-muted-foreground">
          No LLM calls yet — they appear once the pipeline classifies, writes or replies.
        </p>
      ) : (
        <div className="flex flex-col gap-1.5">
          {traces.map((t) => {
            const open = openId === t.id;
            return (
              <div key={t.id} className="rounded-md border border-border bg-surface-canvas">
                <button
                  type="button"
                  onClick={() => setOpenId(open ? null : t.id)}
                  className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left"
                >
                  <Badge variant={t.stage === "write" ? "info" : t.stage === "classify" ? "success" : "muted"}>
                    {t.stage}
                  </Badge>
                  <span className="min-w-0 flex-1 truncate text-[0.8125rem] text-foreground">
                    {t.lead_key ?? "—"}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">{t.model ?? ""}</span>
                  <span className="text-[0.6875rem] text-muted-foreground">
                    {t.latency_ms != null ? `${t.latency_ms}ms` : ""}
                  </span>
                  <span className="text-[0.6875rem] text-muted-foreground">{relativeTime(t.at)}</span>
                </button>
                {open && (
                  <div className="flex flex-col gap-2 border-t border-border px-3 py-2">
                    {t.prompt_excerpt && (
                      <div>
                        <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">Prompt input</div>
                        <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
                          {t.prompt_excerpt}
                        </pre>
                      </div>
                    )}
                    {t.raw_response && (
                      <div>
                        <div className="mb-1 text-[0.625rem] uppercase tracking-wide text-muted-foreground">Model output</div>
                        <pre className="scrollbar-thin max-h-48 overflow-auto whitespace-pre-wrap rounded bg-background p-2 font-mono text-[0.6875rem] leading-relaxed text-foreground">
                          {t.raw_response}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Simulate-reply dialog ───────────────────────────────────────

const REPLY_PRESETS: Array<{ label: string; text: string }> = [
  { label: "Interested — book a call", text: "Hi, this is timely — we could definitely use help with this. Could we hop on a call this week?" },
  { label: "Question", text: "Thanks for reaching out. Before we talk, how does this work for a business our size?" },
  { label: "Not interested", text: "Thanks but we're not looking for this right now." },
  { label: "Opt out", text: "Please remove me from your list, I'd prefer not to hear from you again." },
];

function SimulateReplyDialog({
  deploymentId,
  entry,
  defaultFrom,
  testModeOn,
  open,
  onClose,
  onDone,
}: {
  deploymentId: string;
  entry: SentEntry;
  defaultFrom: string;
  testModeOn: boolean;
  open: boolean;
  onClose: () => void;
  onDone: () => void;
}) {
  const [text, setText] = React.useState(REPLY_PRESETS[0].text);
  const [from, setFrom] = React.useState(defaultFrom);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setText(REPLY_PRESETS[0].text);
      setFrom(defaultFrom);
    }
  }, [open, defaultFrom]);

  const send = async () => {
    setBusy(true);
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/simulate-reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sent_id: entry.id, from: from.trim() || undefined, text }),
        signal: AbortSignal.timeout(60_000),
      });
      const j = (await res.json()) as {
        error?: string;
        matched?: number;
        drafted?: number;
        email?: { to: string; subject: string; messageId: string } | null;
        emailError?: string;
        emailNote?: string;
      };
      if (!res.ok) throw new Error(j.error ?? `${res.status}`);
      if (j.emailError) {
        toast.error("Reply simulated, but real email failed", j.emailError);
      } else if (j.email) {
        toast.success(
          "Reply simulated + real email sent",
          `Matched ${j.matched} lead${j.matched === 1 ? "" : "s"}${j.drafted ? `, ${j.drafted} draft${j.drafted === 1 ? "" : "s"} in your Inbox` : ""}. Real email delivered to ${j.email.to} — open it to see the thread.`,
        );
      } else if ((j.matched ?? 0) === 0) {
        toast.error("Simulation matched no lead", "The reply didn't match a sent lead — check the sent log row.");
      } else {
        toast.success(
          "Reply simulated",
          `Matched ${j.matched} lead${j.matched === 1 ? "" : "s"}${j.drafted ? `, ${j.drafted} draft${j.drafted === 1 ? "" : "s"} in your Inbox` : ""}.`,
        );
      }
      onDone();
      onClose();
    } catch (err) {
      toast.error("Simulation failed", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Simulate a reply"
      description={
        testModeOn
          ? `Pretend the recipient of "${entry.lead_key}" replied. Runs the real classify → draft pipeline AND delivers a real email to your test inbox so you can watch the back-and-forth thread.`
          : `Pretend the recipient of "${entry.lead_key}" replied — runs the real classify → draft pipeline. (Test mode is off, so no real email is sent.)`
      }
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
          <Button size="sm" onClick={send} disabled={busy || !text.trim()}>
            {busy ? "Classifying…" : testModeOn ? "Send reply + real email" : "Send simulated reply"}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 p-5 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {REPLY_PRESETS.map((p) => (
            <Button key={p.label} variant="outline" size="sm" onClick={() => setText(p.text)}>
              {p.label}
            </Button>
          ))}
        </div>
        <Textarea
          className="min-h-24 text-xs"
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="reply text"
        />
        <label className="flex items-center gap-2 text-[0.8125rem] text-muted-foreground">
          From
          <input
            className="h-8 w-56 rounded-md border border-border-strong bg-background px-2 text-xs text-foreground outline-none focus:ring-2 focus:ring-ring"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
            placeholder="test inbox address"
          />
        </label>
      </div>
    </Dialog>
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
  const [scrapers, setScrapers] = React.useState<ScraperEntry[] | null>(null);
  const [testRecipient, setTestRecipient] = React.useState("");
  const [testModeOn, setTestModeOn] = React.useState(false);
  const [simulateEntry, setSimulateEntry] = React.useState<SentEntry | null>(null);
  const { runs, loading: runsLoading, refetch: refetchRuns } = useRuns(deploymentId) as {
    runs: CrawlRunEntry[];
    loading: boolean;
    refetch: () => void;
  };

  const loadAll = React.useCallback(async (quiet = false) => {
    if (!deploymentId) return;
    if (!quiet) {
      setSchedulesLoading(true);
      setSchedulesError(null);
    }
    try {
      const [schedRes, sentRes, repliesRes, secretsRes, settingsRes, pipelineRes, campaignRes, scrapersRes] =
        await Promise.all([
          authFetch(`${proxyBase(deploymentId)}/cmd/schedules`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/sent?limit=20`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/replies?status=pending`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/secrets`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/settings`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/pipeline`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/campaign`, { signal: AbortSignal.timeout(10000) }),
          authFetch(`${proxyBase(deploymentId)}/cmd/scrapers`, { signal: AbortSignal.timeout(10000) }),
        ]);
      if (schedRes.ok) {
        const j = (await schedRes.json()) as { schedules: OpSchedule[]; paused: boolean };
        setSchedules(j.schedules ?? []);
        setPaused(!!j.paused);
      } else if (!quiet) {
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
        // Don't clobber what the user is typing during background polling.
        if (!quiet) setCapInput(String(j.settings?.dailyCap ?? j.defaults?.dailyCap ?? "10"));
      }
      if (pipelineRes.ok) {
        const j = (await pipelineRes.json()) as { funnel?: Array<{ stage: string; count: number }> };
        setFunnel(j.funnel ?? []);
      }
      if (campaignRes.ok) {
        const j = (await campaignRes.json()) as Campaign;
        setTestRecipient(j.testRecipient ?? "");
        setTestModeOn(j.testMode === true);
      }
      if (scrapersRes.ok) {
        const j = (await scrapersRes.json()) as { scrapers: ScraperEntry[] };
        setScrapers(j.scrapers ?? []);
      }
    } catch (err) {
      if (!quiet) setSchedulesError(err instanceof Error ? err.message : "Failed to load operations state");
    } finally {
      if (!quiet) setSchedulesLoading(false);
    }
  }, [deploymentId]);

  React.useEffect(() => {
    loadAll();
    // Background poll so schedules / sent rows / drafts / funnel update in
    // place while you're working — no manual refresh needed.
    const id = setInterval(() => loadAll(true), 5000);
    return () => clearInterval(id);
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

  const runNow = async (name: string, body?: Record<string, unknown>) => {
    if (!deploymentId) return;
    try {
      const res = await authFetch(`${proxyBase(deploymentId)}/cmd/schedules/${encodeURIComponent(name)}/run`, {
        method: "POST",
        ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(180_000),
      });
      const json = (await res.json()) as { error?: string; result?: Record<string, unknown>; verticalId?: string | null };
      if (!res.ok) throw new Error(json.error ?? `${res.status}`);
      const state = json.result?.state as string | undefined;
      const verticalId = json.verticalId ?? undefined;
      toast.success(
        `${name} run triggered`,
        state
          ? verticalId
            ? `State: ${state} (vertical ${verticalId})`
            : `State: ${state}`
          : "Run started.",
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
          <Button variant="outline" size="sm" onClick={() => loadAll()}>
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

      {/* ── Verticals (what the crawl looks for) ──────────── */}
      <Panel
        title="Verticals"
        icon={<BrainCircuit className="size-4" />}
        subtitle="What the crawl hunts — ICP, countries and discovery dorks per vertical. A vertical is config, not code: add one and the next crawl runs it."
      >
        <VerticalsPanel
          deploymentId={deploymentId}
          onRunVertical={(id) => runNow("crawl", { verticalId: id })}
          customSources={scrapers ?? undefined}
        />
      </Panel>

      {/* ── Scraper Builder (extend discovery with AI-written sources) ── */}
      <Panel
        title="Scraper Builder"
        icon={<Wand2 className="size-4" />}
        subtitle="No source for a niche? Describe where to find the companies and the AI writes a sandboxed scraper module. Smoke-test it against a vertical, review the code, and register it — it becomes a selectable source everywhere."
      >
        <ScraperBuilderPanel deploymentId={deploymentId} registered={scrapers} onChanged={() => loadAll(true)} />
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

      {/* ── Campaign & Test ───────────────────────────────── */}
      <Panel
        title="Campaign & Test"
        icon={<FlaskConical className="size-4" />}
        subtitle="Your brand, targeting and the end-to-end test loop — what the classifier, writer and replies use."
      >
        <CampaignPanel deploymentId={deploymentId} onSaved={loadAll} />
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
                  <th className="pb-2 pr-3 font-medium">Status</th>
                  <th className="pb-2 font-medium" />
                </tr>
              </thead>
              <tbody>
                {sent.map((e) => (
                  <tr key={e.id} className="border-t border-border">
                    <td className="py-1.5 pr-3 whitespace-nowrap text-muted-foreground">{relativeTime(e.at)}</td>
                    <td className="max-w-40 truncate py-1.5 pr-3 text-foreground">{e.lead_key}</td>
                    <td className="max-w-44 truncate py-1.5 pr-3 text-muted-foreground">{e.email}</td>
                    <td className="max-w-56 truncate py-1.5 pr-3 text-foreground">{e.subject}</td>
                    <td className="py-1.5 pr-3">
                      <Badge variant={e.status === "sent" ? "success" : "info"}>{e.status}</Badge>
                    </td>
                    <td className="py-1.5 text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => setSimulateEntry(e)}
                        title="Simulate a reply from this recipient through the real classify → draft pipeline"
                      >
                        <MessageSquareText /> Simulate reply
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* ── Thinking (LLM traces) ──────────────────────────── */}
      <Panel
        title="Thinking"
        icon={<BrainCircuit className="size-4" />}
        subtitle="Raw LLM input/output from classify, write and reply steps — the debug view for tuning your lead-gen flows."
      >
        <ThinkingPanel deploymentId={deploymentId} />
      </Panel>

      {simulateEntry && (
        <SimulateReplyDialog
          deploymentId={deploymentId}
          entry={simulateEntry}
          defaultFrom={testRecipient}
          testModeOn={testModeOn && !!testRecipient}
          open
          onClose={() => setSimulateEntry(null)}
          onDone={loadAll}
        />
      )}
    </div>
  );
}
