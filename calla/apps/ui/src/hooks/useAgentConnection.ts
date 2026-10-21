/**
 * useAgentConnection Hook
 * ────────────────────────
 * Manages WebSocket connection lifecycle for a single agent.
 *
 * Transport/lifecycle (reconnect backoff + full jitter, infinite retries with
 * a 60s slow-poll fallback, connection timeouts, online/visibility triggers,
 * outbound queueing) lives in WsLifecycleManager (@/lib/ws-lifecycle), shared
 * per agent URL through the ref-counted registry (@/lib/ws-registry). This
 * hook is now purely cf_agent_* protocol handling + React state.
 *
 * Features:
 *   - Auto-connect with jittered exponential-backoff reconnect (never gives
 *     up — overnight tabs recover via slowRetryMs polling)
 *   - NO application heartbeat on this socket (heartbeat: null) — the Agents
 *     SDK server does not answer calla:ping, so liveness relies on the
 *     connection timeout, close-driven reconnects and online/visibility
 *   - Connection status tracking (connecting → connected → degraded →
 *     disconnected/error)
 *   - Offline-queued message send (buffered frames flush FIFO on reconnect)
 *   - Stream-interruption recovery: a 45s inactivity watchdog and the
 *     manager's state transitions finalize a stuck streaming bubble
 *   - Graceful degradation (component still renders without connection)
 *   - Cleanup on unmount
 *
 * Usage:
 *   const { status, sendMessage, lastMessage, reconnect } = useAgentConnection(agent)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import type { Dispatch, SetStateAction } from "react";
import {
  type AgentRegistryEntry,
  buildAgentWsUrl,
  DEFAULT_AGENT_CONFIG,
} from "@/constants/agents";
import { errorHandler } from "@/errors/errorHandler";
import { AppError, AppErrors } from "@/errors/AppError";
import { ErrorCode } from "@/constants/errors";
import { toast } from "@/hooks/useToast";
import { buildAuthedWsUrl } from "@/hooks/useAuthFetch";
import { acquireManager } from "@/lib/ws-registry";
import type { WsLifecycleManager, WsState, WsStats } from "@/lib/ws-lifecycle";
import type { AgentConnectionStatus, ChatAttachment, ChatMessage } from "@/types/agent";

// ─── Types ───────────────────────────────────────────────────────

export interface AgentCommand {
  name: string;
  description: string;
  args: { name: string; description?: string; optional?: boolean }[];
  render: "json" | "table" | "markdown";
}

export interface UseAgentConnectionResult {
  status: AgentConnectionStatus;
  messages: ChatMessage[];
  lastError: string | null;
  /** True while the agent is generating a reply (drives the Stop button). */
  isStreaming: boolean;
  /**
   * Send a chat request. Works while the socket is down: the frame is
   * buffered in the lifecycle manager's outbound queue and flushes FIFO on
   * reconnect. Returns false only when the frame was dropped (queue
   * disabled/full-drop or the hook is detached from an agent).
   */
  sendMessage: (text: string, attachments?: ChatAttachment[]) => boolean;
  /** Appends a message to the pane (used by console slash-command results). */
  appendMessage: (message: ChatMessage) => void;
  /** Re-run the last user turn (drops the previous assistant reply). */
  regenerate: () => boolean;
  /** Aborts the in-flight reply (stop-generation). No-op when idle. */
  stopChat: () => boolean;
  /** Wipes the persisted conversation (server + pane). */
  clearChat: () => boolean;
  reconnect: () => void;
  disconnect: () => void;
  /** Connection attempt count (resets on successful connect) */
  reconnectAttempts: number;
  /** Live agent state synced via cf_agent_state messages */
  agentState: Record<string, unknown> | null;
  /** Agent identity from cf_agent_identity messages */
  agentIdentity: { id?: string; name?: string } | null;
  /** Last tool call observed in the stream (for UI feedback) */
  lastToolCall: { name: string; status: "running" | "done" | "error" } | null;
  /** Console slash commands from cf_agent_meta (empty when the agent defines none) */
  commands: AgentCommand[];
}

// ─── Stream interruption recovery ────────────────────────────────

/**
 * A streaming reply that goes silent for this long is finalized: the server
 * vanished mid-stream (dropped frame, DO eviction) and the bubble would
 * otherwise spin forever.
 */
const STREAM_INACTIVITY_MS = 45_000;

/** Mark the trailing streaming assistant bubble (if any) as finalized. */
function finalizeStreamingBubble(
  setMessages: Dispatch<SetStateAction<ChatMessage[]>>,
): void {
  setMessages((prev) => {
    if (prev.length === 0) return prev;
    const last = prev[prev.length - 1];
    if (last.role === "assistant" && last.streaming) {
      const updated = [...prev];
      updated[updated.length - 1] = { ...last, streaming: false };
      return updated;
    }
    return prev;
  });
}

/** Manager state → AgentConnectionStatus. */
function mapAgentState(state: WsState): AgentConnectionStatus {
  switch (state) {
    case "open":
      return "connected";
    case "connecting":
    case "reconnecting":
      return "connecting";
    case "degraded":
      return "degraded";
    case "failed":
      return "error";
    case "closed":
    case "idle":
    default:
      return "disconnected";
  }
}

/** Display attempt count: 0 while the socket is up (reset-on-open semantics). */
function displayAttempts(stats: WsStats): number {
  return stats.state === "open" || stats.state === "degraded" ? 0 : stats.attempts;
}

// ─── Hook ────────────────────────────────────────────────────────

export function useAgentConnection(agent: AgentRegistryEntry | null): UseAgentConnectionResult {
  const [status, setStatus] = useState<AgentConnectionStatus>("disconnected");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [lastError, setLastError] = useState<string | null>(null);
  const [reconnectAttempts, setReconnectAttempts] = useState(0);
  const [agentState, setAgentState] = useState<Record<string, unknown> | null>(null);
  const [agentIdentity, setAgentIdentity] = useState<{ id?: string; name?: string } | null>(null);
  const [lastToolCall, setLastToolCall] = useState<{
    name: string;
    status: "running" | "done" | "error";
  } | null>(null);
  const [commands, setCommands] = useState<AgentCommand[]>([]);

  const managerRef = useRef<WsLifecycleManager | null>(null);
  const agentIdRef = useRef<string | null>(null);
  // Id of the in-flight chat request (null when idle) — used to target
  // stop-generation at the exact request the agent is generating.
  const activeRequestIdRef = useRef<string | null>(null);
  // Mirror of `messages` for callbacks that must read the latest pane
  // without a stale closure (and to keep send side effects OUT of
  // setMessages updaters, which StrictMode double-invokes).
  const messagesRef = useRef<ChatMessage[]>([]);
  messagesRef.current = messages;
  // Stream inactivity watchdog (45s since the last delta for the active
  // request) — fires once per interruption.
  const streamWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ─── Stream watchdog ───────────────────────────────────────────

  const clearStreamWatchdog = useCallback(() => {
    if (streamWatchdogRef.current) {
      clearTimeout(streamWatchdogRef.current);
      streamWatchdogRef.current = null;
    }
  }, []);

  /**
   * Finalize a stuck stream: inactivity timeout OR the socket leaving the
   * open state mid-reply. Toasts once per interruption (guarded by the
   * active-request/streaming-bubble check).
   */
  const interruptStream = useCallback(
    (agentName: string, reason: "timeout" | "disconnected") => {
      const hadActiveRequest = activeRequestIdRef.current !== null;
      const hasStreamingBubble = messagesRef.current.some(
        (m) => m.role === "assistant" && m.streaming,
      );
      if (!hadActiveRequest && !hasStreamingBubble) return;
      activeRequestIdRef.current = null;
      clearStreamWatchdog();
      finalizeStreamingBubble(setMessages);
      if (hadActiveRequest) {
        toast.warning(
          "Stream interrupted",
          reason === "timeout"
            ? `No response chunks from ${agentName} for 45s — the partial reply was finalized.`
            : `${agentName} went offline mid-reply — the partial reply was finalized.`,
        );
      }
    },
    [clearStreamWatchdog],
  );

  const armStreamWatchdog = useCallback(
    (agentName: string) => {
      clearStreamWatchdog();
      streamWatchdogRef.current = setTimeout(() => {
        streamWatchdogRef.current = null;
        interruptStream(agentName, "timeout");
      }, STREAM_INACTIVITY_MS);
    },
    [clearStreamWatchdog, interruptStream],
  );

  // ─── Send helpers ──────────────────────────────────────────────

  /**
   * Transmit a chat request (shared by send + regenerate). Offline sends are
   * QUEUED by the manager and flush FIFO on reconnect. Returns false only
   * when the frame was dropped.
   */
  const sendRequest = useCallback(
    (
      manager: WsLifecycleManager,
      requestId: string,
      uiMessages: Array<{ id: string; role: string; parts: unknown[] }>,
    ): boolean => {
      const result = manager.send(
        JSON.stringify({
          type: "cf_agent_use_chat_request",
          id: requestId,
          init: {
            method: "POST",
            body: JSON.stringify({ messages: uiMessages }),
          },
        }),
      );
      if (result === "dropped") {
        const appError = new AppError(ErrorCode.WS_MESSAGE_SEND_FAILED, {
          context: { agentId: agent?.id },
        });
        errorHandler.handleError(appError, { agentId: agent?.id });
        return false;
      }
      armStreamWatchdog(agent?.name ?? "Agent");
      return true;
    },
    [agent, armStreamWatchdog],
  );

  // ─── Connection lifecycle (shared manager via the registry) ────

  useEffect(() => {
    if (!agent) return;

    agentIdRef.current = agent.id;
    // Registry key: the agent WS URL WITHOUT token — the auth token is
    // applied per attempt inside the url factory (fresh edge JWT).
    const key = buildAgentWsUrl(agent);

    const { manager, release } = acquireManager(key, () => ({
      // Re-invoked on EVERY attempt — fresh token per reconnect.
      url: () => buildAuthedWsUrl(buildAgentWsUrl(agent)),
      // The Agents SDK server does NOT answer calla:ping — no app heartbeat
      // on this socket. Liveness = connectionTimeoutMs + close-driven
      // reconnects + online/visibility triggers.
      heartbeat: null,
      backoff: {
        baseMs: DEFAULT_AGENT_CONFIG.reconnectBaseDelay,
        maxMs: 30_000,
        jitter: "full",
      },
      // Infinite retries; beyond the budget (never, by default) poll at 60s.
      maxAttempts: DEFAULT_AGENT_CONFIG.autoReconnect ? Number.POSITIVE_INFINITY : 0,
      slowRetryMs: 60_000,
      connectionTimeoutMs: 8_000,
      minUptimeMs: 5_000,
      queue: { enabled: true, maxSize: 100 },
      label: `agent:${agent.id}`,
      // All frame handling happens in the per-instance listener below.
      onMessage: () => {},
    }));
    managerRef.current = manager;

    const removeListener = manager.addListener({
      onOpen: (info) => {
        setLastError(null);
        // Notify on reconnect only (the initial connect is expected).
        if (info.isReconnect) {
          toast.success("Reconnected", `${agent.name} is back online.`);
        }
      },

      onStateChange: (state, stats) => {
        setStatus(mapAgentState(state));
        setReconnectAttempts(displayAttempts(stats));
        // Socket gone mid-reply → finalize the streaming bubble. "degraded"
        // keeps the socket (offline blip); every other non-open state means
        // the stream cannot continue.
        if (state !== "open" && state !== "degraded") {
          interruptStream(agent.name, "disconnected");
        }
      },

      onError: (error) => {
        if (!error.fatal) return;
        setLastError(error.message);
        const appError = AppErrors.connectionFailed(agent.id, new Error(error.message));
        errorHandler.handleError(appError, { agentId: agent.id });
      },

      onMessage: (raw) => {
        try {
          let data: Record<string, unknown>;
          try {
            data = JSON.parse(raw);
          } catch {
            return; // Ignore non-JSON frames
          }

          const msgType = data.type as string | undefined;

          // ── cf_agent_use_chat_response: streaming response from AIChatAgent ──
          // Wire format: { type: "cf_agent_use_chat_response", id, body, done }
          // - body: JSON string containing a stream part object
          // - done: true when stream is complete
          //
          // Stream part types we care about:
          //   {"type":"text-delta","id":"txt-0","delta":"Hello"}
          //   {"type":"text-start","id":"txt-0"}
          //   {"type":"text-end","id":"txt-0"}
          //   {"type":"tool-output-available", ...}
          //   {"type":"finish","messageMetadata":{...}}
          //   {"type":"reasoning-delta", ...} — we skip reasoning for now
          if (
            msgType === "cf_agent_use_chat_response" ||
            msgType === "cf_agent_chat_messages"
          ) {
            // Any inbound chunk proves the stream is alive — re-arm the
            // inactivity watchdog for the active request.
            if (activeRequestIdRef.current) {
              armStreamWatchdog(agent.name);
            }

            const body = (data.body as string) ?? "";
            const isDone = (data.done as boolean) ?? false;

            if (body) {
              // Parse the stream part once — extract both text deltas and tool-call info
              const { text, toolCall } = parseStreamPart(body);

              if (text) {
                setMessages((prev) => {
                  // If last message was a streaming assistant message, append to it
                  if (prev.length > 0) {
                    const last = prev[prev.length - 1];
                    if (last.role === "assistant" && last.streaming) {
                      const updated = [...prev];
                      updated[updated.length - 1] = {
                        ...last,
                        content: last.content + text,
                      };
                      return updated;
                    }
                  }
                  // Create a new assistant message
                  return [
                    ...prev,
                    {
                      id: `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                      role: "assistant" as const,
                      content: text,
                      timestamp: new Date().toISOString(),
                      agentId: agent.id,
                      streaming: true,
                    },
                  ].slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit);
                });
              }

              // Track tool calls for UI feedback (e.g. "Calling searchKnowledgeBase...")
              if (toolCall) {
                setLastToolCall(toolCall);
              }
            }

            // Mark streaming as done
            if (isDone) {
              activeRequestIdRef.current = null;
              clearStreamWatchdog();
              finalizeStreamingBubble(setMessages);
            }
            return;
          }

          // ── cf_agent_state: live state sync from agent DO ──
          // Wire format: { type: "cf_agent_state", state: {...} }
          // The agent pushes its full or partial state on changes.
          if (msgType === "cf_agent_state") {
            const state = (data.state as Record<string, unknown> | undefined) ?? data;
            setAgentState((prev) => ({ ...prev, ...state }));
            return;
          }

          // ── cf_agent_identity: agent self-identification ──
          // Wire format: { type: "cf_agent_identity", id, name }
          // Sent once on connection open.
          if (msgType === "cf_agent_identity") {
            setAgentIdentity({
              id: data.id as string | undefined,
              name: data.name as string | undefined,
            });
            return;
          }

          // ── cf_agent_meta: console slash-command manifest ──
          // Wire format: { type: "cf_agent_meta", id, name, commands: [...] }
          // Sent once on connection open when the agent defines commands.
          if (msgType === "cf_agent_meta") {
            const rawCommands = Array.isArray(data.commands) ? data.commands : [];
            setCommands(
              (rawCommands as Array<Record<string, unknown>>)
                .filter((c) => typeof c.name === "string")
                .map((c) => ({
                  name: c.name as string,
                  description: typeof c.description === "string" ? c.description : "",
                  args: Array.isArray(c.args)
                    ? (c.args as Array<Record<string, unknown>>).map((a) => ({
                        name: typeof a.name === "string" ? a.name : "",
                        description: typeof a.description === "string" ? a.description : undefined,
                        optional: a.optional === true,
                      }))
                    : [],
                  render: c.render === "table" || c.render === "markdown" ? c.render : "json",
                })),
            );
            return;
          }

          // ── cf_agent_chat_history: persisted conversation replay ──
          // Wire format: { type:"cf_agent_chat_history", id, name,
          //   messages:[{ role, content, timestamp }] }
          // REPLACE semantics: the pane becomes exactly this list. Idempotent
          // across reconnects — history can never duplicate in the pane.
          if (msgType === "cf_agent_chat_history") {
            const rawMessages = Array.isArray(data.messages) ? data.messages : [];
            const restored: ChatMessage[] = [];
            for (const m of rawMessages as Array<Record<string, unknown>>) {
              const content = typeof m.content === "string" ? m.content : "";
              if (!content) continue;
              const role =
                m.role === "user" || m.role === "assistant" || m.role === "system"
                  ? m.role
                  : "assistant";
              restored.push({
                id:
                  typeof m.id === "string" && m.id
                    ? m.id
                    : `hist-${restored.length}-${Date.now()}`,
                role,
                content,
                timestamp:
                  typeof m.timestamp === "string" ? m.timestamp : new Date().toISOString(),
                agentId: agent.id,
              });
            }
            setMessages(restored);
            return;
          }

          // ── cf_agent_chat_reset_ack: server confirmed the history wipe ──
          // The pane was already cleared locally when the reset was sent;
          // nothing to do here beyond swallowing the frame.
          if (msgType === "cf_agent_chat_reset_ack") {
            return;
          }

          // ── cf_agent_chat_recovering: recovery notification ──
          if (msgType === "cf_agent_chat_recovering") {
            // Agent is recovering from a crash/interruption.
            toast.warning(
              "Agent Recovering",
              `${agent.name} is recovering from an interruption. Your conversation history is being restored.`,
            );
            return;
          }

          // ── Generic message format (fallback) ──
          const content =
            (data.content as string | undefined) ??
            (data.message as string | undefined) ??
            (data.text as string | undefined);

          if (content) {
            const message: ChatMessage = {
              id:
                (data.id as string | undefined) ??
                `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              role: (data.role as "user" | "assistant" | "system" | undefined) ?? "assistant",
              content,
              timestamp: (data.timestamp as string | undefined) ?? new Date().toISOString(),
              agentId: agent.id,
            };
            setMessages((prev) =>
              [...prev, message].slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit),
            );
          }
        } catch (error) {
          const appError = AppError.fromCaught(error, ErrorCode.WS_INVALID_MESSAGE);
          appError.context.agentId = agent.id;
          errorHandler.handleError(appError, { agentId: agent.id });
        }
      },
    });

    const initial = manager.getStats();
    setStatus(mapAgentState(initial.state));
    setReconnectAttempts(displayAttempts(initial));

    return () => {
      removeListener();
      clearStreamWatchdog();
      managerRef.current = null;
      release();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

  // ─── Clear Chat (buyer "Clear conversation" control) ──────────
  // Wipes the persisted server-side history (cf_agent_use_chat_reset) so the
  // next reconnect replays nothing, and clears the local pane immediately.
  const clearChat = useCallback((): boolean => {
    const manager = managerRef.current;
    if (!manager || manager.getState() !== "open") return false;
    manager.send(JSON.stringify({ type: "cf_agent_use_chat_reset" }));
    setMessages([]);
    return true;
  }, []);

  // ─── Stop Generation (abort the in-flight reply) ───────────────
  // Sends cf_agent_chat_request_cancel for the active request. The agent
  // aborts the upstream LLM call and replies with a finish frame; we also
  // finalize the streaming bubble locally for immediate feedback.
  const stopChat = useCallback((): boolean => {
    const manager = managerRef.current;
    const requestId = activeRequestIdRef.current;
    if (!manager || manager.getState() !== "open" || !requestId) return false;
    manager.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: requestId }));
    activeRequestIdRef.current = null;
    clearStreamWatchdog();
    finalizeStreamingBubble(setMessages);
    return true;
  }, [clearStreamWatchdog]);

  // ─── Send Message ─────────────────────────────────────────────

  const sendMessage = useCallback(
    (text: string, attachments?: ChatAttachment[]): boolean => {
      const manager = managerRef.current;
      if (!manager) {
        const appError = new AppError(ErrorCode.WS_MESSAGE_SEND_FAILED, {
          context: { agentId: agent?.id },
        });
        errorHandler.handleError(appError, { agentId: agent?.id });
        return false;
      }

      // Generate message IDs
      const userMessageId = `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      activeRequestIdRef.current = requestId;

      // Add user message to local state immediately (optimistic)
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
        ...(attachments && attachments.length > 0
          ? { attachmentNames: attachments.map((a) => a.name) }
          : {}),
      };

      // Build the messages array for the AIChatAgent protocol.
      // The AIChatAgent expects Vercel AI SDK UIMessage format:
      //   { id, role, parts: [{ type: "text", text }] }
      // We send the full conversation so the agent has context. File parts
      // ride on the NEW message only — earlier turns already had their
      // attachments inlined server-side (signed URLs expire).
      const allMessages = [...messagesRef.current, userMessage];
      const uiMessages = allMessages.map((m, i) => {
        const parts: unknown[] = [{ type: "text", text: m.content }];
        if (i === allMessages.length - 1 && attachments && attachments.length > 0) {
          for (const a of attachments) {
            parts.push({ type: "file", url: a.url, name: a.name, mimeType: a.mimeType, size: a.sizeBytes });
          }
        }
        return { id: m.id, role: m.role, parts };
      });

      if (!sendRequest(manager, requestId, uiMessages)) {
        activeRequestIdRef.current = null;
        return false;
      }

      setMessages(allMessages.slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit));
      return true;
    },
    [agent, sendRequest],
  );

  // ─── Regenerate (re-run the last user turn) ────────────────────
  // Drops the trailing assistant reply(s) after the last user message and
  // resends that user message. Attachments from the original turn are not
  // re-sent (their signed URLs may have expired) — the text stands alone.
  const regenerate = useCallback((): boolean => {
    const manager = managerRef.current;
    if (!manager) return false;
    const current = messagesRef.current;
    let lastUserIndex = -1;
    for (let i = current.length - 1; i >= 0; i -= 1) {
      if (current[i]!.role === "user") { lastUserIndex = i; break; }
    }
    if (lastUserIndex < 0) return false;
    const kept = current.slice(0, lastUserIndex + 1);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    const uiMessages = kept.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: "text", text: m.content }],
    }));
    if (!sendRequest(manager, requestId, uiMessages)) {
      activeRequestIdRef.current = null;
      return false;
    }
    setMessages(kept.slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit));
    return true;
  }, [sendRequest]);

  // ─── Reconnect (manual trigger) ───────────────────────────────

  const reconnect = useCallback(() => {
    managerRef.current?.forceReconnect();
    setReconnectAttempts(0);
  }, []);

  // ─── Disconnect (manual trigger) ──────────────────────────────

  const disconnect = useCallback(() => {
    managerRef.current?.close(1000, "user disconnect");
    setStatus("disconnected");
  }, []);

  // True while the agent is generating a reply (drives the Stop button).
  const isStreaming = messages.some((m) => m.role === "assistant" && m.streaming);

  const appendMessage = useCallback((message: ChatMessage) => {
    setMessages((prev) => [...prev, message]);
  }, []);

  return {
    status,
    messages,
    lastError,
    isStreaming,
    sendMessage,
    appendMessage,
    regenerate,
    stopChat,
    clearChat,
    reconnect,
    disconnect,
    reconnectAttempts,
    agentState,
    agentIdentity,
    lastToolCall,
    commands,
  };
}

// ─── AI SDK Stream Protocol Parser ───────────────────────────────

/**
 * Parsed result from an AI SDK stream part.
 */
interface StreamPartResult {
  /** Extracted text (from text-delta parts) */
  text: string;
  /** Tool call info (from tool-input-available / tool-output-available parts) */
  toolCall: { name: string; status: "running" | "done" | "error" } | null;
}

/**
 * Parse an AI SDK stream part into text and/or tool-call info.
 *
 * The AIChatAgent sends stream parts as JSON objects in the `body` field:
 *   {"type":"text-delta","id":"txt-0","delta":"Hello world"}
 *   {"type":"text-start","id":"txt-0"}
 *   {"type":"text-end","id":"txt-0"}
 *   {"type":"reasoning-delta","id":"reasoning-0","delta":"thinking..."}
 *   {"type":"tool-input-available","toolCallId":"...","toolName":"searchWeb","input":{...}}
 *   {"type":"tool-output-available","toolCallId":"...","output":{...}}
 *   {"type":"finish","messageMetadata":{...}}
 *
 * We extract:
 *   - Text from "text-delta" parts
 *   - Tool call status from "tool-input-available" (running) and "tool-output-available" (done)
 *
 * @see https://ai-sdk.dev/docs/ai-sdk-ui/stream-protocol
 */
function parseStreamPart(body: string): StreamPartResult {
  const result: StreamPartResult = { text: "", toolCall: null };

  try {
    const part = JSON.parse(body) as {
      type?: string;
      delta?: string;
      toolName?: string;
      toolCallId?: string;
    };

    switch (part.type) {
      case "text-delta":
        if (typeof part.delta === "string") {
          result.text = part.delta;
        }
        break;

      case "tool-input-available":
        // The agent is calling a tool — mark it as running
        if (part.toolName) {
          result.toolCall = { name: part.toolName, status: "running" };
        }
        break;

      case "tool-output-available":
        // The tool finished — mark it as done.
        // We use the toolCallId to correlate, but since we only track
        // the last tool call, we just mark it done.
        result.toolCall = { name: part.toolName ?? "tool", status: "done" };
        break;

      case "tool-error":
        result.toolCall = { name: part.toolName ?? "tool", status: "error" };
        break;
    }
  } catch {
    // Not valid JSON — check if it's the old numeric format (0:"text")
    // for backwards compatibility
    const match = body.match(/^0:"(.*)"$/s);
    if (match) {
      try {
        result.text = JSON.parse(`"${match[1]}"`);
      } catch {
        // ignore
      }
    }
  }

  return result;
}
