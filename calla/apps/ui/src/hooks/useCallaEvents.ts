/**
 * useCallaEvents — Edge /events WebSocket feed
 * ────────────────────────────────────────────
 * Subscribes to the Calla edge worker's event bus (GET/WS /events —
 * same-origin via the Vite proxy in dev; production serves /events
 * same-origin or points `url` at https://{worker}.workers.dev/events).
 *
 * Wire contract (frames are JSON CallaWsFrame from @calla/shared):
 *   Server → client on open: calla:hello, then a replay of recent events,
 *   then live calla:* frames (agent:state, approval:request/resolved,
 *   tool:call, message, error, classification:completed, heartbeat, ping).
 *   Every /events frame carries a monotonic string `id` (hub SQLite rowid) —
 *   tracked as a replay cursor. The hub also auto-answers the RAW TEXT frame
 *   "calla:ping" with raw text "calla:pong" (WebSocket DO auto-response, no
 *   JSON) — that pair drives the manager's heartbeat/RTT/zombie detection,
 *   so non-JSON frames are filtered BEFORE JSON.parse.
 *   Client → server: calla:pong (answering a JSON calla:ping) and custom
 *   frames via send().
 *
 * Transport/lifecycle (reconnect backoff + jitter, heartbeat, queueing,
 * online/visibility handling, close-code policy, 4001 token-refresh retry)
 * lives in WsLifecycleManager (@/lib/ws-lifecycle) — this hook is now purely
 * frame processing + React state.
 *
 * Socket sharing (dedupe): managers come from the ref-counted registry
 * (@/lib/ws-registry) keyed by the RESOLVED events URL without token/since.
 * ConsoleEventsProvider and useApprovals both call this hook with the
 * default URL → one key → ONE socket. Each hook instance attaches its own
 * listener and mirrors a module-level per-key feed cache, so buffers survive
 * StrictMode remounts without reconnecting (and without re-opening sockets).
 *
 * Gap-fill replay choice (documented): the URL carries ?since=<cursor> and
 * is rebuilt from the shared cache on EVERY connection attempt (the manager
 * re-invokes the url provider each time), so no calla:subscribe frame is
 * sent — the UI does not use channel scoping, and one mechanism avoids
 * double-replay races.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { AgentEvent, AgentEventType, CallaWsFrame } from "@calla/shared";
import { CALLA_PING_TEXT, CALLA_PONG_TEXT } from "@calla/shared";
import { DEFAULT_AGENT_CONFIG } from "@/constants/agents";
import { buildAuthedWsUrl } from "@/hooks/useAuthFetch";
import { AppError, AppErrors } from "@/errors/AppError";
import { ErrorCode } from "@/constants/errors";
import { errorHandler } from "@/errors/errorHandler";
import { acquireManager } from "@/lib/ws-registry";
import type { WsLifecycleManager, WsState, WsStats } from "@/lib/ws-lifecycle";

// ─── Types ───────────────────────────────────────────────────────

export type CallaEventsStatus = "connecting" | "connected" | "disconnected" | "error";

export interface UseCallaEventsOptions {
  /** Default true. When false the socket is never opened. */
  enabled?: boolean;
  /**
   * WS endpoint. Either a path ("/events" — resolved same-origin) or a
   * full ws(s):// URL. Default: same-origin /events.
   */
  url?: string;
  /**
   * @deprecated Ignored — liveness is now governed by the lifecycle
   * manager's heartbeat (25s ping / 10s pong timeout). Kept for API
   * compatibility.
   */
  livenessTimeoutMs?: number;
}

export interface UseCallaEventsResult {
  status: CallaEventsStatus;
  /** Normalized events, newest LAST, capped at EVENTS_BUFFER_LIMIT. */
  events: AgentEvent[];
  /** Most recent approval_request/approval_resolved frame (normalized). */
  lastApprovalEvent: AgentEvent | null;
  /** Current backoff attempt count (resets on successful connect). */
  reconnectAttempts: number;
  /** Force an immediate reconnect (resets the attempt counter). */
  reconnect: () => void;
  /**
   * Send a frame to the server. Returns true when the frame was written to
   * the open socket OR buffered in the manager's outbound queue (buffered
   * frames flush FIFO on the next open). False only when the queue is
   * disabled/full-drop or the feed is disabled.
   */
  send: (frame: CallaWsFrame) => boolean;
  /** Additive: lifecycle-manager stats snapshot (null when disabled). */
  stats: WsStats | null;
  /** Additive: live stats read without a re-render (null when disabled). */
  getStats: () => WsStats | null;
}

// ─── Constants ───────────────────────────────────────────────────

/** Ring buffer size for normalized events. */
export const EVENTS_BUFFER_LIMIT = 200;

/** Heartbeat: raw-text calla:ping every 25s, pong expected within 10s. */
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/** calla:* frame type → AgentEvent type. Control frames are not mapped. */
const FRAME_TYPE_MAP: Partial<Record<CallaWsFrame["type"], AgentEventType>> = {
  "calla:approval:request": "approval_request",
  "calla:approval:resolved": "approval_resolved",
  "calla:agent:state": "state_change",
  "calla:tool:call": "tool_call",
  "calla:classification:completed": "classification_completed",
  "calla:error": "error",
  "calla:message": "message",
};

/** Control frames that never enter the buffer. */
const LIVENESS_ONLY_FRAMES: ReadonlySet<string> = new Set([
  "calla:hello",
  "calla:heartbeat",
  "calla:ping",
  "calla:pong",
]);

// ─── Shared feed cache (per resolved URL) ────────────────────────
// The socket is shared via the registry; the decoded feed is shared via this
// cache so every hook instance (and every remount) sees the same buffer,
// dedupe set and replay cursor. React state per instance mirrors the cache.

interface SharedFeed {
  events: AgentEvent[];
  /** Ids currently in the buffer — replayed frames dedupe against this. */
  seenIds: Set<string>;
  lastApprovalEvent: AgentEvent | null;
  /** Last frame `id` seen — replayed as ?since= on the next connect. */
  cursor: string | undefined;
}

const sharedFeeds = new Map<string, SharedFeed>();

function feedFor(key: string): SharedFeed {
  let feed = sharedFeeds.get(key);
  if (!feed) {
    feed = { events: [], seenIds: new Set(), lastApprovalEvent: null, cursor: undefined };
    sharedFeeds.set(key, feed);
  }
  return feed;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Resolve the endpoint option into a concrete ws(s) URL. */
export function buildCallaEventsUrl(url?: string): string {
  const raw = url && url.trim().length > 0 ? url.trim() : "/events";
  if (/^wss?:\/\//i.test(raw)) return raw;
  if (/^https?:\/\//i.test(raw)) return raw.replace(/^http/i, "ws");
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const path = raw.startsWith("/") ? raw : `/${raw}`;
  return `${protocol}//${window.location.host}${path}`;
}

/** Append the gap-fill replay cursor to an events URL. */
function withSince(url: string, since: string): string {
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}since=${encodeURIComponent(since)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Normalize a calla:* wire frame into an AgentEvent entity.
 * Returns null for control frames and unmappable types.
 *
 * Identity: the hub envelope `id` (monotonic, present on every stamped
 * /events frame) is preferred — it makes buffer dedupe exact across
 * reconnect replays. Frames without an envelope id fall back to the legacy
 * payload.id/payload.eventId, then to a synthetic ts+random id.
 */
export function normalizeCallaFrame(frame: CallaWsFrame): AgentEvent | null {
  const type = FRAME_TYPE_MAP[frame.type];
  if (!type) return null;

  const payload = asRecord(frame.payload);
  const id =
    (typeof frame.id === "string" && frame.id) ||
    (typeof payload.id === "string" && payload.id) ||
    (typeof payload.eventId === "string" && payload.eventId) ||
    `evt-${frame.ts ?? Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const agentId =
    frame.agentId ??
    (typeof payload.agentId === "string" ? payload.agentId : undefined) ??
    "unknown";

  return {
    id,
    agentId,
    type,
    payload: frame.payload ?? null,
    timestamp: new Date(frame.ts ?? Date.now()).toISOString(),
  };
}

/** Manager state → the (unchanged) public CallaEventsStatus union. */
function mapEventsState(state: WsState): CallaEventsStatus {
  switch (state) {
    case "open":
    case "degraded":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "closed":
    case "failed":
    case "idle":
    default:
      return "disconnected";
  }
}

/** Display attempt count: 0 while the socket is up (matches old reset-on-open). */
function displayAttempts(stats: WsStats): number {
  return stats.state === "open" || stats.state === "degraded" ? 0 : stats.attempts;
}

// ─── Hook ────────────────────────────────────────────────────────

export function useCallaEvents(options: UseCallaEventsOptions = {}): UseCallaEventsResult {
  const { enabled = true, url } = options;

  // Registry key: resolved events URL WITHOUT token/since — every consumer
  // of the same endpoint shares one manager (one socket).
  const resolvedUrl = useMemo(() => (enabled ? buildCallaEventsUrl(url) : ""), [enabled, url]);

  const [status, setStatus] = useState<CallaEventsStatus>(enabled ? "connecting" : "disconnected");
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [lastApprovalEvent, setLastApprovalEvent] = useState<AgentEvent | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [stats, setStats] = useState<WsStats | null>(null);

  const managerRef = useRef<WsLifecycleManager | null>(null);

  // ─── Frame processing (shared-cache backed) ───────────────────

  const processRaw = useCallback((raw: string, feed: SharedFeed, manager: WsLifecycleManager) => {
    // The hub answers calla:ping with the RAW TEXT "calla:pong" (DO
    // auto-response) — non-JSON frames are filtered before JSON.parse.
    let frame: CallaWsFrame;
    try {
      frame = JSON.parse(raw) as CallaWsFrame;
    } catch {
      return;
    }
    if (!frame || typeof frame.type !== "string") return;

    // Legacy heartbeat protocol: answer JSON pings with JSON pongs.
    if (frame.type === "calla:ping") {
      manager.send(JSON.stringify({ type: "calla:pong", ts: Date.now() } satisfies CallaWsFrame));
      return;
    }

    // Control frames never enter the buffer.
    if (LIVENESS_ONLY_FRAMES.has(frame.type)) return;

    // Cursor: every stamped frame advances the replay cursor (both the
    // shared cache — read by the url factory — and the manager's stats).
    if (typeof frame.id === "string" && frame.id) {
      feed.cursor = frame.id;
      manager.setCursor(frame.id);
    }

    const normalized = normalizeCallaFrame(frame);
    if (!normalized) return;

    // calla:error frames surface through the centralized error handler too.
    if (normalized.type === "error") {
      const payload = asRecord(normalized.payload);
      const appError = new AppError(ErrorCode.AGENT_RPC_FAILED, {
        message:
          (typeof payload.message === "string" && payload.message) ||
          (typeof payload.error === "string" && payload.error) ||
          "Agent reported an error on the event feed",
        context: { agentId: normalized.agentId, source: "calla-events" },
      });
      errorHandler.handleError(appError, { agentId: normalized.agentId, showToast: false });
    }

    const isApproval =
      normalized.type === "approval_request" || normalized.type === "approval_resolved";

    // Dedupe by frame id (the server gap-fills after reconnect).
    if (!feed.seenIds.has(normalized.id)) {
      feed.seenIds.add(normalized.id);
      feed.events = [...feed.events, normalized];
      if (feed.events.length > EVENTS_BUFFER_LIMIT) {
        const dropped = feed.events.slice(0, feed.events.length - EVENTS_BUFFER_LIMIT);
        for (const d of dropped) feed.seenIds.delete(d.id);
        feed.events = feed.events.slice(-EVENTS_BUFFER_LIMIT);
      }
    }
    if (isApproval) {
      feed.lastApprovalEvent = normalized;
      setLastApprovalEvent(normalized);
    }
    // Sync this instance's mirror from the shared cache (another listener
    // may have appended first — every instance converges on the cache).
    setEvents(feed.events);
  }, []);

  // ─── Lifecycle ────────────────────────────────────────────────

  useEffect(() => {
    if (!enabled || !resolvedUrl) {
      managerRef.current = null;
      setStatus("disconnected");
      setReconnectAttempts(0);
      setStats(null);
      return;
    }

    const feed = feedFor(resolvedUrl);
    // Hydrate from the shared cache — survives StrictMode remounts and
    // provider swaps without reconnecting or re-replaying.
    setEvents(feed.events);
    setLastApprovalEvent(feed.lastApprovalEvent);

    const { manager, release } = acquireManager(resolvedUrl, () => ({
      // Re-invoked on EVERY attempt: fresh edge JWT (5-min TTL) and the
      // latest replay cursor (?since gap-fill — the single replay
      // mechanism; no calla:subscribe frame is sent).
      url: () =>
        buildAuthedWsUrl(feed.cursor ? withSince(resolvedUrl, feed.cursor) : resolvedUrl),
      heartbeat: {
        intervalMs: HEARTBEAT_INTERVAL_MS,
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        pingText: CALLA_PING_TEXT,
        isPong: (message) => message === CALLA_PONG_TEXT,
      },
      backoff: { baseMs: DEFAULT_AGENT_CONFIG.reconnectBaseDelay, maxMs: 30_000, jitter: "full" },
      // Infinite retries with a 60s slow poll beyond the budget — overnight
      // tabs always recover (the old hard give-up after 5 attempts is gone).
      maxAttempts: DEFAULT_AGENT_CONFIG.autoReconnect ? Number.POSITIVE_INFINITY : 0,
      slowRetryMs: 60_000,
      connectionTimeoutMs: 8_000,
      minUptimeMs: 5_000,
      queue: { enabled: true, maxSize: 100 },
      label: "calla-events",
      // All frame handling happens in per-instance listeners below — the
      // shared manager's primary handler stays a no-op.
      onMessage: () => {},
      onError: (error) => {
        const appError = AppErrors.connectionFailed("calla-events", new Error(error.message));
        errorHandler.handleError(appError, { showToast: false });
      },
    }));
    managerRef.current = manager;

    const removeListener = manager.addListener({
      onMessage: (raw) => processRaw(raw, feed, manager),
      onStateChange: (_state, nextStats) => {
        setStatus(mapEventsState(nextStats.state));
        setReconnectAttempts(displayAttempts(nextStats));
        setStats(nextStats);
      },
    });

    const initial = manager.getStats();
    setStatus(mapEventsState(initial.state));
    setReconnectAttempts(displayAttempts(initial));
    setStats(initial);

    return () => {
      removeListener();
      managerRef.current = null;
      release();
    };
  }, [enabled, resolvedUrl, processRaw]);

  // ─── Public actions ───────────────────────────────────────────

  const reconnect = useCallback(() => {
    managerRef.current?.forceReconnect();
  }, []);

  const send = useCallback((frame: CallaWsFrame): boolean => {
    const manager = managerRef.current;
    if (!manager) return false;
    return manager.send(JSON.stringify(frame)) !== "dropped";
  }, []);

  const getStats = useCallback((): WsStats | null => managerRef.current?.getStats() ?? null, []);

  return {
    status,
    events,
    lastApprovalEvent,
    reconnectAttempts,
    reconnect,
    send,
    stats,
    getStats,
  };
}
