/**
 * Conversations REST Adapter
 * ──────────────────────────
 * Client over the brain's channel-conversation surfaces (Instagram /
 * WhatsApp / TikTok DM threads + takeover + flow-run detail) consumed by
 * the Conversations screen and the Reports flow-run dialog.
 *
 * Mirrors ops-client / skills-client conventions:
 *   - base URL from runtime config (getBrainUrl, default "/brain" proxy)
 *   - authFetch (cookie / Bearer edge-JWT depending on deployment)
 *   - disabled mode (BRAIN_URL ""/"none")
 *
 * Degradation contract: the /conversations endpoints land alongside (or
 * after) this screen, so a 404 (older brain), a disabled brain, or an
 * unreachable brain are ALL normal states. Every method resolves — it never
 * throws into render — returning `{data: null, unreachable: true}` plus
 * enough context (`disabled`, `status`, `error`) for the UI to say honestly
 * why it has nothing to show. A 404 is treated exactly like unreachable.
 *
 * Endpoints (frozen contract):
 *   GET    {base}/conversations?platform=&limit= → { conversations, total }
 *   GET    {base}/conversations/:id              → ConversationDetail
 *   POST   {base}/conversations/:id/message      → { ok, message } | 502 { error }
 *   POST   {base}/conversations/:id/takeover     → { ok, takeover }
 *   DELETE {base}/conversations/:id              → { ok }
 *   GET    {base}/flows/runs/:id                 → { run }
 */

import { getBrainUrl } from "@/config";
import { authFetch } from "@/hooks/useAuthFetch";
import { asRecord, firstNumber, firstString } from "@/lib/ops-client";

// ─── Types ───────────────────────────────────────────────────────

/** Set on every result when BRAIN_URL is empty/"none" (brain intentionally off). */
export const CONVERSATIONS_CLIENT_DISABLED =
  "Brain not configured — set BRAIN_URL to read conversations.";

export type ConversationPlatform = "instagram" | "tiktok" | "whatsapp" | string;

export type ConversationMessageKind =
  | "message"
  | "flow_prompt"
  | "persona"
  | "static"
  | "approval_result"
  | "manual"
  | "system"
  | string;

/** One row of the conversation list. */
export interface ConversationSummary {
  id: string;
  platform: ConversationPlatform;
  username?: string;
  phone?: string;
  lastMessage: string;
  lastAt: string;
  messageCount: number;
  takeover: boolean;
  leadKey?: string;
  flowRunId?: string;
  flowStatus?: string;
  flowTier?: string;
}

export interface ConversationListData {
  conversations: ConversationSummary[];
  total: number;
}

/** One message inside a thread. */
export interface ConversationMessage {
  dir: "in" | "out";
  text: string;
  ts: string;
  /** True when the brain sent it (bot); false/absent for operator or lead. */
  auto?: boolean;
  kind?: ConversationMessageKind;
  approvalId?: string;
}

export interface ConversationContact {
  username?: string;
  phone?: string;
  externalUserId?: string;
}

export interface ConversationLead {
  key: string;
  source?: string;
}

export interface ConversationFlowRouting {
  repId?: string;
  repName?: string;
  proposedSlots?: unknown[];
  link?: string;
  bookedAppointmentId?: string;
}

/** Flow-run state embedded in a conversation (or read standalone). */
export interface ConversationFlowRun {
  id: string;
  flowId: string;
  status: string;
  leadKey?: string;
  currentField?: string;
  answers: Record<string, unknown>;
  score?: number;
  tier?: string;
  routing?: ConversationFlowRouting;
  /** Untouched payload — panels may read extra fields without a client change. */
  raw: Record<string, unknown>;
}

export interface ConversationDetail {
  id: string;
  platform: ConversationPlatform;
  contact: ConversationContact;
  messages: ConversationMessage[];
  takeover: boolean;
  lead?: ConversationLead;
  flowRun?: ConversationFlowRun;
  raw: Record<string, unknown>;
}

export interface SendMessageData {
  ok: boolean;
  /** The stored outbound message when the brain echoes it back. */
  message: ConversationMessage | null;
}

export interface SetTakeoverData {
  ok: boolean;
  takeover: boolean;
}

export interface RemoveConversationData {
  ok: boolean;
}

/**
 * Result envelope for every call. `data` is null on ANY failure — callers
 * branch on `unreachable` / `error` instead of try/catch.
 */
export interface ConversationsResult<T> {
  data: T | null;
  /** True when the brain produced no usable answer (disabled, network, 404, 5xx). */
  unreachable: boolean;
  /** True when BRAIN_URL is empty/"none". */
  disabled: boolean;
  /** HTTP status when the brain answered; null on network failure / disabled. */
  status: number | null;
  /** Human-readable failure reason (null when the call succeeded). */
  error: string | null;
}

export interface ConversationsClient {
  /** False when BRAIN_URL is empty/"none" — every call resolves unreachable. */
  enabled: boolean;
  /** Resolved brain base URL. */
  baseUrl: string;
  list(platform?: string, limit?: number): Promise<ConversationsResult<ConversationListData>>;
  get(id: string): Promise<ConversationsResult<ConversationDetail>>;
  send(id: string, text: string): Promise<ConversationsResult<SendMessageData>>;
  setTakeover(id: string, on: boolean): Promise<ConversationsResult<SetTakeoverData>>;
  remove(id: string): Promise<ConversationsResult<RemoveConversationData>>;
  getFlowRun(id: string): Promise<ConversationsResult<ConversationFlowRun>>;
}

// ─── Helpers ─────────────────────────────────────────────────────

function failResult<T>(partial: {
  disabled: boolean;
  status: number | null;
  error: string;
}): ConversationsResult<T> {
  return {
    data: null,
    unreachable: true,
    disabled: partial.disabled,
    status: partial.status,
    error: partial.error,
  };
}

function okResult<T>(data: T, status: number | null): ConversationsResult<T> {
  return { data, unreachable: false, disabled: false, status, error: null };
}

// ─── Mappers ─────────────────────────────────────────────────────

function mapMessage(item: unknown): ConversationMessage | null {
  const rec = asRecord(item);
  const dir = firstString(rec.dir, rec.direction, rec.from)?.toLowerCase();
  const text = firstString(rec.text, rec.body, rec.content);
  if (text === undefined) return null;
  return {
    dir: dir === "out" || dir === "outbound" || dir === "bot" ? "out" : "in",
    text,
    ts: firstString(rec.ts, rec.timestamp, rec.at, rec.createdAt) ?? "",
    ...(typeof rec.auto === "boolean" ? { auto: rec.auto } : {}),
    ...(firstString(rec.kind, rec.type) ? { kind: firstString(rec.kind, rec.type) } : {}),
    ...(firstString(rec.approvalId, rec.approval_id)
      ? { approvalId: firstString(rec.approvalId, rec.approval_id) }
      : {}),
  };
}

function mapRouting(rec: Record<string, unknown>): ConversationFlowRouting | undefined {
  const routing = asRecord(rec.routing);
  const repId = firstString(routing.repId, routing.rep_id, routing.rep);
  const repName = firstString(routing.repName, routing.rep_name);
  const link = firstString(routing.link, routing.url);
  const slots = Array.isArray(routing.proposedSlots)
    ? routing.proposedSlots
    : Array.isArray(routing.proposed_slots)
      ? routing.proposed_slots
      : undefined;
  const bookedAppointmentId = firstString(
    routing.bookedAppointmentId,
    routing.booked_appointment_id,
  );
  if (!repId && !repName && !link && !slots && !bookedAppointmentId) return undefined;
  return { repId, repName, proposedSlots: slots, link, bookedAppointmentId };
}

function answersOf(rec: Record<string, unknown>): Record<string, unknown> {
  const candidates = [rec.answers, asRecord(rec.state).answers, asRecord(rec.context).answers];
  for (const candidate of candidates) {
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }
  return {};
}

/** Map `{...FlowRun}` payloads (conversation-embedded and /flows/runs/:id). */
export function mapConversationFlowRun(item: unknown): ConversationFlowRun | null {
  const rec = asRecord(item);
  const context = asRecord(rec.context ?? rec.input ?? rec.payload);
  const id = firstString(rec.id, rec.runId, rec.flowRunId);
  if (!id) return null;
  return {
    id,
    flowId: firstString(rec.flowId, rec.flow, rec.workflowId, context.flowId) ?? "flow",
    status: (firstString(rec.status, rec.state) ?? "unknown").toLowerCase(),
    ...(firstString(rec.leadKey, rec.lead_key, context.leadKey)
      ? { leadKey: firstString(rec.leadKey, rec.lead_key, context.leadKey) }
      : {}),
    ...(firstString(rec.currentField, rec.current_field, context.currentField)
      ? { currentField: firstString(rec.currentField, rec.current_field, context.currentField) }
      : {}),
    answers: answersOf(rec),
    ...(firstNumber(rec.score, rec.qualificationScore, context.score) !== undefined
      ? { score: firstNumber(rec.score, rec.qualificationScore, context.score) }
      : {}),
    ...(firstString(rec.tier, rec.qualificationTier, context.tier)
      ? { tier: firstString(rec.tier, rec.qualificationTier, context.tier) }
      : {}),
    ...(mapRouting(rec) ? { routing: mapRouting(rec) } : {}),
    raw: rec,
  };
}

function mapSummary(item: unknown): ConversationSummary | null {
  const rec = asRecord(item);
  const id = firstString(rec.id, rec.conversationId, rec.conversation_id);
  if (!id) return null;
  return {
    id,
    platform: (firstString(rec.platform, rec.channel) ?? "unknown").toLowerCase(),
    ...(firstString(rec.username, rec.handle) ? { username: firstString(rec.username, rec.handle) } : {}),
    ...(firstString(rec.phone, rec.phoneNumber) ? { phone: firstString(rec.phone, rec.phoneNumber) } : {}),
    lastMessage: firstString(rec.lastMessage, rec.last_message, rec.preview) ?? "",
    lastAt: firstString(rec.lastAt, rec.last_at, rec.updatedAt, rec.updated_at) ?? "",
    messageCount: firstNumber(rec.messageCount, rec.message_count) ?? 0,
    takeover: rec.takeover === true,
    ...(firstString(rec.leadKey, rec.lead_key) ? { leadKey: firstString(rec.leadKey, rec.lead_key) } : {}),
    ...(firstString(rec.flowRunId, rec.flow_run_id)
      ? { flowRunId: firstString(rec.flowRunId, rec.flow_run_id) }
      : {}),
    ...(firstString(rec.flowStatus, rec.flow_status)
      ? { flowStatus: firstString(rec.flowStatus, rec.flow_status) }
      : {}),
    ...(firstString(rec.flowTier, rec.flow_tier)
      ? { flowTier: firstString(rec.flowTier, rec.flow_tier) }
      : {}),
  };
}

function mapDetail(item: unknown, fallbackId: string): ConversationDetail | null {
  const rec = asRecord(item);
  const id = firstString(rec.id, rec.conversationId) ?? fallbackId;
  const contactRec = asRecord(rec.contact);
  const leadRec = asRecord(rec.lead);
  const messages = Array.isArray(rec.messages)
    ? (rec.messages as unknown[]).map(mapMessage).filter((m): m is ConversationMessage => m !== null)
    : [];
  const flowRun = mapConversationFlowRun(rec.flowRun ?? rec.flow_run);
  const leadKey = firstString(leadRec.key, leadRec.leadKey, rec.leadKey);

  return {
    id,
    platform: (firstString(rec.platform, rec.channel) ?? "unknown").toLowerCase(),
    contact: {
      ...(firstString(contactRec.username, contactRec.handle)
        ? { username: firstString(contactRec.username, contactRec.handle) }
        : {}),
      ...(firstString(contactRec.phone, contactRec.phoneNumber)
        ? { phone: firstString(contactRec.phone, contactRec.phoneNumber) }
        : {}),
      ...(firstString(contactRec.externalUserId, contactRec.external_user_id, contactRec.id)
        ? {
            externalUserId: firstString(
              contactRec.externalUserId,
              contactRec.external_user_id,
              contactRec.id,
            ),
          }
        : {}),
    },
    messages,
    takeover: rec.takeover === true,
    ...(leadKey ? { lead: { key: leadKey, ...(firstString(leadRec.source) ? { source: firstString(leadRec.source) } : {}) } } : {}),
    ...(flowRun ? { flowRun } : {}),
    raw: rec,
  };
}

// ─── Factory ─────────────────────────────────────────────────────

export function createConversationsClient(
  baseUrl: string = getBrainUrl(),
): ConversationsClient {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const enabled = base.length > 0 && base.toLowerCase() !== "none";

  /** HTTP + JSON parse. Never throws — failures come back as `error`. */
  async function request(
    action: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<{ data: unknown; status: number | null; error: string | null }> {
    if (!enabled) {
      return { data: null, status: null, error: CONVERSATIONS_CLIENT_DISABLED };
    }
    try {
      const res = await authFetch(`${base}${path}`, {
        method: init?.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) {
        // Surface the provider's own message when the brain sends a JSON body
        // (502s from Instagram/WhatsApp carry {error: "…"}).
        let message = `${res.status} ${res.statusText}`.trim();
        try {
          const body = asRecord(await res.json());
          const detail = firstString(body.error, body.message);
          if (detail) message = detail;
        } catch {
          // Non-JSON error body — keep the status line.
        }
        return { data: null, status: res.status, error: message };
      }
      return { data: await res.json(), status: res.status, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : "request failed";
      return { data: null, status: null, error: `${action}: ${message}` };
    }
  }

  function query(params: Record<string, string | number | undefined>): string {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value === undefined || value === "") continue;
      search.set(key, String(value));
    }
    const qs = search.toString();
    return qs ? `?${qs}` : "";
  }

  function idPath(id: string): string {
    return encodeURIComponent(id);
  }

  return {
    enabled,
    baseUrl: base,

    async list(platform?: string, limit = 50): Promise<ConversationsResult<ConversationListData>> {
      const { data, status, error } = await request(
        "listConversations",
        `/conversations${query({ platform, limit })}`,
      );
      if (error) return failResult<ConversationListData>({ disabled: !enabled, status, error });
      const rec = asRecord(data);
      const rawList = Array.isArray(data)
        ? data
        : Array.isArray(rec.conversations)
          ? rec.conversations
          : [];
      const conversations = rawList
        .map(mapSummary)
        .filter((c): c is ConversationSummary => c !== null);
      const total = firstNumber(rec.total) ?? conversations.length;
      return okResult({ conversations, total }, status);
    },

    async get(id: string): Promise<ConversationsResult<ConversationDetail>> {
      const { data, status, error } = await request(
        "getConversation",
        `/conversations/${idPath(id)}`,
      );
      if (error) return failResult<ConversationDetail>({ disabled: !enabled, status, error });
      const detail = mapDetail(data, id);
      if (!detail) {
        return failResult<ConversationDetail>({
          disabled: false,
          status,
          error: "getConversation: malformed payload",
        });
      }
      return okResult(detail, status);
    },

    async send(id: string, text: string): Promise<ConversationsResult<SendMessageData>> {
      const { data, status, error } = await request(
        "sendMessage",
        `/conversations/${idPath(id)}/message`,
        { method: "POST", body: { text } },
      );
      if (error) return failResult<SendMessageData>({ disabled: !enabled, status, error });
      const rec = asRecord(data);
      return okResult({ ok: rec.ok !== false, message: mapMessage(rec.message) }, status);
    },

    async setTakeover(id: string, on: boolean): Promise<ConversationsResult<SetTakeoverData>> {
      const { data, status, error } = await request(
        "setTakeover",
        `/conversations/${idPath(id)}/takeover`,
        { method: "POST", body: { on } },
      );
      if (error) return failResult<SetTakeoverData>({ disabled: !enabled, status, error });
      const rec = asRecord(data);
      return okResult({ ok: rec.ok !== false, takeover: rec.takeover === true }, status);
    },

    async remove(id: string): Promise<ConversationsResult<RemoveConversationData>> {
      const { data, status, error } = await request(
        "removeConversation",
        `/conversations/${idPath(id)}`,
        { method: "DELETE" },
      );
      if (error) return failResult<RemoveConversationData>({ disabled: !enabled, status, error });
      const rec = asRecord(data);
      return okResult({ ok: rec.ok !== false }, status);
    },

    async getFlowRun(id: string): Promise<ConversationsResult<ConversationFlowRun>> {
      const { data, status, error } = await request(
        "getFlowRun",
        `/flows/runs/${idPath(id)}`,
      );
      if (error) return failResult<ConversationFlowRun>({ disabled: !enabled, status, error });
      const rec = asRecord(data);
      const run = mapConversationFlowRun(rec.run ?? data);
      if (!run) {
        return failResult<ConversationFlowRun>({
          disabled: false,
          status,
          error: "getFlowRun: malformed payload",
        });
      }
      return okResult(run, status);
    },
  };
}

/** Default client bound to the runtime BRAIN_URL config. */
export const conversationsClient: ConversationsClient = createConversationsClient();
