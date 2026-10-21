import { DurableObject } from "cloudflare:workers";
import { callable } from "agents";
import {
  CALLA_CONTROL,
  CALLA_EVENTS,
  CALLA_PING_TEXT,
  CALLA_PONG_TEXT,
  CALLA_WS_CLOSE,
  callaFrame,
  callaSubscribeFrameSchema,
  verifyCallaToken,
  type CallaWsFrame,
} from "@calla/shared";
import { extractToken } from "../auth";
import type { Env } from "../env";

/** Max frames retained in the SQLite ring buffer. */
const RING_MAX = 500;
/** Frames replayed to a freshly connected socket (no `?since=` cursor). */
const REPLAY_COUNT = 50;
/** Max frames replayed for a cursor gap-fill (`?since=` / `subscribe.since`). */
const REPLAY_SINCE_MAX = 500;
/** Hard cap on concurrent sockets; over-cap upgrades are closed with 1013. */
const MAX_CONNECTIONS = 1000;
/** Server heartbeat cadence, driven by Durable Object alarms (never setInterval). */
const HEARTBEAT_INTERVAL_MS = 25_000;
/** Genesis marker for the first audit chain link. */
const AUDIT_GENESIS = "GENESIS";
/** Replay window for Plivo webhook nonces (X-Plivo-Signature-V3-Nonce). */
const NONCE_TTL_MS = 10 * 60_000;

/**
 * Per-connection subscription, persisted with `ws.serializeAttachment()` so it
 * survives Durable Object hibernation. `channels === null` means firehose
 * (back-compat with clients that never send `calla:subscribe`).
 */
interface HubSubscription {
  channels: string[] | null;
  since: string | null;
}

/** Audit trail entry kinds written by the edge worker. */
export const AUDIT_KINDS = [
  "approval.requested",
  "approval.decided",
  "approval.expired",
  "step.executed",
  "event.ingested",
  "telnyx.escalation_alerted",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditAppendInput {
  agentId?: string | null;
  kind: AuditKind | string;
  entry: Record<string, unknown>;
}

export interface AuditAppendResult {
  seq: number;
  entry_hash: string;
}

/** One audit row as returned by `getAudit` (DB column names are preserved). */
export interface AuditRow {
  seq: number;
  ts: number;
  agent_id: string | null;
  kind: string;
  entry: Record<string, unknown>;
  prev_hash: string;
  entry_hash: string;
}

export interface AuditQueryInput {
  limit?: number;
  agentId?: string | null;
  kind?: string | null;
}

export interface AuditVerifyResult {
  valid: boolean;
  count: number;
  broken_at?: number;
}

/** `type` (not `interface`) so it satisfies SqlStorage's Record<…> constraint. */
type AuditDbRow = {
  seq: number;
  ts: number;
  agent_id: string | null;
  kind: string;
  entry: string;
  prev_hash: string;
  entry_hash: string;
};

// ── audit hashing helpers ────────────────────────────────────────────────────
// Adapted from elizaos-plugin-cloudflare (MIT, (c) 2026 thirtieth)

/** Deterministic JSON: object keys sorted recursively, arrays keep order. */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

/** Canonical (key-sorted) JSON text — this exact string is stored in `entry`. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

/**
 * Hash preimage for one audit row. Written and verified through this single
 * function so the chain can never drift:
 *   entry_hash = sha256hex(JSON.stringify({ ts, agentId, kind, entry, prev_hash }))
 * with `entry` in canonical (recursively key-sorted) form.
 */
function auditPreimage(
  ts: number,
  agentId: string | null,
  kind: string,
  entryCanonical: string,
  prevHash: string,
): string {
  let entry: unknown;
  try {
    entry = JSON.parse(entryCanonical);
  } catch {
    entry = entryCanonical;
  }
  return JSON.stringify({ ts, agentId, kind, entry, prev_hash: prevHash });
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  let out = "";
  for (const byte of new Uint8Array(digest)) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/** A frame matches a subscription when no channels are set, or the frame's
 *  agentId / type is listed. */
function frameMatchesChannels(
  frame: CallaWsFrame,
  channels: string[] | null,
): boolean {
  if (!channels || channels.length === 0) return true;
  if (frame.agentId && channels.includes(frame.agentId)) return true;
  return channels.includes(frame.type);
}

/**
 * CallaEventHub — the event bus + tamper-evident audit trail for Calla.
 *
 * A plain Durable Object (not an Agent) that:
 *  - terminates the `/events` WebSocket using the hibernation API,
 *  - answers `calla:ping` at the runtime layer via a WebSocket auto-response
 *    pair, so heartbeats from clients never wake (or bill) the DO,
 *  - emits a server-side `calla:heartbeat` every 25s from `alarm()` — alarms,
 *    not `setInterval`, so the DO is free to hibernate between beats,
 *  - stamps every published frame with a monotonic SQLite `id` (the replay
 *    cursor) and `ts`, then broadcasts it to matching sockets,
 *  - persists frames to a SQLite ring buffer (last 500) for late-joiner replay
 *    and `?since=` gap-fill,
 *  - honours per-socket `calla:subscribe` channel filters (survive hibernation
 *    via `serializeAttachment`),
 *  - caps concurrency at MAX_CONNECTIONS and closes over-cap upgrades with 1013,
 *  - keeps a hash-chained `audit` table (append-only, single-writer by virtue of
 *    DO serialization) with `appendAudit` / `getAudit` / `verifyAudit`,
 *  - exposes `publish` / `recent` / `recentSince` over native DO RPC so the edge
 *    agents, orchestrator, and the worker's HTTP routes all feed the same bus.
 *
 * Wire frame shape is `CallaWsFrame` from @calla/shared:
 *   { type, id?, agentId?, deploymentId?, payload?, ts? }
 */
export class CallaEventHub extends DurableObject<Env> {
  private schemaReady = false;

  // ── WebSocket entrypoint ───────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    this.ensureSchema();

    const url = new URL(request.url);
    const isWebSocket =
      request.headers.get("Upgrade")?.toLowerCase() === "websocket";
    if (!isWebSocket) {
      if (!(await this.authorized(request, url))) {
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(
        JSON.stringify({
          ok: true,
          service: "calla-event-hub",
          hint: "Connect with Upgrade: websocket, or GET /events/recent on the worker.",
          ping: CALLA_PING_TEXT,
          pong: CALLA_PONG_TEXT,
          maxConnections: MAX_CONNECTIONS,
          heartbeatMs: HEARTBEAT_INTERVAL_MS,
          connections: this.ctx.getWebSockets().length,
          recent: this.recent(REPLAY_COUNT),
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }

    // (f) Auth: when CALLA_JWT_SECRET and/or EVENTS_AUTH_TOKEN is set, an
    // upgrade without a valid token is accepted and immediately closed with
    // 4001 so the client can re-auth with a fresh URL. (index.ts still
    // short-circuits with 401 JSON for the worker-level route; this guards
    // direct DO fetches.)
    if (!(await this.authorized(request, url))) {
      console.log("[calla] event hub rejecting upgrade: unauthorized (4001)");
      return this.rejectUpgrade(CALLA_WS_CLOSE.unauthorized, "unauthorized");
    }

    // (e) Connection cap: accept + immediately close is the Workers idiom for
    // refusing an upgrade with an application close code.
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_CONNECTIONS) {
      console.log(
        `[calla] event hub over capacity (${sockets.length}/${MAX_CONNECTIONS}); closing upgrade with ${CALLA_WS_CLOSE.overCapacity}`,
      );
      return this.rejectUpgrade(CALLA_WS_CLOSE.overCapacity, "over capacity");
    }

    // (a) FREE HEARTBEAT: register the exact-string ping/pong auto-response so
    // the runtime answers `calla:ping` without waking this Durable Object.
    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair(CALLA_PING_TEXT, CALLA_PONG_TEXT),
    );

    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);

    // (c) Cursor replay: `?since=<id>` replays only frames with id > since
    // (cap 500); without a cursor we replay the last REPLAY_COUNT frames.
    const since = url.searchParams.get("since") ?? undefined;
    const replay = since
      ? this.recentSince(since, REPLAY_SINCE_MAX)
      : this.recent(REPLAY_COUNT);

    // Greet, then replay so a UI that connects mid-flight catches up.
    this.send(
      server,
      callaFrame(CALLA_CONTROL.hello, {
        hub: "calla",
        replay: replay.length,
        since: since ?? null,
        ping: CALLA_PING_TEXT,
        pong: CALLA_PONG_TEXT,
        heartbeatMs: HEARTBEAT_INTERVAL_MS,
        maxConnections: MAX_CONNECTIONS,
      }),
    );
    for (const frame of replay) this.send(server, frame);

    if (since) {
      console.log(
        `[calla] event hub accept cursor since=${since} replayed=${replay.length}`,
      );
    }

    // (b) Arm the server heartbeat alarm on the first accepted connection (and
    // re-arm if it was cleared while sockets were attached, e.g. after a
    // restart). Alarms are durable; setInterval would block hibernation.
    await this.armHeartbeat();

    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const text =
      typeof message === "string" ? message : new TextDecoder().decode(message);

    // (a) The raw-text ping is normally intercepted by the auto-response pair
    // and never reaches us. If it does (auto-response unavailable), answer with
    // the exact pong text so client behaviour is identical either way.
    if (text === CALLA_PING_TEXT) {
      this.sendRaw(ws, CALLA_PONG_TEXT);
      return;
    }

    let frame: Partial<CallaWsFrame> & { channels?: unknown; since?: unknown };
    try {
      frame = JSON.parse(text) as typeof frame;
    } catch {
      return; // ignore malformed frames
    }

    // A JSON ping cannot be matched by the exact-string auto-response, so it is
    // answered here — still with the raw CALLA_PONG_TEXT, not a JSON frame.
    if (frame?.type === CALLA_CONTROL.ping) {
      this.sendRaw(ws, CALLA_PONG_TEXT);
      return;
    }

    if (frame?.type !== CALLA_CONTROL.subscribe) return;

    // (d) Working subscribe: validate, persist the filter on the socket
    // (survives hibernation), then gap-fill from the subscription cursor.
    const parsed = callaSubscribeFrameSchema.safeParse(frame);
    if (!parsed.success) {
      console.log("[calla] event hub bad subscribe frame:", parsed.error.issues);
      this.send(
        ws,
        callaFrame(CALLA_EVENTS.error, {
          error: "invalid_subscribe",
          issues: parsed.error.issues,
        }),
      );
      return;
    }

    const channels =
      parsed.data.channels && parsed.data.channels.length > 0
        ? parsed.data.channels
        : null;
    const subscription: HubSubscription = { channels, since: parsed.data.since ?? null };
    ws.serializeAttachment(subscription);
    console.log(
      `[calla] event hub subscribe channels=${JSON.stringify(channels)} since=${subscription.since ?? "-"}`,
    );

    if (subscription.since) {
      let gap = 0;
      for (const past of this.recentSince(subscription.since, REPLAY_SINCE_MAX)) {
        if (!frameMatchesChannels(past, channels)) continue;
        this.send(ws, past);
        gap++;
      }
      console.log(`[calla] event hub subscribe gap-fill: ${gap} frames`);
    }
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    // (g) Tail-visible close logging. The hibernation API already dropped the
    // socket from getWebSockets(); the filter keeps the count honest either way.
    const remaining = this.ctx.getWebSockets().filter((s) => s !== ws).length;
    console.log(
      `[calla] event hub ws close code=${code} reason="${reason}" clean=${wasClean} remaining=${remaining}`,
    );
    if (remaining === 0) await this.clearHeartbeat();
  }

  webSocketError(ws: WebSocket, error: unknown): void {
    console.error("[calla] event hub socket error:", error);
    try {
      ws.close(1011, "internal error");
    } catch {
      /* already closed */
    }
    if (this.ctx.getWebSockets().filter((s) => s !== ws).length === 0) {
      this.ctx.waitUntil(this.clearHeartbeat());
    }
  }

  /**
   * (b) Server heartbeat. Fires every HEARTBEAT_INTERVAL_MS while at least one
   * socket is attached; when the last socket goes away the alarm is not
   * rescheduled so the Durable Object hibernates (zero cost while idle).
   */
  async alarm(): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    if (sockets.length === 0) return;

    const frame = callaFrame(CALLA_EVENTS.heartbeat, {
      lastId: this.lastEventId(),
      connections: sockets.length,
    });
    // Heartbeats are liveness, not data: they bypass channel filters.
    const encoded = JSON.stringify(frame);
    for (const ws of sockets) this.sendRaw(ws, encoded);

    try {
      await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
    } catch (err) {
      // Not fatal: the next accepted connection re-arms via armHeartbeat().
      console.error("[calla] event hub failed to reschedule heartbeat:", err);
    }
  }

  // ── RPC surface: event bus ─────────────────────────────────────────────────

  /**
   * Persist a frame to the ring buffer and broadcast it to every matching
   * socket. The hub owns `id` (monotonic SQLite rowid) and `ts`: both are
   * stamped before persisting so replayed and live frames are identical.
   * Returns the stamped frame (callers can ignore it).
   */
  @callable()
  async publish(frame: CallaWsFrame): Promise<CallaWsFrame> {
    this.ensureSchema();
    const ts = frame.ts ?? Date.now();

    // Allocate the monotonic id first, then stamp + rewrite the row so the
    // persisted frame carries the same id the sockets receive.
    const inserted = this.ctx.storage.sql
      .exec<{ id: number }>(
        "INSERT INTO events (frame, ts) VALUES (?, ?) RETURNING id",
        "",
        ts,
      )
      .one();
    const id = String(inserted.id);

    const stamped: CallaWsFrame = { ...frame, id, ts };
    const encoded = JSON.stringify(stamped);
    this.ctx.storage.sql.exec(
      "UPDATE events SET frame = ? WHERE id = ?",
      encoded,
      inserted.id,
    );
    // Trim to the newest RING_MAX rows.
    this.ctx.storage.sql.exec(
      "DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT ?)",
      RING_MAX,
    );

    this.broadcast(encoded, stamped);
    return stamped;
  }

  /** Return the most recent `limit` frames, oldest-first. */
  @callable()
  recent(limit: number = REPLAY_COUNT): CallaWsFrame[] {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<{ frame: string }>(
        "SELECT frame FROM events ORDER BY id DESC LIMIT ?",
        Math.min(Math.max(limit, 1), RING_MAX),
      )
      .toArray();
    return rows
      .map((r) => JSON.parse(r.frame) as CallaWsFrame)
      .reverse();
  }

  /**
   * Cursor gap-fill: every frame with `id > since`, oldest-first, capped at
   * `limit` (max 500). A missing/blank/unparseable cursor degrades to
   * `recent(limit)`.
   */
  @callable()
  recentSince(
    since: string | undefined,
    limit: number = REPLAY_SINCE_MAX,
  ): CallaWsFrame[] {
    this.ensureSchema();
    const cap = Math.min(Math.max(limit || REPLAY_SINCE_MAX, 1), RING_MAX);
    const cursor = parseCursor(since);
    if (cursor === null) return this.recent(cap);

    const rows = this.ctx.storage.sql
      .exec<{ frame: string }>(
        "SELECT frame FROM events WHERE id > ? ORDER BY id ASC LIMIT ?",
        cursor,
        cap,
      )
      .toArray();
    return rows.map((r) => JSON.parse(r.frame) as CallaWsFrame);
  }

  // ── RPC surface: hash-chained audit log ────────────────────────────────────
  // Adapted from elizaos-plugin-cloudflare (MIT, (c) 2026 thirtieth)

  /**
   * Append one tamper-evident audit row. `prev_hash` is the previous row's
   * `entry_hash` (or "GENESIS"), and `entry_hash` commits to ts/agentId/kind/
   * entry/prev_hash — so editing or dropping any row breaks every hash after it.
   *
   * Single-writer safety comes for free: the Durable Object serializes input
   * events, so read-tail → hash → insert is atomic.
   */
  @callable()
  async appendAudit(input: AuditAppendInput): Promise<AuditAppendResult> {
    this.ensureSchema();
    const kind = typeof input?.kind === "string" ? input.kind.trim() : "";
    if (!kind) throw new Error("appendAudit: kind (non-empty string) is required");

    const ts = Date.now();
    const agentId =
      typeof input.agentId === "string" && input.agentId.length > 0
        ? input.agentId
        : null;
    const entryCanonical = canonicalJson(input.entry ?? {});

    const tail = this.ctx.storage.sql
      .exec<{ seq: number; entry_hash: string }>(
        "SELECT seq, entry_hash FROM audit ORDER BY seq DESC LIMIT 1",
      )
      .toArray()[0];
    const prevHash = tail?.entry_hash ?? AUDIT_GENESIS;
    const entryHash = await sha256Hex(
      auditPreimage(ts, agentId, kind, entryCanonical, prevHash),
    );

    const row = this.ctx.storage.sql
      .exec<{ seq: number }>(
        "INSERT INTO audit (ts, agent_id, kind, entry, prev_hash, entry_hash) VALUES (?, ?, ?, ?, ?, ?) RETURNING seq",
        ts,
        agentId,
        kind,
        entryCanonical,
        prevHash,
        entryHash,
      )
      .one();

    return { seq: row.seq, entry_hash: entryHash };
  }

  /** Audit rows (oldest-first) with optional agentId / kind filters. */
  @callable()
  getAudit(input: AuditQueryInput = {}): AuditRow[] {
    this.ensureSchema();
    const limit = Math.min(Math.max(input?.limit ?? 100, 1), RING_MAX * 2);
    const where: string[] = [];
    const bindings: (string | number)[] = [];
    if (typeof input?.agentId === "string" && input.agentId.length > 0) {
      where.push("agent_id = ?");
      bindings.push(input.agentId);
    }
    if (typeof input?.kind === "string" && input.kind.length > 0) {
      where.push("kind = ?");
      bindings.push(input.kind);
    }
    const clause = where.length > 0 ? ` WHERE ${where.join(" AND ")}` : "";

    const rows = this.ctx.storage.sql
      .exec<AuditDbRow>(
        `SELECT seq, ts, agent_id, kind, entry, prev_hash, entry_hash FROM audit${clause} ORDER BY seq DESC LIMIT ?`,
        ...bindings,
        limit,
      )
      .toArray();

    return rows.reverse().map((r) => ({
      seq: r.seq,
      ts: r.ts,
      agent_id: r.agent_id,
      kind: r.kind,
      entry: safeParseEntry(r.entry),
      prev_hash: r.prev_hash,
      entry_hash: r.entry_hash,
    }));
  }

  /**
   * Recompute the whole chain and report the first broken link.
   * `count` is the chain length; `broken_at` is the offending `seq` (absent
   * when `valid` is true).
   */
  @callable()
  async verifyAudit(): Promise<AuditVerifyResult> {
    this.ensureSchema();
    const rows = this.ctx.storage.sql
      .exec<AuditDbRow>(
        "SELECT seq, ts, agent_id, kind, entry, prev_hash, entry_hash FROM audit ORDER BY seq ASC",
      )
      .toArray();

    let expectedPrev = AUDIT_GENESIS;
    for (const row of rows) {
      if (row.prev_hash !== expectedPrev) {
        return { valid: false, count: rows.length, broken_at: row.seq };
      }
      const recomputed = await sha256Hex(
        auditPreimage(row.ts, row.agent_id, row.kind, row.entry, row.prev_hash),
      );
      if (recomputed !== row.entry_hash) {
        return { valid: false, count: rows.length, broken_at: row.seq };
      }
      expectedPrev = row.entry_hash;
    }

    return { valid: true, count: rows.length };
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private ensureSchema(): void {
    if (this.schemaReady) return;
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY AUTOINCREMENT, frame TEXT, ts INTEGER)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (seq INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, agent_id TEXT, kind TEXT NOT NULL, entry TEXT NOT NULL, prev_hash TEXT NOT NULL, entry_hash TEXT NOT NULL)",
    );
    this.ctx.storage.sql.exec(
      "CREATE INDEX IF NOT EXISTS audit_agent_kind ON audit (agent_id, kind)",
    );
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS plivo_nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)",
    );
    this.schemaReady = true;
  }

  /**
   * Replay guard for Plivo webhook nonces (X-Plivo-Signature-V3-Nonce).
   * Returns true when the nonce has NOT been seen in the last
   * NONCE_TTL_MS and marks it as seen. Expired rows are pruned on the way.
   */
  async checkPlivoNonce(nonce: string): Promise<boolean> {
    this.ensureSchema();
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM plivo_nonces WHERE expires_at < ?", now);
    const existing = this.ctx.storage.sql
      .exec<{ nonce: string }>(
        "SELECT nonce FROM plivo_nonces WHERE nonce = ?",
        nonce,
      )
      .toArray();
    if (existing.length > 0) return false;
    this.ctx.storage.sql.exec(
      "INSERT INTO plivo_nonces (nonce, expires_at) VALUES (?, ?)",
      nonce,
      now + NONCE_TTL_MS,
    );
    return true;
  }

  /**
   * Token check mirroring the worker's user routes: accept a valid Calla user
   * JWT (CALLA_JWT_SECRET, via Authorization Bearer or `?token=`) OR the
   * service token (EVENTS_AUTH_TOKEN, via `x-calla-token` or `?token=`). Open
   * when neither secret is configured (local dev). This is the defence-in-depth
   * guard for direct DO fetches; index.ts does the same check at the edge.
   */
  private async authorized(request: Request, url: URL): Promise<boolean> {
    const serviceToken = this.env.EVENTS_AUTH_TOKEN;
    const jwtSecret = this.env.CALLA_JWT_SECRET;
    if (!serviceToken && !jwtSecret) return true;
    const provided = extractToken(request, url);
    if (!provided) return false;
    if (serviceToken && provided === serviceToken) return true;
    if (jwtSecret && (await verifyCallaToken(provided, jwtSecret))) return true;
    return false;
  }

  /** Accept-then-close: the only way to hand a WS client an app close code. */
  private rejectUpgrade(code: number, reason: string): Response {
    const { 0: client, 1: server } = new WebSocketPair();
    try {
      server.accept();
      server.close(code, reason);
    } catch (err) {
      // Defence in depth: workerd accepts 1013/4001 (verified), but a runtime
      // that rejects a reserved code must still hang up cleanly.
      console.log(`[calla] event hub close(${code}) failed, using 1000:`, err);
      try {
        server.close(1000, reason);
      } catch {
        /* socket already gone */
      }
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  private async armHeartbeat(): Promise<void> {
    try {
      if ((await this.ctx.storage.getAlarm()) === null) {
        await this.ctx.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
      }
    } catch (err) {
      console.error("[calla] event hub failed to arm heartbeat alarm:", err);
    }
  }

  private async clearHeartbeat(): Promise<void> {
    try {
      // Typed equivalent of `setAlarm(null)` — cancels the pending heartbeat so
      // the Durable Object is free to hibernate.
      await this.ctx.storage.deleteAlarm();
    } catch (err) {
      console.error("[calla] event hub failed to clear heartbeat alarm:", err);
    }
  }

  private lastEventId(): string | null {
    try {
      const row = this.ctx.storage.sql
        .exec<{ id: number }>("SELECT id FROM events ORDER BY id DESC LIMIT 1")
        .toArray()[0];
      return row ? String(row.id) : null;
    } catch {
      return null;
    }
  }

  private subscription(ws: WebSocket): HubSubscription | null {
    try {
      const raw = ws.deserializeAttachment() as Partial<HubSubscription> | null;
      if (!raw || typeof raw !== "object") return null;
      return {
        channels: Array.isArray(raw.channels) ? raw.channels : null,
        since: typeof raw.since === "string" ? raw.since : null,
      };
    } catch {
      return null;
    }
  }

  private broadcast(encoded: string, frame: CallaWsFrame): void {
    for (const ws of this.ctx.getWebSockets()) {
      const channels = this.subscription(ws)?.channels ?? null;
      if (!frameMatchesChannels(frame, channels)) continue;
      this.sendRaw(ws, encoded);
    }
  }

  private send(ws: WebSocket, frame: CallaWsFrame): void {
    this.sendRaw(ws, JSON.stringify(frame));
  }

  private sendRaw(ws: WebSocket, encoded: string): void {
    try {
      ws.send(encoded);
    } catch {
      // Socket went away between getWebSockets() and send(); ignore.
    }
  }
}

/** `?since=` / `subscribe.since` cursor → number, or null when unusable. */
function parseCursor(since: string | undefined | null): number | null {
  if (since === undefined || since === null || since === "") return null;
  const cursor = Number(since);
  if (!Number.isFinite(cursor) || cursor < 0) return null;
  return Math.floor(cursor);
}

function safeParseEntry(entry: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(entry) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { value: parsed };
  } catch {
    return { raw: entry };
  }
}
