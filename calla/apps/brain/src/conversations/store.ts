/**
 * Conversation-thread store — the durable "every customer conversation" view
 * the operator console reads (see conversations/routes.ts + the README's
 * "Conversations API" section).
 *
 * Built ONLY on CallaStore.cacheGet/cacheSet (+ appendAudit), following the
 * flows/store.ts + booking/store.ts pattern: the cache has no scan, so the
 * listable collection lives under its own index key.
 *
 * Cache keys (agentId "conversations"):
 *   conv:thread:<platform>:<userId>  -> ConversationThread  (no TTL)
 *   conv:index                       -> ConversationIndexEntry[]
 *                                       (capped 200, newest-first, refreshed on
 *                                        EVERY recorded message)
 *
 * Caps: a thread keeps the last 100 messages (oldest dropped first) and the
 * index keeps the last 200 threads. Threads contain PERSONAL DATA (handles,
 * phone numbers, verbatim message text) — the deletion path is
 * ConversationStore.deleteThread() (exposed as `DELETE /conversations/:id`),
 * which wipes the thread row (cacheSet null → the row expires immediately) and
 * its index entry, then audits "conversation.deleted".
 *
 * EVERY method is best-effort: failures are logged and swallowed (returning
 * null) so a conversation-recording problem can never break a webhook, an
 * approval decision or a REST request. Read-modify-write cycles are serialized
 * per thread (and per index) by an in-process promise lock so two concurrent
 * webhooks cannot drop a message.
 *
 * Audit kinds (hash-chained, agentId "conversations"):
 *   conversation.takeover / conversation.deleted
 * (conversation.manual_sent is written by routes.ts — it needs send context.)
 */
import type { CallaStore } from "../store/types.js";

/** All conversation cache rows share this agentId (cache PK is (key, agentId)). */
export const CONVERSATIONS_CACHE_AGENT = "conversations";

/** Per-thread row: conv:thread:<platform>:<userId>. */
export const CONV_THREAD_PREFIX = "conv:thread:";

/** Newest-first capped index of thread summaries. */
export const CONV_INDEX_KEY = "conv:index";

/** Messages kept per thread (oldest dropped first). */
export const THREAD_MESSAGES_CAP = 100;

/** Threads kept in the index (oldest dropped first). */
export const INDEX_CAP = 200;

/** Verbatim message text cap (WhatsApp's own send cap is 4096). */
export const MESSAGE_TEXT_CAP = 4000;

/** Index preview cap for `lastMessage`. */
export const PREVIEW_TEXT_CAP = 200;

export const CONVERSATION_PLATFORMS = [
  "instagram",
  "tiktok",
  "whatsapp",
  /** Telephony (Telnyx) call transcripts — one thread per call id. */
  "voice",
] as const;

/** Platforms with a conversation thread (same union as SocialPlatform). */
export type ConversationPlatform = (typeof CONVERSATION_PLATFORMS)[number];

/** Direction of one recorded message. */
export type ConversationDir = "in" | "out";

/**
 * Why a message is in the thread. "system" marks entries that were NOT
 * delivered to the customer (a pending-approval notice, a declined draft) —
 * the UI must render them as thread notices, not as sent messages.
 */
export type ConversationMessageKind =
  | "message"
  | "flow_prompt"
  | "persona"
  | "static"
  | "approval_result"
  | "manual"
  | "system";

export interface ConversationMessage {
  dir: ConversationDir;
  text: string;
  /** ISO-8601. */
  ts: string;
  /** true for automation (engine replies, flow prompts, approved sends). */
  auto?: boolean;
  kind?: ConversationMessageKind;
  /** Approval row id for approval-gated entries (pending / approved / declined). */
  approvalId?: string;
}

export interface ConversationContact {
  username?: string;
  phone?: string;
  externalUserId: string;
}

export interface ConversationTakeover {
  on: boolean;
  /** Operator identity when known. */
  by?: string;
  /** ISO-8601 of the last change. */
  at?: string;
}

/** One thread row (the platform + userId live in its cache key / id). */
export interface ConversationThread {
  contact: ConversationContact;
  /** Last THREAD_MESSAGES_CAP messages, oldest first. */
  messages: ConversationMessage[];
  /** Present once an operator toggled takeover (see setTakeover). */
  takeover?: ConversationTakeover;
  /** Engine lead key (`IG:<handle>` / `TT:<handle>` / `WA:<phone>`). */
  leadKey?: string;
  /** Qualification-flow run id (flows/store.ts FlowRun). */
  flowRunId?: string;
  /** ISO-8601 of the last recorded message. */
  lastAt: string;
  /** Every message ever recorded (survives the 100-message cap). */
  messageCount: number;
}

/** Index row served by GET /conversations (flow fields are enriched there). */
export interface ConversationIndexEntry {
  /** `<platform>:<userId>`. */
  id: string;
  platform: ConversationPlatform;
  username?: string;
  phone?: string;
  lastMessage: string;
  /** ISO-8601. */
  lastAt: string;
  messageCount: number;
  takeover: boolean;
  leadKey?: string;
  flowRunId?: string;
}

export interface RecordInboundInput {
  platform: ConversationPlatform;
  externalUserId: string;
  username?: string;
  phone?: string;
  text: string;
  /** ISO string or ms epoch; defaults to now. */
  ts?: string | number;
  /** Defaults to "message". */
  kind?: ConversationMessageKind;
}

export interface RecordOutboundInput {
  platform: ConversationPlatform;
  externalUserId: string;
  text: string;
  /** ISO string or ms epoch; defaults to now. */
  ts?: string | number;
  kind: ConversationMessageKind;
  auto: boolean;
  approvalId?: string;
  /** Contact enrichment for threads created by an outbound-first event. */
  username?: string;
  phone?: string;
}

export interface ListThreadsOptions {
  platform?: ConversationPlatform;
  /** Default 50, capped at INDEX_CAP. */
  limit?: number;
}

// ─── Id helpers ──────────────────────────────────────────────────

/** Thread id / index id: `<platform>:<userId>`. */
export function conversationId(
  platform: ConversationPlatform,
  externalUserId: string,
): string {
  return `${platform}:${externalUserId}`;
}

/** Split a thread id back into its parts (null when malformed). */
export function parseConversationId(
  id: string,
): { platform: ConversationPlatform; userId: string } | null {
  const raw = String(id ?? "").trim();
  const idx = raw.indexOf(":");
  if (idx <= 0 || idx === raw.length - 1) return null;
  const platform = raw.slice(0, idx);
  const userId = raw.slice(idx + 1);
  if (!(CONVERSATION_PLATFORMS as readonly string[]).includes(platform)) return null;
  if (!userId || userId.includes("/")) return null;
  return { platform: platform as ConversationPlatform, userId };
}

function isPlatform(v: unknown): v is ConversationPlatform {
  return typeof v === "string" && (CONVERSATION_PLATFORMS as readonly string[]).includes(v);
}

// ─── Small pure helpers ──────────────────────────────────────────

function clip(text: string, max: number): string {
  const s = String(text ?? "");
  return s.length > max ? `${s.slice(0, Math.max(0, max - 1))}…` : s;
}

function toIso(ts: string | number | undefined): string {
  if (typeof ts === "number" && Number.isFinite(ts) && ts > 0) {
    // Platform webhooks deliver ms epochs; WhatsApp delivers SECONDS.
    const ms = ts < 1e12 ? ts * 1000 : ts;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  if (typeof ts === "string" && ts.trim()) {
    const parsed = Date.parse(ts);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date().toISOString();
}

const MESSAGE_KINDS: readonly string[] = [
  "message",
  "flow_prompt",
  "persona",
  "static",
  "approval_result",
  "manual",
  "system",
];

function normalizeKind(v: unknown): ConversationMessageKind {
  return typeof v === "string" && MESSAGE_KINDS.includes(v)
    ? (v as ConversationMessageKind)
    : "message";
}

function normalizeMessage(raw: unknown): ConversationMessage | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const dir: ConversationDir = b.dir === "out" ? "out" : "in";
  const ts = typeof b.ts === "string" && b.ts ? b.ts : new Date(0).toISOString();
  const msg: ConversationMessage = { dir, text: String(b.text ?? ""), ts };
  if (typeof b.auto === "boolean") msg.auto = b.auto;
  if (b.kind != null) msg.kind = normalizeKind(b.kind);
  if (b.approvalId != null) msg.approvalId = String(b.approvalId);
  return msg;
}

function normalizeThread(raw: unknown): ConversationThread | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const externalUserId = String(b.contact?.externalUserId ?? "");
  if (!externalUserId) return null;
  const contact: ConversationContact = { externalUserId };
  if (typeof b.contact?.username === "string" && b.contact.username) {
    contact.username = b.contact.username;
  }
  if (typeof b.contact?.phone === "string" && b.contact.phone) {
    contact.phone = b.contact.phone;
  }
  const messages = (Array.isArray(b.messages) ? b.messages : [])
    .map(normalizeMessage)
    .filter((m): m is ConversationMessage => m !== null)
    .slice(-THREAD_MESSAGES_CAP);
  const thread: ConversationThread = {
    contact,
    messages,
    lastAt: typeof b.lastAt === "string" && b.lastAt ? b.lastAt : new Date().toISOString(),
    messageCount:
      typeof b.messageCount === "number" && Number.isFinite(b.messageCount)
        ? Math.max(0, Math.trunc(b.messageCount))
        : messages.length,
  };
  if (b.takeover && typeof b.takeover === "object") {
    const takeover: ConversationTakeover = { on: Boolean(b.takeover.on) };
    if (b.takeover.by != null) takeover.by = String(b.takeover.by);
    if (b.takeover.at != null) takeover.at = String(b.takeover.at);
    thread.takeover = takeover;
  }
  if (typeof b.leadKey === "string" && b.leadKey) thread.leadKey = b.leadKey;
  if (typeof b.flowRunId === "string" && b.flowRunId) thread.flowRunId = b.flowRunId;
  return thread;
}

function normalizeIndexEntry(raw: unknown): ConversationIndexEntry | null {
  if (!raw || typeof raw !== "object") return null;
  const b = raw as Record<string, any>;
  const id = String(b.id ?? "");
  if (!id || !isPlatform(b.platform)) return null;
  const entry: ConversationIndexEntry = {
    id,
    platform: b.platform,
    lastMessage: String(b.lastMessage ?? ""),
    lastAt: typeof b.lastAt === "string" && b.lastAt ? b.lastAt : new Date(0).toISOString(),
    messageCount:
      typeof b.messageCount === "number" && Number.isFinite(b.messageCount)
        ? Math.max(0, Math.trunc(b.messageCount))
        : 0,
    takeover: Boolean(b.takeover),
  };
  if (typeof b.username === "string" && b.username) entry.username = b.username;
  if (typeof b.phone === "string" && b.phone) entry.phone = b.phone;
  if (typeof b.leadKey === "string" && b.leadKey) entry.leadKey = b.leadKey;
  if (typeof b.flowRunId === "string" && b.flowRunId) entry.flowRunId = b.flowRunId;
  return entry;
}

function indexEntryFor(
  id: string,
  platform: ConversationPlatform,
  thread: ConversationThread,
  lastMessage: string,
): ConversationIndexEntry {
  const entry: ConversationIndexEntry = {
    id,
    platform,
    lastMessage: clip(lastMessage, PREVIEW_TEXT_CAP),
    lastAt: thread.lastAt,
    messageCount: thread.messageCount,
    takeover: Boolean(thread.takeover?.on),
  };
  if (thread.contact.username) entry.username = thread.contact.username;
  if (thread.contact.phone) entry.phone = thread.contact.phone;
  if (thread.leadKey) entry.leadKey = thread.leadKey;
  if (thread.flowRunId) entry.flowRunId = thread.flowRunId;
  return entry;
}

// ─── In-process locks (read-modify-write serialization) ──────────

const locks = new Map<string, Promise<unknown>>();

/**
 * Serialize `fn` per key so concurrent webhooks/requests cannot lose a message
 * to a stale read. Mirrors social/queue.ts's chain pattern: the key's tail
 * never rejects, and the entry is dropped once it settles (no unbounded map).
 */
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  locks.set(key, tail);
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key);
  });
  return run;
}

// ─── Store ───────────────────────────────────────────────────────

export class ConversationStore {
  constructor(private readonly store: CallaStore) {}

  private threadKey(id: string): string {
    return `${CONV_THREAD_PREFIX}${id}`;
  }

  private async readThread(id: string): Promise<ConversationThread | null> {
    const raw = await this.store
      .cacheGet<unknown>(this.threadKey(id), CONVERSATIONS_CACHE_AGENT)
      .catch(() => null);
    return normalizeThread(raw);
  }

  private async writeThread(id: string, thread: ConversationThread): Promise<void> {
    await this.store.cacheSet(this.threadKey(id), CONVERSATIONS_CACHE_AGENT, thread, null);
  }

  private async readIndex(): Promise<ConversationIndexEntry[]> {
    const raw = await this.store
      .cacheGet<unknown>(CONV_INDEX_KEY, CONVERSATIONS_CACHE_AGENT)
      .catch(() => null);
    if (!Array.isArray(raw)) return [];
    return raw
      .map(normalizeIndexEntry)
      .filter((e): e is ConversationIndexEntry => e !== null);
  }

  /** Newest-first upsert of one index entry (serialized on the index key). */
  private async touchIndex(entry: ConversationIndexEntry): Promise<void> {
    await withLock(CONV_INDEX_KEY, async () => {
      const index = await this.readIndex();
      const next = [entry, ...index.filter((e) => e.id !== entry.id)].slice(0, INDEX_CAP);
      await this.store.cacheSet(CONV_INDEX_KEY, CONVERSATIONS_CACHE_AGENT, next, null);
    }).catch((err) => console.warn("[conversations] index update failed:", err));
  }

  /** Patch an existing index entry in place (no message recorded). */
  private async patchIndex(
    id: string,
    patch: Partial<ConversationIndexEntry>,
  ): Promise<void> {
    await withLock(CONV_INDEX_KEY, async () => {
      const index = await this.readIndex();
      const next = index.map((e) => (e.id === id ? { ...e, ...patch, id: e.id } : e));
      await this.store.cacheSet(CONV_INDEX_KEY, CONVERSATIONS_CACHE_AGENT, next, null);
    }).catch((err) => console.warn("[conversations] index patch failed:", err));
  }

  /** Remove an index entry; true when one was present. */
  private async dropIndex(id: string): Promise<boolean> {
    return withLock(CONV_INDEX_KEY, async () => {
      const index = await this.readIndex();
      const next = index.filter((e) => e.id !== id);
      if (next.length === index.length) return false;
      await this.store.cacheSet(CONV_INDEX_KEY, CONVERSATIONS_CACHE_AGENT, next, null);
      return true;
    }).catch((err) => {
      console.warn("[conversations] index drop failed:", err);
      return false;
    });
  }

  private async audit(kind: string, entry: Record<string, unknown>): Promise<void> {
    try {
      await this.store.appendAudit({
        agentId: CONVERSATIONS_CACHE_AGENT,
        kind,
        entry,
      });
    } catch (err) {
      console.warn(`[conversations] appendAudit(${kind}) failed:`, err);
    }
  }

  // ── Recording ─────────────────────────────────────────────────

  /**
   * Record one INBOUND customer message (every platform, including WhatsApp
   * customer-mode chats — they funnel through the same social engine).
   * Returns the stored message, or null on invalid input / store failure.
   */
  async recordInbound(input: RecordInboundInput): Promise<ConversationMessage | null> {
    if (!isPlatform(input?.platform) || !String(input?.externalUserId ?? "").trim()) {
      return null;
    }
    const userId = String(input.externalUserId).trim();
    const id = conversationId(input.platform, userId);
    const message: ConversationMessage = {
      dir: "in",
      text: clip(input.text ?? "", MESSAGE_TEXT_CAP),
      ts: toIso(input.ts),
      kind: input.kind ? normalizeKind(input.kind) : "message",
    };
    // WhatsApp identity IS the phone (wa_id, leading + stripped).
    const phone = input.phone ?? (input.platform === "whatsapp" ? userId : undefined);
    return this.append(id, input.platform, userId, message, {
      ...(input.username ? { username: input.username } : {}),
      ...(phone ? { phone } : {}),
    });
  }

  /**
   * Record one OUTBOUND message: an automation reply (kind "static" |
   * "persona" | "flow_prompt", auto:true), an approved delivery
   * ("approval_result", auto:true), an operator's manual send ("manual",
   * auto:false) or a NOT-delivered thread notice ("system" — a pending or
   * declined approval). Returns the stored message, or null on failure.
   */
  async recordOutbound(input: RecordOutboundInput): Promise<ConversationMessage | null> {
    if (!isPlatform(input?.platform) || !String(input?.externalUserId ?? "").trim()) {
      return null;
    }
    const userId = String(input.externalUserId).trim();
    const id = conversationId(input.platform, userId);
    const message: ConversationMessage = {
      dir: "out",
      text: clip(input.text ?? "", MESSAGE_TEXT_CAP),
      ts: toIso(input.ts),
      auto: Boolean(input.auto),
      kind: normalizeKind(input.kind),
      ...(input.approvalId ? { approvalId: String(input.approvalId) } : {}),
    };
    return this.append(id, input.platform, userId, message, {
      ...(input.username ? { username: input.username } : {}),
      ...(input.phone ? { phone: input.phone } : {}),
    });
  }

  /** Shared append path: thread read-modify-write + index refresh. */
  private async append(
    id: string,
    platform: ConversationPlatform,
    userId: string,
    message: ConversationMessage,
    contact: { username?: string; phone?: string },
  ): Promise<ConversationMessage | null> {
    try {
      const thread = await withLock(id, async () => {
        const existing = (await this.readThread(id)) ?? {
          contact: { externalUserId: userId },
          messages: [],
          lastAt: message.ts,
          messageCount: 0,
        };
        const nextContact: ConversationContact = { ...existing.contact, externalUserId: userId };
        if (contact.username) nextContact.username = contact.username;
        if (contact.phone) nextContact.phone = contact.phone;
        const next: ConversationThread = {
          ...existing,
          contact: nextContact,
          messages: [...existing.messages, message].slice(-THREAD_MESSAGES_CAP),
          lastAt: message.ts,
          messageCount: existing.messageCount + 1,
        };
        await this.writeThread(id, next);
        return next;
      });
      await this.touchIndex(indexEntryFor(id, platform, thread, message.text));
      return message;
    } catch (err) {
      console.warn(`[conversations] record ${message.dir} failed for ${id}:`, err);
      return null;
    }
  }

  // ── Takeover (pause automation for one thread) ────────────────

  /**
   * Toggle the per-thread takeover flag and audit "conversation.takeover".
   * Returns the new flag, or null when the thread does not exist / the store
   * failed (callers turn null into a 404/500).
   */
  async setTakeover(
    id: string,
    on: boolean,
    by?: string,
  ): Promise<boolean | null> {
    const parts = parseConversationId(id);
    if (!parts) return null;
    try {
      const thread = await withLock(id, async () => {
        const existing = await this.readThread(id);
        if (!existing) return null;
        const next: ConversationThread = {
          ...existing,
          takeover: {
            on: Boolean(on),
            ...(by ? { by: String(by) } : {}),
            at: new Date().toISOString(),
          },
        };
        await this.writeThread(id, next);
        return next;
      });
      if (!thread) return null;
      await this.patchIndex(id, { takeover: Boolean(on) });
      await this.audit("conversation.takeover", {
        id,
        platform: parts.platform,
        on: Boolean(on),
        by: by ?? null,
      });
      return Boolean(on);
    } catch (err) {
      console.warn(`[conversations] setTakeover(${id}) failed:`, err);
      return null;
    }
  }

  /** True when automation is paused for this thread (false on any error). */
  async isTakeover(id: string): Promise<boolean> {
    const thread = await this.readThread(id).catch(() => null);
    return Boolean(thread?.takeover?.on);
  }

  // ── Reads ─────────────────────────────────────────────────────

  /** Full thread (contact + capped messages + takeover/lead/flow links). */
  async getThread(id: string): Promise<ConversationThread | null> {
    if (!parseConversationId(id)) return null;
    return this.readThread(id).catch((err) => {
      console.warn(`[conversations] getThread(${id}) failed:`, err);
      return null;
    });
  }

  /** Newest-first index slice, optionally filtered to one platform. */
  async listThreads(options: ListThreadsOptions = {}): Promise<ConversationIndexEntry[]> {
    try {
      const limitRaw = Number(options.limit ?? 50);
      const limit = Number.isFinite(limitRaw) && limitRaw >= 1
        ? Math.min(Math.trunc(limitRaw), INDEX_CAP)
        : 50;
      const index = await this.readIndex();
      const filtered = options.platform
        ? index.filter((e) => e.platform === options.platform)
        : index;
      return filtered
        .slice()
        .sort((a, b) => Date.parse(b.lastAt) - Date.parse(a.lastAt))
        .slice(0, limit);
    } catch (err) {
      console.warn("[conversations] listThreads failed:", err);
      return [];
    }
  }

  // ── Links ─────────────────────────────────────────────────────

  /** Attach the engine lead key (capture-by-default) to a thread. */
  async linkLead(id: string, leadKey: string): Promise<boolean> {
    return this.link(id, { leadKey: String(leadKey ?? "").trim() || undefined });
  }

  /** Attach the qualification-flow run id (flow start / advance). */
  async linkFlowRun(id: string, runId: string): Promise<boolean> {
    return this.link(id, { flowRunId: String(runId ?? "").trim() || undefined });
  }

  private async link(
    id: string,
    patch: { leadKey?: string; flowRunId?: string },
  ): Promise<boolean> {
    const parts = parseConversationId(id);
    if (!parts) return false;
    const hasLead = patch.leadKey !== undefined;
    const hasRun = patch.flowRunId !== undefined;
    if (!hasLead && !hasRun) return false;
    try {
      const thread = await withLock(id, async () => {
        const existing = await this.readThread(id);
        if (!existing) return null;
        const next: ConversationThread = { ...existing };
        if (hasLead) {
          if (patch.leadKey) next.leadKey = patch.leadKey;
          else delete next.leadKey;
        }
        if (hasRun) {
          if (patch.flowRunId) next.flowRunId = patch.flowRunId;
          else delete next.flowRunId;
        }
        await this.writeThread(id, next);
        return next;
      });
      if (!thread) return false;
      await this.patchIndex(id, {
        ...(hasLead ? { leadKey: patch.leadKey } : {}),
        ...(hasRun ? { flowRunId: patch.flowRunId } : {}),
      });
      return true;
    } catch (err) {
      console.warn(`[conversations] link(${id}) failed:`, err);
      return false;
    }
  }

  // ── Deletion (GDPR / retention) ───────────────────────────────

  /**
   * Wipe a thread: the cache row is set to null with a 1ms TTL (the store's
   * deletion idiom — the row is dropped on the next read) and the index entry
   * is removed, then "conversation.deleted" is audited. Returns true when
   * something existed to delete.
   */
  async deleteThread(id: string): Promise<boolean> {
    const parts = parseConversationId(id);
    if (!parts) return false;
    try {
      const existing = await withLock(id, async () => {
        const thread = await this.readThread(id);
        // The store's deletion idiom (see flows/store.ts clearActive): a null
        // value with a 1ms TTL is dropped on the next read.
        await this.store
          .cacheSet(this.threadKey(id), CONVERSATIONS_CACHE_AGENT, null, 1)
          .catch(() => {});
        return thread;
      });
      const hadIndex = await this.dropIndex(id);
      if (!existing && !hadIndex) return false;
      await this.audit("conversation.deleted", {
        id,
        platform: parts.platform,
        messageCount: existing?.messageCount ?? 0,
      });
      return true;
    } catch (err) {
      console.warn(`[conversations] deleteThread(${id}) failed:`, err);
      return false;
    }
  }
}
