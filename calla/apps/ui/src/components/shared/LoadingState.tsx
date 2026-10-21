/**
 * LoadingState Component
 * ──────────────────────
 * Displays skeleton rows or a spinner while data is loading.
 * Provides visual feedback that content is being fetched.
 *
 * Tailwind rewrite of the playground shared/LoadingState.
 *
 * Variants:
 *   - "spinner": Centered spinner with optional message
 *   - "skeleton": Animated skeleton rows (for tables/lists)
 *   - "card": Skeleton card placeholder
 */

import React from "react";
import { Skeleton } from "@/components/ui";
import { cn } from "@/lib/utils";

export interface LoadingStateProps {
  variant?: "spinner" | "skeleton" | "card";
  message?: string;
  rows?: number;
  /** Min height for the spinner variant (Tailwind class or arbitrary value) */
  className?: string;
}

export const LoadingState: React.FC<LoadingStateProps> = React.memo(
  ({ variant = "spinner", message, rows = 3, className }) => {
    // ─── Spinner ─────────────────────────────────────────────────
    if (variant === "spinner") {
      return (
        <div
          className={cn(
            "flex min-h-[200px] flex-col items-center justify-center gap-4 px-6 py-12",
            className,
          )}
          role="status"
        >
          <span className="size-8 animate-spin rounded-full border-[3px] border-border border-t-primary" />
          {message && <span className="text-[0.8125rem] text-muted-foreground">{message}</span>}
        </div>
      );
    }

    // ─── Skeleton Rows ──────────────────────────────────────────
    if (variant === "skeleton") {
      return (
        <div className={cn("flex flex-col gap-3 py-4", className)}>
          {Array.from({ length: rows }).map((_, i) => (
            <Skeleton
              key={i}
              className="h-4"
              style={{ width: `${100 - i * 5}%` }}
            />
          ))}
        </div>
      );
    }

    // ─── Skeleton Card ──────────────────────────────────────────
    return (
      <div className={cn("rounded-xl border border-border p-5", className)}>
        <Skeleton className="mb-3 h-4 w-[40%]" />
        <Skeleton className="mb-2 h-8 w-[60%]" />
        <Skeleton className="h-3 w-[30%]" />
      </div>
    );
  },
);

LoadingState.displayName = "LoadingState";
