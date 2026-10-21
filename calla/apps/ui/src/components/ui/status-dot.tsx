import { cn } from "@/lib/utils";
import type { AgentStatus } from "@calla/shared";

const STATUS_STYLE: Record<AgentStatus | "unknown", string> = {
  running: "bg-success",
  idle: "bg-info",
  awaiting_approval: "bg-warning animate-pulse-dot",
  error: "bg-destructive",
  offline: "bg-muted-foreground/40",
  unknown: "bg-muted-foreground/40",
};

const STATUS_LABEL: Record<AgentStatus | "unknown", string> = {
  running: "Running",
  idle: "Idle",
  awaiting_approval: "Awaiting approval",
  error: "Error",
  offline: "Offline",
  unknown: "Unknown",
};

export interface StatusDotProps {
  status: AgentStatus | "unknown";
  className?: string;
  withLabel?: boolean;
  title?: string;
}

export function StatusDot({ status, className, withLabel, title }: StatusDotProps) {
  const dot = (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", STATUS_STYLE[status], className)}
      title={title ?? STATUS_LABEL[status]}
      aria-label={STATUS_LABEL[status]}
    />
  );
  if (!withLabel) return dot;
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      {dot}
      {STATUS_LABEL[status]}
    </span>
  );
}
