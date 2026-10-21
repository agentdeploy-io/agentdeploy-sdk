/**
 * Calla event-bus names and WS wire envelope.
 * Every state change on either runtime publishes to /events under these names.
 */

export const CALLA_EVENTS = {
  /** Agent DO state sync (full or partial CallaState). */
  agentState: "calla:agent:state",
  /** New HITL gate surfaced. Payload: ApprovalRequest. */
  approvalRequest: "calla:approval:request",
  /** Approval decided/expired. Payload: { id, status }. */
  approvalResolved: "calla:approval:resolved",
  /** Tool call lifecycle. Payload: { toolName, status, args?, output? }. */
  toolCall: "calla:tool:call",
  /** Chat/agent message. */
  message: "calla:message",
  /** Agent error. */
  error: "calla:error",
  /** jev classifier finished a batch. Payload: classification results. */
  classificationCompleted: "calla:classification:completed",
  /** Heartbeat for liveness. */
  heartbeat: "calla:heartbeat",
  /** Voice call opened (Telnyx stream connected). Payload: { callId, from?, to? }. */
  voiceCallStart: "calla:voice:call_start",
  /** Voice call active (Telnyx status in-progress). */
  voiceCallActive: "calla:voice:call_active",
  /** Voice call ended. Payload: { callId, status, durationSec? }. */
  voiceCallEnd: "calla:voice:call_end",
  /** Live transcript line from an active voice call (UI Calls monitor). */
  voiceTranscript: "calla:voice:transcript",
  /** Voice call escalated to a human (triage or operator). Payload: { callId, reason, source }. */
  voiceEscalation: "calla:voice:escalation",
  /** Voice booking outcome. Payload: { callId, status, detail? }. */
  voiceBooking: "calla:voice:booking",
} as const;

export type CallaEventName = (typeof CALLA_EVENTS)[keyof typeof CALLA_EVENTS];

/** Control frames on the /events socket. */
export const CALLA_CONTROL = {
  hello: "calla:hello",
  ping: "calla:ping",
  pong: "calla:pong",
  subscribe: "calla:subscribe",
} as const;

export type CallaControlName =
  (typeof CALLA_CONTROL)[keyof typeof CALLA_CONTROL];

/**
 * Wire envelope for every frame on the /events WebSocket.
 * Server -> client: { type: CallaEventName, id?, agentId?, payload, ts }
 * Client -> server: CallaSubscribeFrame | ping/pong
 *
 * `id` is the hub's monotonic SQLite rowid — clients track it as a cursor and
 * request gap-fill after reconnect (subscribe.since / GET /events/recent?since=).
 */
export interface CallaWsFrame {
  type: CallaEventName | CallaControlName;
  /** Monotonic hub id; doubles as the replay cursor. */
  id?: string;
  agentId?: string;
  deploymentId?: string;
  payload?: unknown;
  ts?: number;
}

/**
 * Client → hub subscription frame. `channels` scopes delivery (agent ids or
 * event names); `since` requests replay of every frame with id > since.
 * The hub persists this per-connection (serializeAttachment) so it survives
 * Durable Object hibernation.
 */
export interface CallaSubscribeFrame {
  type: typeof CALLA_CONTROL.subscribe;
  channels?: string[];
  since?: string;
}

/**
 * Exact heartbeat strings. The hub registers a DO WebSocket auto-response
 * pair (CALLA_PING_TEXT → CALLA_PONG_TEXT) so pings are answered by the
 * runtime WITHOUT waking the Durable Object. Both sides must use these
 * constants byte-for-byte or every ping becomes a billed DO invocation.
 */
export const CALLA_PING_TEXT = "calla:ping";
export const CALLA_PONG_TEXT = "calla:pong";

/** Application WS close codes. */
export const CALLA_WS_CLOSE = {
  /** Token missing/invalid — client must re-auth (fresh URL) before retrying. */
  unauthorized: 4001,
  /** Hub at connection cap — retry with backoff. */
  overCapacity: 1013,
} as const;

export function callaFrame(
  type: CallaWsFrame["type"],
  payload?: unknown,
  extra?: { agentId?: string; deploymentId?: string; id?: string },
): CallaWsFrame {
  return { type, payload, ts: Date.now(), ...extra };
}
