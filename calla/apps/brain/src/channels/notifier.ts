/**
 * ApprovalNotifier — proactively pushes HITL approvals to bound chats.
 *
 * Two sources, one deduped notify path:
 *   1. A WebSocket to the edge worker's /events stream (global WebSocket,
 *      http->ws / https->wss). Own tiny reconnect (1s*2^n capped 30s + jitter,
 *      infinite), a raw "calla:ping" every 60s (the hub auto-pongs without
 *      waking the DO), and ?since=<cursor> replay on reconnect. Frames of type
 *      calla:approval:request -> ApprovalRequest; calla:approval:resolved ->
 *      best-effort follow-up to the chats we notified.
 *   2. A 15s poller of deps.listPendingMastra() for brain-side approvals
 *      (buttons encode source "mastra" + runId/toolCallId).
 *
 * Dedupe via store cache key "chan:notified:<id>" (TTL 24h). Resilient: every
 * WS/store/send failure is caught + console.warn'd — never crashes the server.
 */
import {
  CALLA_EVENTS,
  CALLA_PING_TEXT,
  CALLA_PONG_TEXT,
  type ApprovalRequest,
  type CallaWsFrame,
} from "@calla/shared";
import { buildApprovalCard } from "./decisions.js";
import { CHANNELS_CACHE_AGENT } from "./bindings.js";
import type {
  ChannelAdapter,
  ChannelDeps,
  ChannelPlatform,
  DecisionRegistry,
  BindingStore,
} from "./types.js";
import { errorMessage } from "./util.js";

/** Minimal structural type for the global WebSocket we drive (Node 22). */
interface WSLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open", listener: () => void): void;
  addEventListener(type: "message", listener: (ev: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: () => void): void;
  addEventListener(type: "error", listener: (ev: unknown) => void): void;
}

const NOTIFY_PREFIX = "chan:notified:";
const RESOLVED_PREFIX = "chan:resolved:";
const NOTIFY_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const POLL_INTERVAL_MS = 15_000;
const PING_INTERVAL_MS = 60_000;
const RECONNECT_BASE_MS = 1_000;
const RECONNECT_CAP_MS = 30_000;

interface NotifiedRecord {
  chats: { platform: ChannelPlatform; chatId: string }[];
  at: string;
}

export interface ApprovalNotifierOptions {
  deps: ChannelDeps;
  registry: DecisionRegistry;
  bindings: BindingStore;
  /** Resolve the adapter for a platform (undefined when disabled). */
  getAdapter: (platform: ChannelPlatform) => ChannelAdapter | undefined;
  /** Override the edge events base URL (defaults to deps.edgeBaseUrl). */
  edgeEventsUrl?: string;
}

export class ApprovalNotifier {
  private readonly deps: ChannelDeps;
  private readonly registry: DecisionRegistry;
  private readonly bindings: BindingStore;
  private readonly getAdapter: ApprovalNotifierOptions["getAdapter"];
  private readonly edgeEventsUrl?: string;

  private ws?: WSLike;
  private started = false;
  private stopped = true;
  private reconnectAttempt = 0;
  private cursor?: string;

  private pollTimer?: ReturnType<typeof setInterval>;
  private pingTimer?: ReturnType<typeof setInterval>;
  private reconnectTimer?: ReturnType<typeof setTimeout>;

  constructor(opts: ApprovalNotifierOptions) {
    this.deps = opts.deps;
    this.registry = opts.registry;
    this.bindings = opts.bindings;
    this.getAdapter = opts.getAdapter;
    this.edgeEventsUrl = opts.edgeEventsUrl;
  }

  // ─── Lifecycle ────────────────────────────────────────────────

  start(): void {
    if (this.started) return;
    this.started = true;
    this.stopped = false;
    this.connect();
    this.pollTimer = setInterval(() => void this.pollMastra(), POLL_INTERVAL_MS);
    void this.pollMastra();
  }

  stop(): void {
    this.started = false;
    this.stopped = true;
    if (this.pollTimer) clearInterval(this.pollTimer);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.clearPing();
    this.pollTimer = undefined;
    this.reconnectTimer = undefined;
    try {
      this.ws?.close();
    } catch {
      // best-effort
    }
    this.ws = undefined;
  }

  // ─── WebSocket ────────────────────────────────────────────────

  private wsUrl(): string {
    const base = (this.edgeEventsUrl ?? this.deps.edgeBaseUrl).replace(/\/+$/, "");
    const wsBase = base.replace(/^http/, "ws"); // http->ws, https->wss
    const since = this.cursor ? `?since=${encodeURIComponent(this.cursor)}` : "";
    return `${wsBase}/events${since}`;
  }

  private connect(): void {
    if (this.stopped) return;
    const url = this.wsUrl();
    try {
      const ws = new WebSocket(url) as unknown as WSLike;
      this.ws = ws;
      ws.addEventListener("open", () => {
        this.reconnectAttempt = 0;
        console.log("[channels:notifier] connected to edge events:", url);
        this.startPing();
      });
      ws.addEventListener("message", (ev) => this.onWsMessage(ev.data));
      ws.addEventListener("close", () => {
        this.clearPing();
        this.scheduleReconnect();
      });
      ws.addEventListener("error", (ev) => {
        console.warn("[channels:notifier] ws error:", errorMessage(ev));
        try {
          ws.close();
        } catch {
          // ignore
        }
      });
    } catch (err) {
      console.warn("[channels:notifier] connect failed:", errorMessage(err));
      this.scheduleReconnect();
    }
  }

  private onWsMessage(data: unknown): void {
    if (typeof data !== "string") return;
    if (data === CALLA_PONG_TEXT) return; // heartbeat ack
    let frame: CallaWsFrame;
    try {
      frame = JSON.parse(data) as CallaWsFrame;
    } catch {
      return;
    }
    void this.handleFrame(frame);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      try {
        this.ws?.send(CALLA_PING_TEXT);
      } catch (err) {
        console.warn("[channels:notifier] ping failed:", errorMessage(err));
      }
    }, PING_INTERVAL_MS);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = undefined;
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearPing();
    const backoff = Math.min(
      RECONNECT_BASE_MS * 2 ** this.reconnectAttempt,
      RECONNECT_CAP_MS,
    );
    const jitter = Math.floor(Math.random() * 500);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      if (!this.stopped) this.connect();
    }, backoff + jitter);
  }

  // ─── Frame handling (public for direct testing) ───────────────

  /** Process a single /events frame. Public so tests can drive it directly. */
  async handleFrame(frame: CallaWsFrame): Promise<void> {
    if (!frame || typeof frame !== "object") return;
    if (frame.id != null) this.cursor = String(frame.id);
    try {
      if (frame.type === CALLA_EVENTS.approvalRequest) {
        const req = frame.payload as ApprovalRequest;
        if (req && typeof req === "object" && req.id) {
          await this.notifyApproval(req);
        }
      } else if (frame.type === CALLA_EVENTS.approvalResolved) {
        const p = frame.payload as { id?: string; status?: string } | undefined;
        const id = p?.id;
        if (id) await this.notifyResolved(String(id), p?.status);
      }
    } catch (err) {
      console.warn("[channels:notifier] frame handling failed:", errorMessage(err));
    }
  }

  // ─── Notify path (shared by WS + poller) ──────────────────────

  private async notifyApproval(req: ApprovalRequest): Promise<void> {
    const key = `${NOTIFY_PREFIX}${req.id}`;
    const existing = await this.deps.store
      .cacheGet<NotifiedRecord>(key, CHANNELS_CACHE_AGENT)
      .catch(() => null);
    if (existing) return; // dedupe

    let bindings;
    try {
      bindings = await this.bindings.listBindings();
    } catch (err) {
      console.warn("[channels:notifier] listBindings failed:", errorMessage(err));
      return;
    }
    if (!bindings.length) return; // nobody bound yet; poller will retry for mastra

    const card = buildApprovalCard(this.registry, req);
    const notified: NotifiedRecord["chats"] = [];
    for (const b of bindings) {
      const adapter = this.getAdapter(b.platform);
      if (!adapter || !adapter.enabled) continue;
      try {
        await adapter.sendMessage(b.chatId, card.text, card);
        notified.push({ platform: b.platform, chatId: b.chatId });
      } catch (err) {
        console.warn(
          `[channels:notifier] send to ${b.platform} failed:`,
          errorMessage(err),
        );
      }
    }
    if (notified.length) {
      await this.deps.store
        .cacheSet(
          key,
          CHANNELS_CACHE_AGENT,
          { chats: notified, at: new Date().toISOString() } satisfies NotifiedRecord,
          NOTIFY_TTL_MS,
        )
        .catch(() => {});
    }
  }

  private async notifyResolved(id: string, status?: string): Promise<void> {
    const key = `${NOTIFY_PREFIX}${id}`;
    const rec = await this.deps.store
      .cacheGet<NotifiedRecord>(key, CHANNELS_CACHE_AGENT)
      .catch(() => null);
    if (!rec?.chats?.length) return;

    const resolvedKey = `${RESOLVED_PREFIX}${id}`;
    const done = await this.deps.store
      .cacheGet(resolvedKey, CHANNELS_CACHE_AGENT)
      .catch(() => null);
    if (done) return;

    const text = `ℹ️ Approval ${id.slice(0, 8)} was ${status ?? "resolved"}.`;
    for (const c of rec.chats) {
      const adapter = this.getAdapter(c.platform);
      if (!adapter) continue;
      try {
        await adapter.sendMessage(c.chatId, text);
      } catch (err) {
        console.warn("[channels:notifier] resolved follow-up failed:", errorMessage(err));
      }
    }
    await this.deps.store
      .cacheSet(resolvedKey, CHANNELS_CACHE_AGENT, { at: new Date().toISOString() }, NOTIFY_TTL_MS)
      .catch(() => {});
  }

  private async pollMastra(): Promise<void> {
    if (this.stopped) return;
    try {
      const pending = await this.deps.listPendingMastra();
      for (const req of pending) {
        if (this.stopped) break;
        await this.notifyApproval(req);
      }
    } catch (err) {
      console.warn("[channels:notifier] mastra poll failed:", errorMessage(err));
    }
  }
}
