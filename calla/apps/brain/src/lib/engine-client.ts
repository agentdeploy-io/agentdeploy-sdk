/**
 * Shared bi-edge engine data-plane client + edge event relay.
 *
 * Extracted (behavior-preserving) from channels/social/engine.ts so the social
 * lead capture AND the qualification-flow completion path (flows/runner.ts)
 * share ONE implementation of:
 *
 *   • engine data-url derivation — explicit SOCIAL_ENGINE_DATA_URL, else
 *     derived from SOCIAL_ENGINE_SYNC_URL by stripping the trailing
 *     `/inbound/sync` (so `${base}/cmd/data/row` resolves);
 *   • POST-with-one-retry JSON helper (network error or non-2xx → retry once
 *     after 2s; never throws);
 *   • syncLeads(leads)   → POST {leads:[...]} to /inbound/sync (X-AD-Sync);
 *   • patchLead(key, patch) → POST /cmd/data/row {key, patch}. PARTIAL update:
 *     bi-edge updateLead only sets the patched columns, so an already-advanced
 *     lead is NEVER downgraded (stage/status/pitch untouched). Returns
 *     {missing:true} on 404/{updated:false} so callers can re-capture;
 *   • getLeadRow(key) → GET /cmd/data/row?key= (used to merge research blobs
 *     before patching);
 *   • sendCallaMessage(payload) → best-effort POST of a
 *     {type:"calla:message", payload} frame to {CALLA_EDGE_URL}/events/ingest
 *     so the web UI live feed sees flow events (urgent leads, routing
 *     proposals). This is the lightweight sibling of the social approval
 *     relay (calla:approval:request) — no HITL decision attached.
 *
 * Deps: global fetch + @calla/shared frame helpers only.
 */
import { CALLA_EVENTS, callaFrame } from "@calla/shared";

/** One retry after this delay on network error / non-2xx (social capture SLA). */
export const ENGINE_RETRY_DELAY_MS = 2 * 1000;

export interface EngineClientOptions {
  /** Full /inbound/sync URL (default: env SOCIAL_ENGINE_SYNC_URL). */
  syncUrl?: string;
  /** Engine data-plane ORIGIN (default: env derivation, see engineDataUrl()). */
  dataUrl?: string;
  /** X-AD-Sync header value (default: env SOCIAL_ENGINE_SYNC_SECRET). */
  secret?: string;
}

export interface EnginePostResult {
  ok: boolean;
  /** 0 = the fetch itself failed (unreachable). */
  status: number;
  body: any;
  error?: string;
}

function clean(value: string | undefined | null): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Sync endpoint from env (SOCIAL_ENGINE_SYNC_URL). */
export function engineSyncUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return clean(env.SOCIAL_ENGINE_SYNC_URL);
}

/**
 * Engine data-plane ORIGIN: explicit SOCIAL_ENGINE_DATA_URL, else derived from
 * the sync URL by stripping the trailing `/inbound/sync`.
 */
export function engineDataUrl(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const explicit = clean(env.SOCIAL_ENGINE_DATA_URL);
  if (explicit) return stripTrailingSlash(explicit);
  const sync = clean(env.SOCIAL_ENGINE_SYNC_URL);
  if (!sync) return undefined;
  return stripTrailingSlash(sync.replace(/\/inbound\/sync\/?$/i, ""));
}

/** Edge origin for the /events/ingest relay (CALLA_EDGE_URL). */
export function edgeEventsBase(env: NodeJS.ProcessEnv = process.env): string {
  return stripTrailingSlash(
    clean(env.CHANNELS_EDGE_EVENTS_URL) ?? clean(env.CALLA_EDGE_URL) ?? "http://127.0.0.1:8787",
  );
}

function resolveDataUrl(opts?: EngineClientOptions): string | undefined {
  return opts?.dataUrl ?? engineDataUrl();
}

function authHeaders(secret?: string): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const value = secret ?? clean(process.env.SOCIAL_ENGINE_SYNC_SECRET);
  if (value) h["X-AD-Sync"] = value;
  return h;
}

/**
 * POST JSON with ONE retry after ENGINE_RETRY_DELAY_MS on a network error or a
 * non-2xx response. Never throws — {ok, status, body, error?}; status 0 means
 * the fetch itself failed (unreachable).
 */
export async function postJsonRetry(
  url: string,
  body: unknown,
  headers: Record<string, string>,
): Promise<EnginePostResult> {
  let lastError: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await sleep(ENGINE_RETRY_DELAY_MS);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      const text = await res.text().catch(() => "");
      let parsed: any = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = null;
      }
      if (res.ok) return { ok: true, status: res.status, body: parsed };
      lastError = `HTTP ${res.status}: ${text.slice(0, 160)}`;
    } catch (err) {
      lastError = errorMessage(err);
    }
  }
  return { ok: false, status: 0, body: null, error: lastError ?? "unknown" };
}

/** POST the full lead batch to bi-edge /inbound/sync (first-capture path). */
export async function syncLeads(
  leads: Record<string, unknown>[],
  opts?: EngineClientOptions,
): Promise<EnginePostResult> {
  const url = opts?.syncUrl ?? engineSyncUrl();
  if (!url) return { ok: false, status: 0, body: null, error: "no sync url configured" };
  return postJsonRetry(url, { leads }, authHeaders(opts?.secret));
}

/**
 * Partial PATCH of one lead row via /cmd/data/row. {missing:true} when the row
 * is gone (404 or {updated:false}) — callers may fall back to a full re-sync.
 * When no data URL is configured: {ok:false, missing:false} (never clobber).
 */
export async function patchLead(
  key: string,
  patch: Record<string, unknown>,
  opts?: EngineClientOptions,
): Promise<{ ok: boolean; missing: boolean; error?: string }> {
  const base = resolveDataUrl(opts);
  if (!base) return { ok: false, missing: false, error: "no data url configured" };
  const res = await postJsonRetry(
    `${base}/cmd/data/row`,
    { key, patch },
    authHeaders(opts?.secret),
  );
  if (res.status === 404) return { ok: false, missing: true };
  if (res.ok && res.body && res.body.updated === false) return { ok: false, missing: true };
  if (res.ok) return { ok: true, missing: false };
  return { ok: false, missing: false, error: res.error ?? `HTTP ${res.status}` };
}

/**
 * Best-effort read of one lead row (GET /cmd/data/row?key=). Used to MERGE
 * research blobs before patching so existing context is preserved. null on
 * any failure (unreachable, 404, non-JSON).
 */
export async function getLeadRow(
  key: string,
  opts?: EngineClientOptions,
): Promise<Record<string, unknown> | null> {
  const base = resolveDataUrl(opts);
  if (!base) return null;
  try {
    const res = await fetch(
      `${base}/cmd/data/row?key=${encodeURIComponent(key)}`,
      { headers: authHeaders(opts?.secret) },
    );
    if (!res.ok) return null;
    const json = await res.json().catch(() => null);
    return json && typeof json === "object" ? (json as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Best-effort relay of a calla:message frame to {edge}/events/ingest so the
 * web UI live feed sees flow notifications (urgent leads, routing proposals).
 * Never throws; logs on failure.
 */
export async function sendCallaMessage(
  payload: Record<string, unknown>,
  opts?: { edgeBase?: string },
): Promise<void> {
  const base = stripTrailingSlash(opts?.edgeBase ?? edgeEventsBase());
  try {
    const frame = callaFrame(CALLA_EVENTS.message, payload);
    await fetch(`${base}/events/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(frame),
    });
  } catch (err) {
    console.warn("[engine-client] calla:message relay failed:", errorMessage(err));
  }
}
