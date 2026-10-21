/**
 * ToolCallIndicator
 * ─────────────────
 * Small muted row above the chat input reflecting the last tool call
 * observed in the agent stream:
 *   running → spinner + "Calling {name}…"
 *   done    → check  + "{name} completed"
 *   error   → x      + "{name} failed"
 *
 * Tailwind rebuild of the playground AgentChatTab tool-call chip.
 */

import React from "react";
import { Check, Loader2, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface ToolCallInfo {
  name: string;
  status: "running" | "done" | "error";
}

export interface ToolCallIndicatorProps {
  toolCall: ToolCallInfo | null;
  className?: string;
}

export const ToolCallIndicator: React.FC<ToolCallIndicatorProps> = ({
  toolCall,
  className,
}) => {
  if (!toolCall) return null;

  const icon =
    toolCall.status === "running" ? (
      <Loader2 className="size-3 shrink-0 animate-spin text-info" aria-hidden />
    ) : toolCall.status === "done" ? (
      <Check className="size-3 shrink-0 text-success" aria-hidden />
    ) : (
      <X className="size-3 shrink-0 text-destructive" aria-hidden />
    );

  const label =
    toolCall.status === "running"
      ? `Calling ${toolCall.name}…`
      : toolCall.status === "done"
        ? `${toolCall.name} completed`
        : `${toolCall.name} failed`;

  return (
    <div
      role="status"
      className={cn(
        "inline-flex w-fit max-w-full items-center gap-1.5 rounded-md border border-border bg-surface-canvas px-2 py-1 text-xs text-muted-foreground",
        className,
      )}
    >
      {icon}
      <span className="truncate">
        {label.split(toolCall.name)[0]}
        <span className="font-mono text-foreground/80">{toolCall.name}</span>
        {label.split(toolCall.name)[1]}
      </span>
    </div>
  );
};

ToolCallIndicator.displayName = "ToolCallIndicator";
