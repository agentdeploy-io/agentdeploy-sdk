/**
 * @agentdeploy-io/agents/react — React bindings for AgentDeploy Agents
 *
 * Re-exports the upstream `useAgent` and `useAgentToolEvents` hooks
 * from the Cloudflare Agents SDK.
 *
 * Additionally provides `useAgentStatus` — a convenience hook that
 * tracks WebSocket connection lifecycle for UI rendering.
 */

// Re-export upstream hooks — full compatibility
export { useAgent, useAgentToolEvents } from "agents/react";
export { _testUtils } from "agents/react";

// ── Enhanced hooks ────────────────────────────────────────────────────────────

import { useAgent } from "agents/react";
import { useState, useCallback, useRef } from "react";

export type AgentConnectionStatus =
  | "idle"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error"
  | "closed";

export interface UseAgentStatusOptions {
  onStatusChange?: (status: AgentConnectionStatus, previous: AgentConnectionStatus) => void;
}

export interface UseAgentStatusResult {
  status: AgentConnectionStatus;
  connected: boolean;
  identified: boolean;
  error: Error | null;
}

/**
 * Wraps `useAgent` to provide a simple connection status enum.
 *
 * Returns a tuple: [statusInfo, agent] so consumers get both the
 * status tracking and the full agent object without type conflicts.
 *
 * @example
 * ```tsx
 * import { useAgentStatus } from "@agentdeploy-io/agents/react";
 *
 * function ChatUI() {
 *   const [{ status, connected, error }, agent] = useAgentStatus({
 *     agent: "support",
 *     name: "session-1",
 *   });
 *
 *   if (status === "connecting") return <Spinner />;
 *   if (status === "error") return <ErrorBanner error={error} />;
 *   return <ChatInterface agent={agent} />;
 * }
 * ```
 */
export function useAgentStatus(
  options: Record<string, unknown> & UseAgentStatusOptions,
): [UseAgentStatusResult, ReturnType<typeof useAgent>] {
  const [status, setStatus] = useState<AgentConnectionStatus>("idle");
  const prevStatusRef = useRef<AgentConnectionStatus>("idle");
  const onStatusChangeRef = useRef(options.onStatusChange);
  onStatusChangeRef.current = options.onStatusChange;

  const handleStatusChange = useCallback((next: AgentConnectionStatus) => {
    const prev = prevStatusRef.current;
    if (prev !== next) {
      prevStatusRef.current = next;
      setStatus(next);
      onStatusChangeRef.current?.(next, prev);
    }
  }, []);

  // Strip our custom option
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { onStatusChange, ...agentOptions } = options;

  const userOnOpen = agentOptions.onOpen as ((...args: unknown[]) => void) | undefined;
  const userOnClose = agentOptions.onClose as ((event: CloseEvent) => void) | undefined;
  const userOnConnectionError = agentOptions.onConnectionError as ((error: Error) => void) | undefined;

  const agent = useAgent({
    ...agentOptions,
    onOpen: (...args: unknown[]) => {
      handleStatusChange("connected");
      userOnOpen?.(...args);
    },
    onClose: (event: CloseEvent) => {
      const target = event?.target as { shouldReconnect?: boolean } | null;
      handleStatusChange(target?.shouldReconnect ? "reconnecting" : "closed");
      userOnClose?.(event);
    },
    onConnectionError: (error: Error) => {
      handleStatusChange("error");
      userOnConnectionError?.(error);
    },
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);

  return [
    {
      status,
      connected: status === "connected",
      identified: !!agent?.identified,
      error: (agent as { connectionError?: Error | null })?.connectionError ?? null,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    agent as any,
  ];
}
