/**
 * WsLifecycleManager — framework-agnostic WebSocket lifecycle engine
 * ──────────────────────────────────────────────────────────────────
 * Owns everything transport-level for ONE socket:
 *
 *   - Connect with a url provider that is re-invoked on EVERY attempt
 *     (fresh edge JWT per attempt — tokens have a 5-minute TTL).
 *   - Exponential backoff with full/equal/none jitter; the attempt counter
 *     resets only after the socket stays up for `minUptimeMs`.
 *   - Flapping detection: 3 consecutive short-lived closes force the next
 *     backoff delay to `maxMs` (exposed via stats.flapping).
 *   - Connection timeout: a socket stuck in CONNECTING is killed and retried.
 *   - Optional application heartbeat: raw-text ping every `intervalMs`; if no
 *     pong (or any inbound frame — liveness is folded in) arrives within
 *     `timeoutMs` the socket is treated as a zombie, force-closed and
 *     reconnected. Pass `heartbeat: null` for servers that don't answer
 *     app-level pings (e.g. the Agents SDK cf_agent_* sockets).
 *   - Close-code policy: clean self-initiated closes are terminal ("closed");
 *     4001 (unauthorized) triggers ONE immediate fast retry with a freshly
 *     re-invoked url provider (new token) — a second consecutive 4001 moves
 *     to "failed" and surfaces onError (no spin). Everything else unexpected
 *     (1006/1011/1012/1013, server-side 1001/1000, 4xxx…) is retryable.
 *   - `maxAttempts` (default Infinity): once exceeded the manager keeps
 *     polling at `slowRetryMs` cadence instead of dying — overnight tabs
 *     always recover. maxAttempts=0 disables retries entirely.
 *   - window "online" → immediate forceReconnect (attempts reset);
 *     "offline" → suspend retries and mark "degraded" until back online;
 *     visibilitychange hidden → pause heartbeat sends (socket kept);
 *     visible → resume heartbeat, and reconnect if the socket died while
 *     the tab was hidden.
 *   - Outbound queue: send() while not OPEN enqueues (FIFO, drop-oldest at
 *     `maxSize`) and flushes after onOpen resolves on the next open.
 *   - Cursor: consumers track a server replay cursor via setCursor(); it is
 *     handed back in onOpen info (lastCursor) and stats so url factories can
 *     request gap-fill replay.
 *
 * The manager is deliberately dumb about React/StrictMode: sharing across
 * hook instances goes through the ref-counted registry (./ws-registry.ts).
 * Additional consumers attach via addListener() — every listener sees the
 * same onMessage/onStateChange/onOpen/onQueueFlush/onError traffic.
 */

// ─── Types ───────────────────────────────────────────────────────

export type WsState =
  | "idle"
  | "connecting"
  | "open"
  | "degraded"
  | "reconnecting"
  | "closed"
  | "failed";

export type WsJitter = "full" | "equal" | "none";

export interface WsHeartbeatConfig {
  /** Ping cadence (default 25_000 — matches the edge hub heartbeat). */
  intervalMs?: number;
  /** No pong within this window after a ping → zombie (default 10_000). */
  timeoutMs?: number;
  /** Raw text frame sent as the ping (NOT wrapped in JSON). */
  pingText: string;
  /** True when an inbound raw frame is the pong for our ping. */
  isPong(message: string): boolean;
}

export interface WsBackoffConfig {
  /** First backoff cap (default 1_000). */
  baseMs?: number;
  /** Backoff ceiling (default 30_000). */
  maxMs?: number;
  /** Jitter strategy (default "full" — AWS-style full jitter). */
  jitter?: WsJitter;
}

export interface WsQueueConfig {
  /** Buffer outbound sends while the socket is down (default true). */
  enabled?: boolean;
  /** Drop-oldest cap (default 100). */
  maxSize?: number;
}

export interface WsOpenInfo {
  /** True when this open follows an earlier open on the same manager. */
  isReconnect: boolean;
  /** Number of successful re-opens (0 on the first open). */
  reconnectCount: number;
  /** Last cursor set via setCursor() — for gap-fill replay. */
  lastCursor?: string;
}

export interface WsErrorInfo {
  message: string;
  /** Close code when the error came from a close (e.g. 4001). */
  code?: number;
  /** Fatal errors stop the reconnect loop ("failed" state). */
  fatal: boolean;
  cause?: unknown;
}

export interface WsStats {
  state: WsState;
  /** Consecutive failed attempts (resets after minUptimeMs of stability). */
  attempts: number;
  /** Successful re-opens over the manager lifetime. */
  reconnects: number;
  lastCloseCode: number | null;
  lastCloseReason: string;
  /** Last ping→pong round-trip in ms (null until the first pong). */
  rttMs: number | null;
  queueDepth: number;
  bytesSent: number;
  bytesRecv: number;
  /** Epoch ms of the current open (null when not open). */
  connectedAt: number | null;
  uptimeMs: number;
  /** True while the socket is flapping (3 consecutive short-lived closes). */
  flapping: boolean;
  lastCursor?: string;
}

/** Result of send(): direct write, buffered for the next open, or dropped. */
export type WsSendResult = "sent" | "queued" | "dropped";

export interface WsLifecycleOptions {
  /**
   * Endpoint or provider. Providers are re-invoked on EVERY connection
   * attempt so auth tokens/cursors embedded in the URL stay fresh.
   */
  url: string | (() => string | Promise<string>);
  protocols?: string | string[];
  /** App-level ping/pong + zombie watchdog. null disables (default 25s). */
  heartbeat?: WsHeartbeatConfig | null;
  backoff?: WsBackoffConfig;
  /** Retry budget before falling back to slowRetryMs polling (default ∞). */
  maxAttempts?: number;
  /** Poll cadence once maxAttempts is exceeded (default 60_000). */
  slowRetryMs?: number;
  /** Kill a CONNECTING socket after this long (default 8_000). */
  connectionTimeoutMs?: number;
  /** Uptime needed to consider a connection stable (default 5_000). */
  minUptimeMs?: number;
  queue?: WsQueueConfig;
  /** Reconnect immediately when the browser comes back online (default true). */
  reconnectOnOnline?: boolean;
  /** Reconnect when the tab becomes visible with a dead socket (default true). */
  reconnectOnVisible?: boolean;
  /** May be async — the outbound queue flushes after it resolves. */
  onOpen?(info: WsOpenInfo): void | Promise<void>;
  /** Every inbound TEXT frame (including heartbeat pongs — filter yourself). */
  onMessage(raw: string): void;
  onStateChange?(state: WsState, stats: WsStats): void;
  onQueueFlush?(info: { count: number }): void;
  onError?(error: WsErrorInfo): void;
  /** Label used in error messages / debugging. */
  label?: string;
}

/** Extra consumer attached to an already-constructed manager. */
export interface WsListener {
  onMessage?(raw: string): void;
  onStateChange?(state: WsState, stats: WsStats): void;
  onOpen?(info: WsOpenInfo): void | Promise<void>;
  onQueueFlush?(info: { count: number }): void;
  onError?(error: WsErrorInfo): void;
}

// ─── Constants ───────────────────────────────────────────────────

const DEFAULT_HEARTBEAT_INTERVAL_MS = 25_000;
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 1_000;
const DEFAULT_BACKOFF_MAX_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = Number.POSITIVE_INFINITY;
const DEFAULT_SLOW_RETRY_MS = 60_000;
const DEFAULT_CONNECTION_TIMEOUT_MS = 8_000;
const DEFAULT_MIN_UPTIME_MS = 5_000;
const DEFAULT_QUEUE_MAX_SIZE = 100;
/** Flapping = this many consecutive closes under minUptimeMs. */
const FLAP_CLOSE_COUNT = 3;
/** App close code for "unauthorized" (see CALLA_WS_CLOSE in @calla/shared). */
const CLOSE_UNAUTHORIZED = 4001;

// readyState constant — inlined so the manager works with injected/stubbed
// WebSocket implementations that don't define the statics.
const RS_OPEN = 1;

const byteEncoder = typeof TextEncoder !== "undefined" ? new TextEncoder() : null;

function byteLength(data: string): number {
  return byteEncoder ? byteEncoder.encode(data).length : data.length;
}

function isDocumentHidden(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "hidden";
}

function isBrowserOffline(): boolean {
  return typeof navigator !== "undefined" && navigator.onLine === false;
}

// ─── Manager ─────────────────────────────────────────────────────

export class WsLifecycleManager {
  private readonly opts: WsLifecycleOptions;
  private readonly heartbeat: Required<Pick<WsHeartbeatConfig, "intervalMs" | "timeoutMs">> &
    Pick<WsHeartbeatConfig, "pingText" | "isPong"> | null;
  private readonly backoff: Required<WsBackoffConfig>;
  private readonly maxAttempts: number;
  private readonly slowRetryMs: number;
  private readonly connectionTimeoutMs: number;
  private readonly minUptimeMs: number;
  private readonly queueEnabled: boolean;
  private readonly queueMaxSize: number;
  private readonly reconnectOnOnline: boolean;
  private readonly reconnectOnVisible: boolean;
  private readonly label: string;

  private ws: WebSocket | null = null;
  private state: WsState = "idle";
  private generation = 0;
  private listeners = new Set<WsListener>();

  // Retry / stability bookkeeping
  private attempts = 0;
  private reconnects = 0;
  private hasOpenedBefore = false;
  private flapping = false;
  private shortCloses: number[] = [];
  private consecutive4001 = 0;
  private closedBySelf = false;
  private offline = false;

  // Timers
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private pongTimer: ReturnType<typeof setTimeout> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;

  // Queue + stats
  private queue: string[] = [];
  private lastCloseCode: number | null = null;
  private lastCloseReason = "";
  private rttMs: number | null = null;
  private pingSentAt: number | null = null;
  private bytesSent = 0;
  private bytesRecv = 0;
  private connectedAt: number | null = null;
  private cursor: string | undefined = undefined;

  // Window listeners (bound once)
  private readonly boundOnline = (): void => this.handleOnline();
  private readonly boundOffline = (): void => this.handleOffline();
  private readonly boundVisibility = (): void => this.handleVisibility();
  private windowAttached = false;

  constructor(options: WsLifecycleOptions) {
    this.opts = options;
    this.label = options.label ?? "ws";
    this.heartbeat = options.heartbeat
      ? {
          intervalMs: options.heartbeat.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS,
          timeoutMs: options.heartbeat.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS,
          pingText: options.heartbeat.pingText,
          isPong: options.heartbeat.isPong,
        }
      : null;
    this.backoff = {
      baseMs: options.backoff?.baseMs ?? DEFAULT_BACKOFF_BASE_MS,
      maxMs: options.backoff?.maxMs ?? DEFAULT_BACKOFF_MAX_MS,
      jitter: options.backoff?.jitter ?? "full",
    };
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.slowRetryMs = options.slowRetryMs ?? DEFAULT_SLOW_RETRY_MS;
    this.connectionTimeoutMs = options.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS;
    this.minUptimeMs = options.minUptimeMs ?? DEFAULT_MIN_UPTIME_MS;
    this.queueEnabled = options.queue?.enabled ?? true;
    this.queueMaxSize = options.queue?.maxSize ?? DEFAULT_QUEUE_MAX_SIZE;
    this.reconnectOnOnline = options.reconnectOnOnline ?? true;
    this.reconnectOnVisible = options.reconnectOnVisible ?? true;
    this.offline = isBrowserOffline();

    this.attachWindowListeners();
    // Auto-connect: the manager is live as soon as it exists. Sharing across
    // consumers is the registry's job; StrictMode remounts re-acquire the
    // same instance instead of churning sockets.
    this.connectAttempt();
  }

  // ─── Public API ───────────────────────────────────────────────

  getState(): WsState {
    return this.state;
  }

  getStats(): WsStats {
    const live = this.state === "open" || this.state === "degraded";
    return {
      state: this.state,
      attempts: this.attempts,
      reconnects: this.reconnects,
      lastCloseCode: this.lastCloseCode,
      lastCloseReason: this.lastCloseReason,
      rttMs: this.rttMs,
      queueDepth: this.queue.length,
      bytesSent: this.bytesSent,
      bytesRecv: this.bytesRecv,
      connectedAt: this.connectedAt,
      uptimeMs: live && this.connectedAt !== null ? Date.now() - this.connectedAt : 0,
      flapping: this.flapping,
      lastCursor: this.cursor,
    };
  }

  /** Attach an extra consumer. Returns its removal function. */
  addListener(listener: WsListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Send a text frame. OPEN → written immediately ("sent"); otherwise
   * buffered when the queue is enabled ("queued", FIFO, drop-oldest at
   * maxSize) and flushed after onOpen resolves on the next open.
   */
  send(data: string): WsSendResult {
    const ws = this.ws;
    if (ws && ws.readyState === RS_OPEN) {
      try {
        ws.send(data);
        this.bytesSent += byteLength(data);
        return "sent";
      } catch {
        // Fall through to the queue — the close handler will reconnect.
      }
    }
    if (!this.queueEnabled || this.closedBySelf) return "dropped";
    this.queue.push(data);
    while (this.queue.length > this.queueMaxSize) this.queue.shift();
    return "queued";
  }

  /**
   * Immediate reconnect: resets the attempt/flap/4001 counters, kills the
   * current socket (if any) and connects NOW. Works from every state,
   * including the terminal ones ("closed"/"failed").
   */
  forceReconnect(): void {
    this.closedBySelf = false;
    this.attempts = 0;
    this.flapping = false;
    this.shortCloses = [];
    this.consecutive4001 = 0;
    this.clearRetryTimer();
    this.attachWindowListeners();
    this.killSocket();
    this.connectedAt = null;
    this.connectAttempt();
  }

  /**
   * Terminal close. No reconnect afterwards (until forceReconnect()).
   * Default code 1000 — per the close-code policy this never retries.
   */
  close(code = 1000, reason = "client closed"): void {
    this.closedBySelf = true;
    this.clearAllTimers();
    this.detachWindowListeners();
    const ws = this.ws;
    this.ws = null;
    this.generation += 1;
    if (ws) {
      this.detachSocket(ws);
      try {
        ws.close(code, reason);
      } catch {
        // already closing/closed
      }
    }
    this.connectedAt = null;
    this.stopHeartbeat();
    this.setState("closed");
  }

  /** Replay cursor — consumers update it from inbound frame ids. */
  setCursor(cursor: string | undefined): void {
    this.cursor = cursor;
  }

  getCursor(): string | undefined {
    return this.cursor;
  }

  // ─── Connection ───────────────────────────────────────────────

  private connectAttempt(): void {
    if (this.closedBySelf) return;
    if (this.offline) {
      this.setState("degraded");
      return;
    }
    this.clearRetryTimer();
    this.setState("connecting");

    const gen = ++this.generation;
    void (async () => {
      // The url provider runs on EVERY attempt — fresh token, fresh cursor.
      let url: string;
      try {
        url = typeof this.opts.url === "function" ? await this.opts.url() : this.opts.url;
      } catch (cause) {
        if (gen !== this.generation || this.closedBySelf) return;
        this.emitError({
          message: `${this.label}: url provider failed`,
          fatal: false,
          cause,
        });
        this.registerFailure(null, "url-provider-failed", false, 0);
        return;
      }
      if (gen !== this.generation || this.closedBySelf) return;

      let ws: WebSocket;
      try {
        ws = this.opts.protocols
          ? new WebSocket(url, this.opts.protocols)
          : new WebSocket(url);
      } catch (cause) {
        if (gen !== this.generation || this.closedBySelf) return;
        this.emitError({
          message: `${this.label}: WebSocket construction failed`,
          fatal: false,
          cause,
        });
        this.registerFailure(null, "constructor-failed", false, 0);
        return;
      }

      this.ws = ws;
      ws.onopen = () => {
        if (gen === this.generation) void this.handleOpen(gen);
      };
      ws.onmessage = (event: MessageEvent) => {
        if (gen === this.generation) this.handleMessage(event);
      };
      ws.onerror = () => {
        // Not descriptive on its own — onclose follows and drives the FSM.
      };
      ws.onclose = (event: CloseEvent) => {
        if (gen === this.generation) this.handleClose(gen, event);
      };
      this.armConnectTimeout(gen, ws);
    })();
  }

  private armConnectTimeout(gen: number, ws: WebSocket): void {
    this.clearConnectTimeout();
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      if (gen !== this.generation || this.ws !== ws) return;
      if (ws.readyState === RS_OPEN) return;
      // Stuck in CONNECTING (dead proxy, captive portal) — kill and retry.
      this.ws = null;
      this.detachSocket(ws);
      try {
        ws.close();
      } catch {
        // ignore
      }
      this.registerFailure(null, "connection-timeout", false, 0);
    }, this.connectionTimeoutMs);
  }

  private async handleOpen(gen: number): Promise<void> {
    this.clearConnectTimeout();
    this.connectedAt = Date.now();
    this.consecutive4001 = 0;

    const isReconnect = this.hasOpenedBefore;
    if (isReconnect) this.reconnects += 1;
    this.hasOpenedBefore = true;

    this.setState("open");
    this.startHeartbeat();

    // Stable-uptime timer: only now does the attempt counter reset.
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      if (gen !== this.generation) return;
      if (this.state !== "open" && this.state !== "degraded") return;
      this.attempts = 0;
      this.flapping = false;
      this.shortCloses = [];
      // Re-emit the (unchanged) state so consumers refresh stats.attempts.
      this.setState(this.state, true);
    }, this.minUptimeMs);

    const info: WsOpenInfo = {
      isReconnect,
      reconnectCount: this.reconnects,
      lastCursor: this.cursor,
    };
    try {
      await this.opts.onOpen?.(info);
      for (const listener of [...this.listeners]) {
        await listener.onOpen?.(info);
      }
    } catch (cause) {
      this.emitError({ message: `${this.label}: onOpen handler failed`, fatal: false, cause });
    }
    if (gen === this.generation && !this.closedBySelf) {
      this.flushQueue();
    }
  }

  private handleMessage(event: MessageEvent): void {
    const raw = typeof event.data === "string" ? event.data : null;
    if (raw === null) return; // binary frames are not part of the protocol
    this.bytesRecv += byteLength(raw);

    if (this.heartbeat) {
      if (this.pingSentAt !== null && this.heartbeat.isPong(raw)) {
        this.rttMs = Date.now() - this.pingSentAt;
        this.pingSentAt = null;
      }
      // Liveness watchdog folded into the heartbeat: ANY inbound frame
      // proves the socket is alive, so it clears a pending pong timeout.
      this.clearPongTimer();
    }

    this.opts.onMessage(raw);
    for (const listener of [...this.listeners]) {
      listener.onMessage?.(raw);
    }
  }

  private handleClose(gen: number, event: CloseEvent): void {
    if (gen !== this.generation) return;
    this.clearConnectTimeout();
    this.stopHeartbeat();
    this.ws = null;

    this.lastCloseCode = event.code;
    this.lastCloseReason = event.reason ?? "";

    // Terminal: self-initiated close (close()/registry release).
    if (this.closedBySelf) {
      this.connectedAt = null;
      this.setState("closed");
      return;
    }

    // 4001 unauthorized: one immediate fast retry with a freshly re-invoked
    // url provider (new token). A second consecutive 4001 is fatal — the
    // token source itself is broken; spinning would hammer the auth path.
    if (event.code === CLOSE_UNAUTHORIZED) {
      this.consecutive4001 += 1;
      this.connectedAt = null;
      if (this.consecutive4001 === 1) {
        this.setState("reconnecting");
        this.scheduleRetry(0);
        return;
      }
      this.emitError({
        message: `${this.label}: unauthorized (4001) after token-refresh retry`,
        code: CLOSE_UNAUTHORIZED,
        fatal: true,
      });
      this.setState("failed");
      return;
    }
    this.consecutive4001 = 0;

    const hadOpened = this.connectedAt !== null;
    const uptime = this.uptimeSoFar();
    this.connectedAt = null;
    this.registerFailure(event.code, event.reason || "", hadOpened, uptime);
  }

  /**
   * Shared failure path for closes, connect timeouts, zombie kills and
   * url/constructor errors. Bookkeeping + retry scheduling.
   */
  private registerFailure(
    code: number | null,
    reason: string,
    hadOpened: boolean,
    uptimeMs: number,
  ): void {
    if (code !== null) this.lastCloseCode = code;
    if (reason) this.lastCloseReason = reason;
    this.attempts += 1;

    // Flapping: short-lived connections in a row → force maxMs backoff so we
    // stop hammering a server that accepts then immediately drops us.
    if (!hadOpened || uptimeMs < this.minUptimeMs) {
      this.shortCloses.push(Date.now());
      if (this.shortCloses.length > FLAP_CLOSE_COUNT) this.shortCloses.shift();
      if (this.shortCloses.length >= FLAP_CLOSE_COUNT) this.flapping = true;
    }

    if (this.closedBySelf) {
      this.setState("closed");
      return;
    }
    if (this.maxAttempts <= 0) {
      this.emitError({
        message: `${this.label}: reconnect disabled (maxAttempts=0)`,
        code: code ?? undefined,
        fatal: true,
      });
      this.setState("failed");
      return;
    }
    if (this.offline) {
      // Suspend retries until the "online" event fires.
      this.setState("degraded");
      return;
    }
    this.setState("reconnecting");
    this.scheduleRetry(this.backoffDelay());
  }

  /** Jittered backoff for the CURRENT attempts count (>= 1). */
  private backoffDelay(): number {
    // Budget exhausted → slow poll wins even while flapping (it is the
    // gentler cadence; the manager never dies).
    if (this.attempts > this.maxAttempts) return this.slowRetryMs;
    if (this.flapping) return this.backoff.maxMs;
    const cap = Math.min(
      this.backoff.maxMs,
      this.backoff.baseMs * Math.pow(2, this.attempts - 1),
    );
    switch (this.backoff.jitter) {
      case "none":
        return cap;
      case "equal":
        return cap / 2 + Math.random() * (cap / 2);
      case "full":
      default:
        // Full jitter: uniform(0, cap) — AWS-style, best thundering-herd
        // diffusion; expected delay is cap/2.
        return Math.random() * cap;
    }
  }

  private scheduleRetry(delayMs: number): void {
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connectAttempt();
    }, delayMs);
  }

  private uptimeSoFar(): number {
    return this.connectedAt !== null ? Date.now() - this.connectedAt : 0;
  }

  // ─── Heartbeat / zombie watchdog ──────────────────────────────

  private startHeartbeat(): void {
    if (!this.heartbeat || this.heartbeatTimer) return;
    if (isDocumentHidden()) return; // resumed by the visibility handler
    this.heartbeatTimer = setInterval(() => this.sendPing(), this.heartbeat.intervalMs);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.clearPongTimer();
    this.pingSentAt = null;
  }

  private sendPing(): void {
    const hb = this.heartbeat;
    const ws = this.ws;
    if (!hb || !ws || ws.readyState !== RS_OPEN) return;
    try {
      ws.send(hb.pingText);
      this.bytesSent += byteLength(hb.pingText);
    } catch {
      return; // the close handler drives recovery
    }
    this.pingSentAt = Date.now();
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      this.pongTimer = null;
      this.handleZombie();
    }, hb.timeoutMs);
  }

  /** No pong (and no inbound frame at all) within the window → half-open. */
  private handleZombie(): void {
    const hadOpened = this.connectedAt !== null;
    const uptime = this.uptimeSoFar();
    this.killSocket();
    this.connectedAt = null;
    this.stopHeartbeat();
    this.registerFailure(null, "heartbeat-timeout", hadOpened, uptime);
  }

  // ─── Queue ────────────────────────────────────────────────────

  private flushQueue(): void {
    if (this.queue.length === 0) return;
    const ws = this.ws;
    if (!ws || ws.readyState !== RS_OPEN) return;
    const items = this.queue.splice(0, this.queue.length);
    let sent = 0;
    for (const item of items) {
      try {
        ws.send(item);
        this.bytesSent += byteLength(item);
        sent += 1;
      } catch {
        // Socket died mid-flush — put the remainder back (FIFO order kept).
        this.queue.unshift(...items.slice(sent));
        break;
      }
    }
    if (sent > 0) {
      const info = { count: sent };
      this.opts.onQueueFlush?.(info);
      for (const listener of [...this.listeners]) {
        listener.onQueueFlush?.(info);
      }
    }
  }

  // ─── Network / visibility ─────────────────────────────────────

  private attachWindowListeners(): void {
    if (this.windowAttached || typeof window === "undefined") return;
    window.addEventListener("online", this.boundOnline);
    window.addEventListener("offline", this.boundOffline);
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", this.boundVisibility);
    }
    this.windowAttached = true;
  }

  private detachWindowListeners(): void {
    if (!this.windowAttached || typeof window === "undefined") return;
    window.removeEventListener("online", this.boundOnline);
    window.removeEventListener("offline", this.boundOffline);
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.boundVisibility);
    }
    this.windowAttached = false;
  }

  private handleOnline(): void {
    this.offline = false;
    if (!this.reconnectOnOnline || this.closedBySelf) return;
    if (this.state !== "open") this.forceReconnect();
  }

  private handleOffline(): void {
    this.offline = true;
    if (this.state === "connecting" || this.state === "reconnecting") {
      this.clearRetryTimer();
      this.setState("degraded");
    } else if (this.state === "open") {
      this.setState("degraded");
    }
  }

  private handleVisibility(): void {
    if (isDocumentHidden()) {
      // Keep the socket, stop pinging — background timers are throttled and
      // a missed pong would kill a perfectly good connection.
      this.stopHeartbeat();
      return;
    }
    const ws = this.ws;
    if (ws && ws.readyState === RS_OPEN) {
      this.startHeartbeat();
      return;
    }
    if (this.reconnectOnVisible && !this.closedBySelf && !isBrowserOffline()) {
      if (this.state !== "open") this.forceReconnect();
    }
  }

  // ─── Internals ────────────────────────────────────────────────

  private killSocket(): void {
    const ws = this.ws;
    this.ws = null;
    this.generation += 1;
    this.stopHeartbeat();
    this.clearConnectTimeout();
    if (ws) {
      this.detachSocket(ws);
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }

  private detachSocket(ws: WebSocket): void {
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
  }

  private setState(next: WsState, force = false): void {
    if (next === this.state && !force) return;
    this.state = next;
    const stats = this.getStats();
    this.opts.onStateChange?.(next, stats);
    for (const listener of [...this.listeners]) {
      listener.onStateChange?.(next, stats);
    }
  }

  private emitError(error: WsErrorInfo): void {
    this.opts.onError?.(error);
    for (const listener of [...this.listeners]) {
      listener.onError?.(error);
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private clearConnectTimeout(): void {
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer) {
      clearTimeout(this.pongTimer);
      this.pongTimer = null;
    }
  }

  private clearStableTimer(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private clearAllTimers(): void {
    this.clearRetryTimer();
    this.clearConnectTimeout();
    this.clearPongTimer();
    this.clearStableTimer();
    this.stopHeartbeat();
  }
}
