/**
 * useAgentConnection Hook
 * ────────────────────────
 * Manages WebSocket connection lifecycle for a single agent.
 *
 * Features:
 *   - Auto-connect with exponential backoff reconnect
 *   - Max reconnect attempts (configurable)
 *   - Connection status tracking (connecting → connected → disconnected/error)
 *   - Message send/receive
 *   - Graceful degradation (component still renders without connection)
 *   - Cleanup on unmount
 *
 * Usage:
 *   const { status, sendMessage, lastMessage, reconnect } = useAgentConnection(agent)
 */

import { useState, useEffect, useCallback, useRef } from "react";
import {
  type AgentRegistryEntry,
  buildAgentWsUrl,
  DEFAULT_AGENT_CONFIG,
  AGENT_STATUS_LABELS,
} from "../constants/agents";
import { errorHandler } from "../errors/errorHandler";
import { AppError, AppErrors } from "../errors/AppError";
import { ErrorCode } from "../constants/errors";
import { toast } from "./useToast";
import { buildAuthedWsUrl } from "./useAuthFetch";
import type { AgentConnectionStatus, ChatAttachment, ChatMessage } from "../types/agent";

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

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualCloseRef = useRef(false);
  const agentIdRef = useRef<string | null>(null);
  // Track previous status to detect meaningful transitions for notifications
  const prevStatusRef = useRef<AgentConnectionStatus>("disconnected");
  const hadConnectedBeforeRef = useRef(false);
  // Id of the in-flight chat request (null when idle) — used to target
  // stop-generation at the exact request the agent is generating.
  const activeRequestIdRef = useRef<string | null>(null);

  // ─── Cleanup ──────────────────────────────────────────────────

  const cleanup = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    if (wsRef.current) {
      isManualCloseRef.current = true;
      wsRef.current.onopen = null;
      wsRef.current.onmessage = null;
      wsRef.current.onerror = null;
      wsRef.current.onclose = null;
      try {
        wsRef.current.close();
      } catch {
        // ignore close errors
      }
      wsRef.current = null;
    }
  }, []);

  // ─── Connect ──────────────────────────────────────────────────

  const connect = useCallback(() => {
    if (!agent) return;

    // Reset manual close flag
    isManualCloseRef.current = false;
    agentIdRef.current = agent.id;

    // Clean up existing connection
    cleanup();

    setStatus("connecting");

    let ws: WebSocket;
    try {
      const baseUrl = buildAgentWsUrl(agent);
      const url = buildAuthedWsUrl(baseUrl);
      ws = new WebSocket(url);
    } catch (error) {
      const appError = AppErrors.connectionFailed(agent.id, error);
      errorHandler.handleError(appError, { agentId: agent.id });
      setStatus("error");
      setLastError(appError.message);
      return;
    }

    wsRef.current = ws;

    // ─── On Open ────────────────────────────────────────────────

    ws.onopen = () => {
      const wasReconnecting = hadConnectedBeforeRef.current;
      reconnectAttemptsRef.current = 0;
      setReconnectAttempts(0);
      setStatus("connected");
      setLastError(null);
      hadConnectedBeforeRef.current = true;

      // Notify on reconnect (not on initial connect — that's expected)
      if (wasReconnecting) {
        toast.success(
          "Reconnected",
          `${agent.name} is back online.`,
        );
      }
    };

    // ─── On Message ─────────────────────────────────────────────

    ws.onmessage = (event: MessageEvent) => {
      try {
        const raw = event.data as string;
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
          const raw = Array.isArray(data.commands) ? data.commands : [];
          setCommands(
            (raw as Array<Record<string, unknown>>)
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
    };

    // ─── On Error ───────────────────────────────────────────────

    ws.onerror = () => {
      // The error event itself is not very descriptive.
      // The close event will follow and handle reconnection.
      setStatus("error");
    };

    // ─── On Close ───────────────────────────────────────────────

    ws.onclose = (event: CloseEvent) => {
      if (isManualCloseRef.current) {
        setStatus("disconnected");
        return;
      }

      // Unexpected close — attempt reconnect
      setStatus("disconnected");

      if (!DEFAULT_AGENT_CONFIG.autoReconnect) return;

      reconnectAttemptsRef.current += 1;
      setReconnectAttempts(reconnectAttemptsRef.current);

      if (reconnectAttemptsRef.current > DEFAULT_AGENT_CONFIG.maxReconnectAttempts) {
        const appError = AppErrors.reconnectExhausted(agent.id, reconnectAttemptsRef.current);
        errorHandler.handleError(appError, { agentId: agent.id });
        setStatus("error");
        setLastError(appError.message);
        return;
      }

      // Exponential backoff
      const delay =
        DEFAULT_AGENT_CONFIG.reconnectBaseDelay *
        Math.pow(2, reconnectAttemptsRef.current - 1);

      reconnectTimerRef.current = setTimeout(() => {
        if (agentIdRef.current === agent.id) {
          connect();
        }
      }, delay);
    };
  }, [agent, cleanup]);

  // ─── Clear Chat (buyer "Clear conversation" control) ──────────
  // Wipes the persisted server-side history (cf_agent_use_chat_reset) so the
  // next reconnect replays nothing, and clears the local pane immediately.
  const clearChat = useCallback((): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;
    try {
      wsRef.current.send(JSON.stringify({ type: "cf_agent_use_chat_reset" }));
    } catch {
      // Socket died mid-send — the pane is still cleared locally.
    }
    setMessages([]);
    return true;
  }, []);

  // ─── Stop Generation (abort the in-flight reply) ───────────────
  // Sends cf_agent_chat_request_cancel for the active request. The agent
  // aborts the upstream LLM call and replies with a finish frame; we also
  // finalize the streaming bubble locally for immediate feedback.
  const stopChat = useCallback((): boolean => {
    const ws = wsRef.current;
    const requestId = activeRequestIdRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN || !requestId) return false;
    try {
      ws.send(JSON.stringify({ type: "cf_agent_chat_request_cancel", id: requestId }));
    } catch {
      // Socket died mid-send — still finalize locally below.
    }
    activeRequestIdRef.current = null;
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
    return true;
  }, []);

  // ─── Send Message ─────────────────────────────────────────────

  /** Transmit a chat request (shared by send + regenerate). */
  const sendRequest = useCallback(
    (
      requestId: string,
      uiMessages: Array<{ id: string; role: string; parts: unknown[] }>,
    ): void => {
      try {
        wsRef.current!.send(
          JSON.stringify({
            type: "cf_agent_use_chat_request",
            id: requestId,
            init: {
              method: "POST",
              body: JSON.stringify({ messages: uiMessages }),
            },
          }),
        );
      } catch (error) {
        const appError = new AppError(ErrorCode.WS_MESSAGE_SEND_FAILED, {
          context: { agentId: agent?.id },
          cause: error,
        });
        errorHandler.handleError(appError, { agentId: agent?.id });
      }
    },
    [agent],
  );

  const sendMessage = useCallback(
    (text: string, attachments?: ChatAttachment[]): boolean => {
      if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
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
      // We send the full conversation so the agent has context.
      setMessages((prev) => {
        const allMessages = [...prev, userMessage];

        // Build UIMessage array from our simplified format. File parts ride
        // on the NEW message only — earlier turns already had their
        // attachments inlined server-side (signed URLs expire).
        const uiMessages = allMessages.map((m, i) => {
          const parts: unknown[] = [{ type: "text", text: m.content }];
          if (i === allMessages.length - 1 && attachments && attachments.length > 0) {
            for (const a of attachments) {
              parts.push({ type: "file", url: a.url, name: a.name, mimeType: a.mimeType, size: a.sizeBytes });
            }
          }
          return { id: m.id, role: m.role, parts };
        });

        sendRequest(requestId, uiMessages);
        return allMessages.slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit);
      });

      return true;
    },
    [agent, sendRequest],
  );

  // ─── Regenerate (re-run the last user turn) ────────────────────
  // Drops the trailing assistant reply(s) after the last user message and
  // resends that user message. Attachments from the original turn are not
  // re-sent (their signed URLs may have expired) — the text stands alone.
  const regenerate = useCallback((): boolean => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) return false;
    let lastUserIndex = -1;
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      if (messages[i]!.role === "user") { lastUserIndex = i; break; }
    }
    if (lastUserIndex < 0) return false;
    const lastUser = messages[lastUserIndex]!;
    const kept = messages.slice(0, lastUserIndex + 1);
    const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    activeRequestIdRef.current = requestId;
    const uiMessages = kept.map((m) => ({
      id: m.id,
      role: m.role,
      parts: [{ type: "text", text: m.content }],
    }));
    sendRequest(requestId, uiMessages);
    setMessages(kept.slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit));
    return true;
  }, [messages, sendRequest]);

  // ─── Reconnect (manual trigger) ───────────────────────────────

  const reconnect = useCallback(() => {
    reconnectAttemptsRef.current = 0;
    setReconnectAttempts(0);
    connect();
  }, [connect]);

  // ─── Disconnect (manual trigger) ──────────────────────────────

  const disconnect = useCallback(() => {
    cleanup();
    setStatus("disconnected");
  }, [cleanup]);

  // ─── Auto-connect on mount ────────────────────────────────────

  useEffect(() => {
    if (agent) {
      connect();
    }

    return cleanup;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent?.id]);

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
