/**
 * ChatShell — Full-page chat interface
 *
 * Built on the Cloudflare Agents SDK patterns:
 *   - useAgent() from agents/react for WebSocket connection
 *   - useAgentChat() from @cloudflare/ai-chat/react for message protocol
 *
 * This shell works with any AIChatAgent on the server side.
 * For non-chat agents (scheduled workers), use DashboardShell instead.
 *
 * @example
 * ```tsx
 * import { ChatShell } from "@agentdeploy-io/edge-ui/chat";
 *
 * <ChatShell
 *   agent="ChatAgent"
 *   host="localhost:8787"
 *   title="Customer Support"
 * />
 * ```
 */

import React, { useState, useRef, useEffect, useCallback } from "react";
import { useAgent } from "@agentdeploy-io/agents/react";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "ai";
import type { UITheme } from "../../theme.js";
import { themeToCSSVars, DEFAULT_LIGHT_THEME } from "../../theme.js";

export interface ChatShellProps {
  /** Agent class name to connect to (must extend AIChatAgent) */
  agent: string;
  /** Agent instance name */
  name?: string;
  /** Host for the agent WebSocket connection (e.g. "localhost:8787") */
  host?: string;
  /** Whether to use wss:// (true) or ws:// (false) */
  secure?: boolean;
  /** Title shown in the header */
  title?: string;
  /** Subtitle shown in the header */
  subtitle?: string;
  /** Theme override */
  theme?: UITheme;
  /** Placeholder text for the input */
  placeholder?: string;
  /** Show connection status indicator */
  showStatus?: boolean;
  /** Greeting message shown when empty */
  greeting?: string;
  /** Throttle updates for performance (ms) */
  throttle?: number;
}

export function ChatShell({
  agent,
  name = "default",
  host,
  secure,
  title = "Agent",
  subtitle,
  theme = DEFAULT_LIGHT_THEME,
  placeholder = "Type a message...",
  showStatus = true,
  greeting,
  throttle = 100,
}: ChatShellProps) {
  const [connected, setConnected] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");

  // Step 1: Establish WebSocket connection via useAgent
  const socketAgent = useAgent({
    agent: agent as never,
    name,
    host: host as never,
    secure: secure as never,
    onOpen: useCallback(() => setConnected(true), []),
    onClose: useCallback(() => setConnected(false), []),
  } as never);

  // Step 2: Wire up useAgentChat for proper message protocol
  const {
    messages,
    sendMessage,
    stop,
    status,
    regenerate,
    error,
  } = useAgentChat({
    agent: socketAgent as never,
    experimental_throttle: throttle,
  } as never);

  const isStreaming = status === "streaming" || status === "submitted";

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages, status]);

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming) return;

    setInput("");
    sendMessage({ role: "user", parts: [{ type: "text", text }] });
  }, [input, isStreaming, sendMessage]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  // Auto-resize textarea
  const handleInputResize = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const el = e.currentTarget;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, []);

  const cssVars = themeToCSSVars(theme);

  // Extract text content from a UIMessage
  const getMessageText = (msg: UIMessage): string => {
    const textParts = msg.parts?.filter((p): p is { type: "text"; text: string } => p.type === "text");
    return textParts?.map((p) => p.text).join("") ?? "";
  };

  return (
    <div
      style={{
        ...cssVars,
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxHeight: "100dvh",
        backgroundColor: "var(--ad-bg)",
        color: "var(--ad-text)",
        fontFamily: "var(--ad-font-family)",
        fontSize: "var(--ad-font-size)",
        margin: 0,
        padding: 0,
      } as React.CSSProperties}
    >
      {/* Header */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: "12px",
          padding: "16px 20px",
          borderBottom: `1px solid var(--ad-border)`,
          backgroundColor: "var(--ad-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ flex: 1 }}>
          <h1 style={{ margin: 0, fontSize: "1.1em", fontWeight: 600 }}>{title}</h1>
          {subtitle && (
            <p style={{ margin: 0, fontSize: "0.85em", color: "var(--ad-text-muted)" }}>
              {subtitle}
            </p>
          )}
        </div>
        {showStatus && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.8em",
              color: "var(--ad-text-muted)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: connected ? "var(--ad-success)" : "var(--ad-text-muted)",
              }}
            />
            {connected ? "Online" : "Connecting..."}
          </div>
        )}
      </header>

      {/* Messages */}
      <div
        ref={scrollRef}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px 20px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
        }}
      >
        {messages.length === 0 && greeting && (
          <div
            style={{
              textAlign: "center" as const,
              padding: "40px 20px",
              color: "var(--ad-text-muted)",
              fontSize: "0.95em",
            }}
          >
            {greeting}
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.role === "user";
          const text = getMessageText(msg);
          if (!text) return null;

          return (
            <div
              key={msg.id}
              style={{
                alignSelf: isUser ? "flex-end" : "flex-start",
                maxWidth: "80%",
              }}
            >
              <div
                style={{
                  padding: "10px 14px",
                  borderRadius: `var(--ad-radius)`,
                  backgroundColor: isUser ? "var(--ad-primary)" : "var(--ad-surface)",
                  color: isUser ? "var(--ad-primary-text)" : "var(--ad-text)",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                }}
              >
                {text}
              </div>
              <div
                style={{
                  fontSize: "0.7em",
                  color: "var(--ad-text-muted)",
                  marginTop: "4px",
                  textAlign: isUser ? "right" : "left",
                }}
              >
                {msg.createdAt ? new Date(msg.createdAt as string).toLocaleTimeString() : ""}
              </div>
            </div>
          );
        })}

        {/* Streaming indicator */}
        {isStreaming && (
          <div style={{ alignSelf: "flex-start" }}>
            <div
              style={{
                padding: "10px 14px",
                borderRadius: "var(--ad-radius)",
                backgroundColor: "var(--ad-surface)",
                display: "flex",
                gap: "4px",
              }}
            >
              {[0, 1, 2].map((i) => (
                <span
                  key={i}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    backgroundColor: "var(--ad-text-muted)",
                    opacity: 0.6,
                    animation: `ad-bounce 1.4s ${i * 0.16}s infinite`,
                  }}
                />
              ))}
            </div>
          </div>
        )}

        {/* Error */}
        {error && (
          <div
            style={{
              alignSelf: "center",
              padding: "8px 16px",
              borderRadius: `var(--ad-radius)`,
              backgroundColor: "var(--ad-error)",
              color: "var(--ad-primary-text)",
              fontSize: "0.85em",
            }}
          >
            Error: {error.message}
          </div>
        )}
      </div>

      {/* Input */}
      <div
        style={{
          padding: "12px 20px",
          borderTop: `1px solid var(--ad-border)`,
          backgroundColor: "var(--ad-surface)",
          flexShrink: 0,
        }}
      >
        <div style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              handleInputResize(e);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder}
            disabled={!connected}
            rows={1}
            style={{
              flex: 1,
              padding: "10px 14px",
              border: `1px solid var(--ad-border)`,
              borderRadius: `var(--ad-radius)`,
              backgroundColor: "var(--ad-bg)",
              color: "var(--ad-text)",
              fontFamily: "var(--ad-font-family)",
              fontSize: "var(--ad-font-size)",
              outline: "none",
              resize: "none",
              maxHeight: "160px",
              opacity: connected ? 1 : 0.5,
            }}
          />
          {isStreaming ? (
            <button
              onClick={stop}
              style={{
                padding: "10px 20px",
                border: "none",
                borderRadius: `var(--ad-radius)`,
                backgroundColor: "var(--ad-error)",
                color: "var(--ad-primary-text)",
                cursor: "pointer",
                fontWeight: 500,
              }}
            >
              Stop
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!input.trim() || !connected}
              style={{
                padding: "10px 20px",
                border: "none",
                borderRadius: `var(--ad-radius)`,
                backgroundColor: "var(--ad-primary)",
                color: "var(--ad-primary-text)",
                cursor: input.trim() && connected ? "pointer" : "not-allowed",
                opacity: input.trim() && connected ? 1 : 0.5,
                fontWeight: 500,
              }}
            >
              Send
            </button>
          )}
        </div>
      </div>

      <style>{`
        @keyframes ad-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-6px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
