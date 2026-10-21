/**
 * EmptyState Component
 * ────────────────────
 * Displays a friendly empty state when there's no data to show.
 * Used in tables, lists, and views when data hasn't loaded or
 * doesn't exist yet.
 *
 * Tailwind rewrite of the playground shared/EmptyState — icon + title +
 * description + optional action button.
 */

import React from "react";
import { Button } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  /** Emoji or lucide node rendered above the title */
  icon: React.ReactNode;
  title: string;
  /** Description text under the title */
  message?: string;
  /** Optional call-to-action */
  action?: {
    label: string;
    onClick: () => void;
  };
  /** Button variant for the action */
  actionVariant?: "default" | "secondary" | "outline" | "ghost";
  className?: string;
}

export const EmptyState: React.FC<EmptyStateProps> = React.memo(
  ({ icon, title, message, action, actionVariant = "default", className }) => (
    <div
      className={cn(
        "flex flex-col items-center justify-center gap-3 px-6 py-12 text-center",
        className,
      )}
    >
      <span className="text-4xl leading-none" aria-hidden>
        {icon}
      </span>
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      {message && (
        <p className="max-w-[360px] text-[0.8125rem] text-muted-foreground">{message}</p>
      )}
      {action && (
        <Button variant={actionVariant} size="sm" onClick={action.onClick} className="mt-2">
          {action.label}
        </Button>
      )}
    </div>
  ),
);

EmptyState.displayName = "EmptyState";
