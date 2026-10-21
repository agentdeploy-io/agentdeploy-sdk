/**
 * ConnectionBanner
 * ────────────────
 * Warning/destructive strip shown above the transcript whenever the agent
 * WebSocket is not connected (connecting / disconnected / error), with the
 * backoff attempt count and a manual Reconnect action.
 *
 * Tailwind rebuild of the playground AgentChatTab connection banner.
 */

import React, { useMemo } from "react";
import { AlertTriangle, Loader2, PlugZap, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import type { AgentConnectionStatus } from "@/types/agent";

export interface ConnectionBannerProps {
  status: AgentConnectionStatus;
  /** Current backoff attempt count (> 0 while auto-reconnecting). */
  reconnectAttempts?: number;
  lastError?: string | null;
  onReconnect?: () => void;
  className?: string;
}

export const ConnectionBanner: React.FC<ConnectionBannerProps> = ({
  status,
  reconnectAttempts = 0,
  lastError,
  onReconnect,
  className,
}) => {
  const config = useMemo(() => {
    switch (status) {
      case "error":
        return {
          tone: "destructive" as const,
          icon: <AlertTriangle className="size-3.5 shrink-0" aria-hidden />,
          message: lastError ?? "Connection failed. The agent may be offline.",
        };
      case "connecting":
        return {
          tone: "warning" as const,
          icon: <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />,
          message:
            reconnectAttempts > 0
              ? `Reconnecting… (attempt ${reconnectAttempts})`
              : "Establishing connection…",
        };
      case "disconnected":
        return {
          tone: "warning" as const,
          icon: <RefreshCw className="size-3.5 shrink-0" aria-hidden />,
          message:
            reconnectAttempts > 0
              ? `Disconnected — retrying (attempt ${reconnectAttempts})`
              : "Disconnected from agent.",
        };
      default:
        return null;
    }
  }, [status, reconnectAttempts, lastError]);

  if (!config) return null;

  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b px-4 py-1.5 text-xs",
        config.tone === "destructive"
          ? "border-destructive/30 bg-destructive/10 text-destructive"
          : "border-warning/30 bg-warning/10 text-warning",
        className,
      )}
    >
      {config.icon}
      <span className="min-w-0 flex-1 truncate">{config.message}</span>
      {status !== "connecting" && onReconnect && (
        <Button
          variant="outline"
          size="sm"
          className="h-6 gap-1 px-2 text-[0.6875rem]"
          onClick={onReconnect}
        >
          <PlugZap className="size-3" />
          Reconnect
        </Button>
      )}
    </div>
  );
};

ConnectionBanner.displayName = "ConnectionBanner";
