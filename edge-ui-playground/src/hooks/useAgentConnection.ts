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
import type { AgentConnectionStatus } from "../types/agent";
import type { ChatMessage } from "../types/agent";

// ─── Types ───────────────────────────────────────────────────────

export interface UseAgentConnectionResult {
  status: AgentConnectionStatus;
  messages: ChatMessage[];
  lastError: string | null;
  sendMessage: (text: string) => boolean;
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

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectAttemptsRef = useRef(0);
  const isManualCloseRef = useRef(false);
  const agentIdRef = useRef<string | null>(null);
  // Track previous status to detect meaningful transitions for notifications
  const prevStatusRef = useRef<AgentConnectionStatus>("disconnected");
  const hadConnectedBeforeRef = useRef(false);

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

  // ─── Send Message ─────────────────────────────────────────────

  const sendMessage = useCallback(
    (text: string): boolean => {
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

      // Add user message to local state immediately (optimistic)
      const userMessage: ChatMessage = {
        id: userMessageId,
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      };

      // Build the messages array for the AIChatAgent protocol.
      // The AIChatAgent expects Vercel AI SDK UIMessage format:
      //   { id, role, parts: [{ type: "text", text }] }
      // We send the full conversation so the agent has context.
      setMessages((prev) => {
        const allMessages = [...prev, userMessage];

        // Build UIMessage array from our simplified format
        const uiMessages = allMessages.map((m) => ({
          id: m.id,
          role: m.role,
          parts: [{ type: "text", text: m.content }],
        }));

        // Send using the cf_agent_use_chat_request protocol
        try {
          const payload = {
            type: "cf_agent_use_chat_request",
            id: requestId,
            init: {
              method: "POST",
              body: JSON.stringify({
                messages: uiMessages,
              }),
            },
          };
          wsRef.current!.send(JSON.stringify(payload));
        } catch (error) {
          const appError = new AppError(ErrorCode.WS_MESSAGE_SEND_FAILED, {
            context: { agentId: agent?.id },
            cause: error,
          });
          errorHandler.handleError(appError, { agentId: agent?.id });
        }

        return allMessages.slice(-DEFAULT_AGENT_CONFIG.messageHistoryLimit);
      });

      return true;
    },
    [agent],
  );

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

  return {
    status,
    messages,
    lastError,
    sendMessage,
    reconnect,
    disconnect,
    reconnectAttempts,
    agentState,
    agentIdentity,
    lastToolCall,
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
