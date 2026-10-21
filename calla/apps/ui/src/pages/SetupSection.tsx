/**
 * SetupSection — /setup
 * ─────────────────────
 * "Setup checklist" — the implementation/demo surface. Nine cards, each
 * running a live status check against the brain (or the engine proxy) and
 * reporting honestly:
 *
 *   ✅ ready          — the surface works
 *   ⚠️ partial        — connected but incomplete (LLM key, no reps, …)
 *   ❌ not configured — with the exact fix: env vars, webhook URLs (copyable),
 *                       App Review notes, curl examples
 *
 * Every check is best-effort: the brain may be off, older (404), or
 * unreachable — a card then says so instead of pretending. Nothing here
 * throws into render.
 */

import * as React from "react";
import {
  AlertTriangle,
  Brain,
  CalendarDays,
  CheckCircle2,
  CircleDot,
  Copy,
  ExternalLink,
  Globe,
  Instagram,
  Layers,
  MessageCircle,
  Music2,
  Plug,
  RefreshCw,
  ShieldCheck,
  Workflow,
  XCircle,
} from "lucide-react";
import {
  CALLA_MODULES,
  MODULE_PRESETS,
  isModuleEnabled,
  resolveModuleSet,
  type ModuleId,
} from "@calla/shared";
import { Badge, Button, Card } from "@/components/ui";
import { authFetch, toast, useAuth, useDeploymentSelector } from "@/hooks";
import { getBrainUrl } from "@/config";
import { asRecord, firstNumber, firstString } from "@/lib/ops-client";
import { applyModuleConfig, useModuleConfig } from "@/lib/modules";
import { cn } from "@/lib/utils";

// ─── Constants & helpers ─────────────────────────────────────────

/** Builtin qualification flows the brain ships with — ≥4 means complete. */
const EXPECTED_BUILTIN_FLOWS = 4;
/** Default flow used for the website-widget snippet + test link. */
const WIDGET_FLOW = "retrofit-solar-qualification";
const WIDGET_TITLE = "Get your solar quote";

type CheckState = "ready" | "partial" | "missing" | "unknown";

const STATUS_META: Record<
  CheckState,
  { label: string; Icon: React.ComponentType<{ className?: string }>; className: string }
> = {
  ready: { label: "Ready", Icon: CheckCircle2, className: "text-success" },
  partial: { label: "Partial", Icon: AlertTriangle, className: "text-warning" },
  missing: { label: "Not configured", Icon: XCircle, className: "text-destructive" },
  unknown: { label: "Unknown", Icon: CircleDot, className: "text-muted-foreground" },
};

interface JsonRead {
  data: Record<string, unknown> | null;
  status: number | null;
  error: string | null;
}

/** GET + JSON parse via authFetch. Never throws — failures come back as error. */
async function readJson(url: string): Promise<JsonRead> {
  try {
    const res = await authFetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) {
      return { data: null, status: res.status, error: `${res.status} ${res.statusText}`.trim() };
    }
    return { data: asRecord(await res.json()), status: res.status, error: null };
  } catch (err) {
    return {
      data: null,
      status: null,
      error: err instanceof Error ? err.message : "request failed",
    };
  }
}

/**
 * The brain base resolved to an absolute URL — webhook URLs and the widget
 * snippet must be copy-pasteable into Meta's dashboard / a customer site,
 * where a relative "/brain" is meaningless.
 */
export function absoluteBrainUrl(): string {
  const base = getBrainUrl().trim().replace(/\/+$/, "");
  if (!base || base.toLowerCase() === "none") return "";
  if (base.startsWith("/")) {
    return typeof window !== "undefined" ? window.location.origin + base : base;
  }
  return base;
}

async function copyText(value: string, label = "Value"): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
    toast.success("Copied to clipboard", label);
  } catch {
    toast.error("Copy failed", "Your browser blocked clipboard access — select and copy manually.");
  }
}

// ─── Shared card chrome ──────────────────────────────────────────

const SetupCard: React.FC<{
  title: string;
  icon: React.ReactNode;
  state: CheckState;
  summary: string;
  children?: React.ReactNode;
}> = ({ title, icon, state, summary, children }) => {
  const meta = STATUS_META[state];
  return (
    <Card className="flex flex-col p-4 sm:p-5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-md bg-surface-tag text-muted-foreground">
            {icon}
          </span>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>
            <p className="mt-0.5 text-[0.8125rem] leading-snug text-muted-foreground">
              {summary}
            </p>
          </div>
        </div>
        <span
          className={cn("flex shrink-0 items-center gap-1.5 text-xs font-semibold", meta.className)}
          title={meta.label}
        >
          <meta.Icon className="size-4" />
          {meta.label}
        </span>
      </div>
      {children && <div className="mt-3 min-w-0 flex-1 space-y-2.5">{children}</div>}
    </Card>
  );
};

const CopyButton: React.FC<{ value: string; label?: string }> = ({ value, label }) => (
  <Button
    variant="ghost"
    size="icon-sm"
    onClick={() => void copyText(value, label ?? value)}
    aria-label={`Copy ${label ?? "value"}`}
    title="Copy to clipboard"
  >
    <Copy className="size-3.5" />
  </Button>
);

/** A copyable monospace value row (webhook URLs, snippets, ids). */
const CopyRow: React.FC<{ label?: string; value: string; multiline?: boolean }> = ({
  label,
  value,
  multiline,
}) => (
  <div className="rounded-md border border-border bg-surface-canvas">
    <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
      {label && (
        <span className="text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
          {label}
        </span>
      )}
      <CopyButton value={value} label={label ?? value} />
    </div>
    {multiline ? (
      <pre className="scrollbar-thin overflow-x-auto border-t border-border px-2.5 py-2 font-mono text-[0.6875rem] leading-relaxed text-body">
        {value}
      </pre>
    ) : (
      <code className="block truncate border-t border-border px-2.5 py-1.5 font-mono text-[0.6875rem] text-body">
        {value}
      </code>
    )}
  </div>
);

/** Env vars the operator must set — names are copyable, values never shown. */
const EnvList: React.FC<{ vars: string[] }> = ({ vars }) => (
  <div>
    <div className="mb-1 text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
      Required environment variables (brain)
    </div>
    <ul className="flex flex-wrap gap-1.5">
      {vars.map((name) => (
        <li key={name}>
          <button
            type="button"
            onClick={() => void copyText(name, name)}
            title="Copy variable name"
            className="inline-flex items-center gap-1 rounded-md border border-border bg-surface-tag px-2 py-0.5 font-mono text-[0.6875rem] text-body transition-colors hover:border-border-strong"
          >
            {name}
            <Copy className="size-3 text-faint" />
          </button>
        </li>
      ))}
    </ul>
  </div>
);

const FixNote: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div className="rounded-md border border-border bg-surface-canvas px-2.5 py-2 text-[0.6875rem] leading-relaxed text-muted-foreground">
    {children}
  </div>
);

const KeyValue: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
    <span className="text-muted-foreground">{label}</span>
    <span className="truncate font-mono text-[0.6875rem] text-body">{value}</span>
  </div>
);

// ─── Screen ──────────────────────────────────────────────────────

// ─── Modules panel (per-deployment feature flags) ────────────────

/**
 * Per-deployment module toggles — the vertical-specialization layer on top
 * of whitelabelling. Runtime source of truth is the brain
 * (PUT /config/modules, audited); when the brain is unreachable the
 * deploy-time ENABLED_MODULES runtime-config fallback (or "all enabled")
 * applies. Toggles + presets update the whole console instantly via
 * applyModuleConfig (sidebar, palette, keyboard shortcuts, route gate).
 */
const ModulesPanel: React.FC = () => {
  const { modules, source } = useModuleConfig();
  const { user } = useAuth();
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const brainBase = React.useMemo(() => absoluteBrainUrl(), []);
  const brainEnabled = brainBase.length > 0;

  /** null = all enabled, so materialize the full set for diffing. */
  const effective: ModuleId[] = React.useMemo(
    () => modules ?? CALLA_MODULES.map((m) => m.id),
    [modules],
  );
  const effectiveKey = React.useMemo(() => [...effective].sort().join(","), [effective]);

  const apply = React.useCallback(
    async (body: { modules?: ModuleId[]; preset?: string }) => {
      if (!brainEnabled) {
        setError("BRAIN_URL is not configured — module toggles need the brain.");
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const res = await authFetch(`${brainBase}/config/modules`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...body, updatedBy: user?.email ?? "operator" }),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          const data = (await res.json().catch(() => null)) as { error?: unknown } | null;
          const msg = typeof data?.error === "string" ? data.error : `HTTP ${res.status}`;
          setError(msg);
          toast.error("Modules not saved", msg);
          return;
        }
        const data = (await res.json()) as { modules?: ModuleId[] | null };
        applyModuleConfig(data.modules ?? null, "brain");
        toast.success("Modules updated", "Navigation refreshed for this deployment.");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "request failed";
        setError(msg);
        toast.error("Modules not saved", msg);
      } finally {
        setSaving(false);
      }
    },
    [brainBase, brainEnabled, user?.email],
  );

  const toggle = (id: ModuleId) => {
    const next = effective.includes(id) ? effective.filter((m) => m !== id) : [...effective, id];
    void apply({ modules: next });
  };

  const activePreset = Object.entries(MODULE_PRESETS).find(
    ([, p]) => [...p.modules].sort().join(",") === effectiveKey,
  )?.[0];

  const state = !brainEnabled ? "unknown" : source === "brain" ? "ready" : "partial";
  const summary = !brainEnabled
    ? "BRAIN_URL is not configured — toggles are disabled (deploy-time ENABLED_MODULES fallback applies)."
    : source === "brain"
      ? `${effective.length} of ${CALLA_MODULES.length} modules enabled for this deployment.`
      : "Brain unreachable — showing the deploy-time ENABLED_MODULES fallback (or all modules). Toggles will work once the brain is up.";

  return (
    <SetupCard
      title="Modules"
      icon={<Layers className="size-4" />}
      state={state}
      summary={summary}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
          Preset
        </span>
        {Object.entries(MODULE_PRESETS).map(([name, p]) => (
          <Button
            key={name}
            type="button"
            variant={activePreset === name ? "default" : "outline"}
            size="sm"
            disabled={!brainEnabled || saving}
            title={p.description}
            onClick={() => void apply({ preset: name })}
          >
            {p.label}
          </Button>
        ))}
      </div>

      <div className="grid gap-1.5 sm:grid-cols-2">
        {CALLA_MODULES.map((m) => {
          const enabled = isModuleEnabled(m.id, modules);
          const locked = !!m.always;
          return (
            <button
              key={m.id}
              type="button"
              role="switch"
              aria-checked={enabled}
              disabled={locked || saving || !brainEnabled}
              onClick={() => toggle(m.id)}
              className={cn(
                "flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2 text-left transition-colors",
                enabled && !locked && "bg-secondary/60",
                !locked && !saving && brainEnabled && "hover:bg-surface-hover",
                (locked || saving || !brainEnabled) && "cursor-not-allowed opacity-70",
              )}
            >
              <span className="min-w-0">
                <span className="flex items-center gap-2 text-sm font-medium text-foreground">
                  {m.label}
                  {locked && <Badge variant="outline">shell</Badge>}
                  {!m.path && (
                    <span className="text-[0.625rem] text-faint">capability</span>
                  )}
                </span>
                {m.required && m.required.length > 0 && (
                  <span className="block truncate text-[0.6875rem] text-muted-foreground">
                    requires {m.required.join(" + ")}
                  </span>
                )}
              </span>
              <span
                aria-hidden
                className={cn(
                  "relative h-4 w-7 shrink-0 rounded-full border border-border transition-colors",
                  enabled ? "bg-primary" : "bg-surface-tag",
                )}
              >
                <span
                  className={cn(
                    "absolute top-1/2 size-3 -translate-y-1/2 rounded-full bg-background shadow-control transition-all",
                    enabled ? "left-[calc(100%-0.875rem)]" : "left-0.5",
                  )}
                />
              </span>
            </button>
          );
        })}
      </div>

      {error && (
        <FixNote>
          <span className="font-semibold text-destructive">Last change failed:</span> {error}
        </FixNote>
      )}
    </SetupCard>
  );
};

export interface SetupSectionProps {
  onNavigate: (path: string) => void;
}

export const SetupSection: React.FC<SetupSectionProps> = () => {
  const { authMode } = useAuth();
  const { deploymentId } = useDeploymentSelector();

  const [health, setHealth] = React.useState<JsonRead | null>(null);
  const [channels, setChannels] = React.useState<JsonRead | null>(null);
  const [booking, setBooking] = React.useState<JsonRead | null>(null);
  const [definitions, setDefinitions] = React.useState<JsonRead | null>(null);
  const [engine, setEngine] = React.useState<JsonRead | null>(null);
  const [loading, setLoading] = React.useState(true);

  const brainBase = React.useMemo(() => absoluteBrainUrl(), []);
  const brainEnabled = brainBase.length > 0;

  const loadAll = React.useCallback(async () => {
    setLoading(true);
    if (!brainEnabled) {
      const off: JsonRead = { data: null, status: null, error: "BRAIN_URL is not configured." };
      setHealth(off);
      setChannels(off);
      setBooking(off);
      setDefinitions(off);
    } else {
      const base = getBrainUrl().trim().replace(/\/+$/, "");
      const [h, c, b, d] = await Promise.all([
        readJson(`${base}/health`),
        readJson(`${base}/channels`),
        readJson(`${base}/booking`),
        readJson(`${base}/flows/definitions`),
      ]);
      setHealth(h);
      setChannels(c);
      setBooking(b);
      setDefinitions(d);
    }

    const engineRead = deploymentId
      ? await readJson(`/d/${encodeURIComponent(deploymentId)}/cmd/settings`)
      : { data: null, status: null, error: "No deployment selected." };
    setEngine(engineRead);
    setLoading(false);
  }, [brainEnabled, deploymentId]);

  React.useEffect(() => {
    void loadAll();
  }, [loadAll]);

  // ─── Per-item derivations ──────────────────────────────────────

  const platforms = React.useMemo(() => asRecord(asRecord(channels?.data).platforms), [channels]);
  const channelsReachable = !!channels?.data;
  const instagramEnabled = asRecord(platforms.instagram).enabled === true;
  const whatsapp = asRecord(platforms.whatsapp);
  const whatsappEnabled = whatsapp.enabled === true;
  const whatsappCustomerMode = whatsapp.customerMode === true;
  const tiktokEnabled = asRecord(platforms.tiktok).enabled === true;

  const healthData = health?.data;
  const healthModel = firstString(healthData?.model);
  const llmConfigured = !!healthModel && healthModel.toLowerCase() !== "not-configured";

  const bookingData = booking?.data;
  const providers = asRecord(bookingData?.providers);
  const configuredProviders = (["google", "microsoft", "calendly"] as const).filter(
    (p) => asRecord(providers[p]).configured === true,
  );
  const repsRaw = bookingData?.reps;
  const repsCount = Array.isArray(repsRaw)
    ? repsRaw.length
    : (firstNumber(repsRaw, asRecord(repsRaw).total) ?? 0);

  const flowIds = React.useMemo(() => {
    const list = definitions?.data?.definitions;
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const rec = asRecord(item);
        return firstString(rec.id, rec.flowId, rec.name) ?? (typeof item === "string" ? item : null);
      })
      .filter((id): id is string => !!id);
  }, [definitions]);

  const engineReachable = !!engine?.data;

  const widgetSnippet = brainEnabled
    ? `<script src="${brainBase}/forms/widget.js?flow=${WIDGET_FLOW}&title=${encodeURIComponent(WIDGET_TITLE)}" defer></script>`
    : "";
  const widgetTestUrl = brainEnabled
    ? `${brainBase}/forms/widget.js?flow=${WIDGET_FLOW}`
    : "";

  const addRepCurl = brainEnabled
    ? `curl -X POST ${brainBase}/booking/reps \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer $CALLA_TOKEN" \\
  -d '{
    "id": "alice",
    "name": "Alice",
    "calendarProvider": "google",
    "calendarId": "alice@example.com",
    "timezone": "Europe/Dublin"
  }'`
    : "";

  const readyCount = (
    [
      !!healthData && llmConfigured,
      instagramEnabled,
      whatsappEnabled,
      tiktokEnabled,
      configuredProviders.length > 0 && repsCount > 0,
      flowIds.length >= EXPECTED_BUILTIN_FLOWS,
      engineReachable,
      brainEnabled,
      true, // login mode is informational — always "ready"
    ] as boolean[]
  ).filter(Boolean).length;

  const brainOfflineDetail = !brainEnabled
    ? "BRAIN_URL is empty on this console — set it to enable every channel surface."
    : health?.status === 404
      ? "The brain answered 404 on /health — is BRAIN_URL pointing at the Calla brain?"
      : (health?.error ?? "The brain didn't answer.");

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-8">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Setup checklist</h1>
          <p className="text-[0.8125rem] text-muted-foreground">
            Live checks against your brain, channels, booking and engine — with the exact fix for
            anything missing.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="tabular-nums">
            {readyCount} / 9 ready
          </Badge>
          <Button variant="outline" size="sm" onClick={() => void loadAll()} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh all
          </Button>
        </div>
      </header>

      {/* ─── Modules (per-deployment feature flags) ───────────── */}
      <ModulesPanel />

      <div className="grid gap-4 md:grid-cols-2">
        {/* ─── 1. Brain connection ─────────────────────────────── */}
        <SetupCard
          title="Brain connection"
          icon={<Brain className="size-4" />}
          state={
            !healthData ? "missing" : llmConfigured ? "ready" : "partial"
          }
          summary={
            !healthData
              ? brainOfflineDetail
              : llmConfigured
                ? `Connected — storage ${firstString(healthData.storage) ?? "?"}, model ${healthModel}.`
                : "Connected, but the LLM is not configured — the brain can't generate replies yet."
          }
        >
          {healthData && (
            <div className="space-y-1 rounded-md border border-border bg-surface-canvas px-2.5 py-2">
              <KeyValue label="Storage" value={firstString(healthData.storage) ?? "—"} />
              <KeyValue label="Model" value={healthModel ?? "—"} />
              <KeyValue
                label="Calla store"
                value={String(healthData.callaStore ?? "—")}
              />
            </div>
          )}
          {healthData && !llmConfigured && (
            <FixNote>
              <span className="font-semibold text-body">Fix:</span> set{" "}
              <code className="font-mono">LLM_BASE_URL</code> (e.g.{" "}
              <code className="font-mono">https://api.openai.com/v1</code>) and{" "}
              <code className="font-mono">LLM_API_KEY</code> in the brain's environment, then
              restart the brain. Personas and qualification flows need a live model.
            </FixNote>
          )}
          {!healthData && brainEnabled && (
            <FixNote>
              <span className="font-semibold text-body">Fix:</span> start the brain and make sure{" "}
              <code className="font-mono">BRAIN_URL</code> (currently{" "}
              <code className="font-mono">{getBrainUrl()}</code>) points at it — in dev,{" "}
              <code className="font-mono">npm run dev</code> from packages/calla starts it on port
              3000 behind the <code className="font-mono">/brain</code> proxy.
            </FixNote>
          )}
        </SetupCard>

        {/* ─── 2. Instagram ────────────────────────────────────── */}
        <SetupCard
          title="Instagram"
          icon={<Instagram className="size-4" />}
          state={!channelsReachable ? "unknown" : instagramEnabled ? "ready" : "missing"}
          summary={
            !channelsReachable
              ? "Can't read channel status — the brain isn't answering."
              : instagramEnabled
                ? "Channel live — inbound DMs flow into Conversations."
                : "Not configured — DMs are not being received."
          }
        >
          {channelsReachable && !instagramEnabled && (
            <>
              <EnvList
                vars={["IG_APP_ID", "IG_APP_SECRET", "IG_VERIFY_TOKEN", "IG_ACCESS_TOKEN"]}
              />
              <CopyRow
                label="Webhook URL (register in Meta dashboard)"
                value={`${brainBase}/channels/instagram/webhook`}
              />
              <FixNote>
                <span className="font-semibold text-body">Meta App Review:</span> your app needs the{" "}
                <code className="font-mono">instagram_business_basic</code> and{" "}
                <code className="font-mono">instagram_business_manage_messages</code> permissions
                approved before production accounts can message the bot. Register the webhook URL
                above under Instagram → Webhooks and subscribe to{" "}
                <code className="font-mono">messages</code>.
              </FixNote>
            </>
          )}
        </SetupCard>

        {/* ─── 3. WhatsApp ─────────────────────────────────────── */}
        <SetupCard
          title="WhatsApp"
          icon={<MessageCircle className="size-4" />}
          state={!channelsReachable ? "unknown" : whatsappEnabled ? "ready" : "missing"}
          summary={
            !channelsReachable
              ? "Can't read channel status — the brain isn't answering."
              : whatsappEnabled
                ? "Channel live — inbound messages flow into Conversations."
                : "Not configured — messages are not being received."
          }
        >
          {channelsReachable && whatsappEnabled && whatsappCustomerMode && (
            <Badge variant="info">customer mode</Badge>
          )}
          {channelsReachable && !whatsappEnabled && (
            <>
              <EnvList
                vars={[
                  "WHATSAPP_PHONE_NUMBER_ID",
                  "WHATSAPP_ACCESS_TOKEN",
                  "WHATSAPP_VERIFY_TOKEN",
                  "WHATSAPP_APP_SECRET",
                ]}
              />
              <CopyRow
                label="Webhook URL (register in Meta dashboard)"
                value={`${brainBase}/channels/whatsapp/webhook`}
              />
              <FixNote>
                <span className="font-semibold text-body">Fix:</span> create a WhatsApp Business
                platform app in the Meta developers console, copy the phone-number ID + permanent
                token into the env vars above, and subscribe the webhook URL to{" "}
                <code className="font-mono">messages</code>. Customer mode (replies only to
                customers who messaged first) keeps you inside WhatsApp's business-initiated
                limits.
              </FixNote>
            </>
          )}
        </SetupCard>

        {/* ─── 4. TikTok ───────────────────────────────────────── */}
        <SetupCard
          title="TikTok"
          icon={<Music2 className="size-4" />}
          state={!channelsReachable ? "unknown" : tiktokEnabled ? "ready" : "missing"}
          summary={
            !channelsReachable
              ? "Can't read channel status — the brain isn't answering."
              : tiktokEnabled
                ? "Channel live — DMs flow into Conversations."
                : "Not configured."
          }
        >
          {channelsReachable && !tiktokEnabled && (
            <FixNote>
              <span className="font-semibold text-body">Region gate:</span> the TikTok messaging
              API is region-gated — it requires an approved TikTok developer app and is only
              available to business accounts in supported markets. Until your app is approved,
              this channel stays off; Instagram and WhatsApp cover the same funnel.
            </FixNote>
          )}
        </SetupCard>

        {/* ─── 5. Booking ──────────────────────────────────────── */}
        <SetupCard
          title="Booking"
          icon={<CalendarDays className="size-4" />}
          state={
            !bookingData
              ? "unknown"
              : configuredProviders.length > 0 && repsCount > 0
                ? "ready"
                : configuredProviders.length > 0
                  ? "partial"
                  : "missing"
          }
          summary={
            !bookingData
              ? "Can't read booking status — the brain isn't answering."
              : `${configuredProviders.length}/3 calendar providers configured · ${repsCount} rep${repsCount === 1 ? "" : "s"}.`
          }
        >
          {bookingData && (
            <>
              <div className="flex flex-wrap gap-1.5">
                {(["google", "microsoft", "calendly"] as const).map((p) => (
                  <Badge
                    key={p}
                    variant={asRecord(providers[p]).configured === true ? "success" : "muted"}
                  >
                    {p}
                  </Badge>
                ))}
                <Badge variant={repsCount > 0 ? "success" : "warning"} className="tabular-nums">
                  {repsCount} rep{repsCount === 1 ? "" : "s"}
                </Badge>
              </div>
              {repsCount === 0 && (
                <FixNote>
                  <span className="font-semibold text-body">No reps yet</span> — a rep binds a
                  calendar to the qualification flows' routing step. Add one via the API below.
                </FixNote>
              )}
              {addRepCurl && (
                <details className="group rounded-md border border-border bg-surface-canvas">
                  <summary className="cursor-pointer select-none px-2.5 py-1.5 text-[0.6875rem] font-medium text-muted-foreground hover:text-foreground">
                    Add reps via API — example curl
                  </summary>
                  <div className="border-t border-border p-1.5">
                    <CopyRow value={addRepCurl} multiline />
                  </div>
                </details>
              )}
            </>
          )}
        </SetupCard>

        {/* ─── 6. Qualification flows ──────────────────────────── */}
        <SetupCard
          title="Qualification flows"
          icon={<Workflow className="size-4" />}
          state={
            !definitions?.data
              ? "unknown"
              : flowIds.length >= EXPECTED_BUILTIN_FLOWS
                ? "ready"
                : flowIds.length > 0
                  ? "partial"
                  : "missing"
          }
          summary={
            !definitions?.data
              ? "Can't read flow definitions — the brain isn't answering."
              : `${flowIds.length} definition${flowIds.length === 1 ? "" : "s"} registered (the brain ships ${EXPECTED_BUILTIN_FLOWS} builtins).`
          }
        >
          {definitions?.data && flowIds.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {flowIds.map((id) => (
                <Badge key={id} variant="muted" className="font-mono font-normal">
                  {id}
                </Badge>
              ))}
            </div>
          )}
        </SetupCard>

        {/* ─── 7. Lead engine sync ─────────────────────────────── */}
        <SetupCard
          title="Lead engine sync"
          icon={<Plug className="size-4" />}
          state={!deploymentId ? "partial" : engineReachable ? "ready" : "missing"}
          summary={
            !deploymentId
              ? "No deployment selected — pick one in the Fleet."
              : engineReachable
                ? `Engine settings reachable for ${deploymentId}.`
                : `The engine data plane (${deploymentId}) isn't answering.`
          }
        >
          {!engineReachable && (
            <FixNote>
              <span className="font-semibold text-body">Fix:</span> run{" "}
              <code className="font-mono">npm run dev -- --with-engine</code> from packages/calla,
              or deploy <code className="font-mono">bi-edge</code> and point the deployment's data
              plane at it. Leads captured by flows sync into <code className="font-mono">/data</code>{" "}
              through this engine.
              {engine?.error && (
                <span className="mt-1 block font-mono text-[0.625rem] text-faint">{engine.error}</span>
              )}
            </FixNote>
          )}
        </SetupCard>

        {/* ─── 8. Website form ─────────────────────────────────── */}
        <SetupCard
          title="Website form"
          icon={<Globe className="size-4" />}
          state={brainEnabled ? "ready" : "missing"}
          summary={
            brainEnabled
              ? "Drop this one-line snippet on any site — it renders the qualification form."
              : "BRAIN_URL is not configured — the widget needs a public brain URL."
          }
        >
          {brainEnabled && (
            <>
              <CopyRow label="Embed snippet" value={widgetSnippet} multiline />
              <a
                href={widgetTestUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-[0.8125rem] text-primary hover:underline"
              >
                Test form
                <ExternalLink className="size-3.5" />
              </a>
            </>
          )}
        </SetupCard>

        {/* ─── 9. Standalone login ─────────────────────────────── */}
        <SetupCard
          title="Standalone login"
          icon={<ShieldCheck className="size-4" />}
          state="ready"
          summary={`Auth mode: ${authMode}.`}
        >
          <FixNote>
            {authMode === "standalone" ? (
              <>
                <span className="font-semibold text-body">Users:</span> the brain issues its own
                JWTs — accounts live in the brain's store. The first user to register becomes the
                admin; everyone else signs in with those credentials.
              </>
            ) : authMode === "disabled" ? (
              <>
                <span className="font-semibold text-body">Users:</span> auth is disabled
                (localhost/LAN dev) — a synthetic local user is used and no login is shown. Set{" "}
                <code className="font-mono">AUTH_MODE=standalone</code> to turn on real logins.
              </>
            ) : (
              <>
                <span className="font-semibold text-body">Users:</span> sessions come from
                agentdeploy.io — subdomain cookie or custom-domain token exchange. No local user
                store is involved.
              </>
            )}
          </FixNote>
        </SetupCard>
      </div>
    </div>
  );
};

SetupSection.displayName = "SetupSection";
