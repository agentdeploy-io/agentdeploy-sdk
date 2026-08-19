/**
 * LoadingState Component
 * ──────────────────────
 * Displays skeleton rows or a spinner while data is loading.
 * Provides visual feedback that content is being fetched.
 *
 * Variants:
 *   - "spinner": Centered spinner with optional message
 *   - "skeleton": Animated skeleton rows (for tables/lists)
 *   - "card": Skeleton card placeholder
 */

import React from "react";
import { COLORS } from "../../constants/theme";

export interface LoadingStateProps {
  variant?: "spinner" | "skeleton" | "card";
  message?: string;
  rows?: number;
  height?: string;
  style?: React.CSSProperties;
}

export const LoadingState: React.FC<LoadingStateProps> = React.memo(
  ({ variant = "spinner", message, rows = 3, height, style }) => {
    // ─── Spinner ─────────────────────────────────────────────────
    if (variant === "spinner") {
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            padding: "48px 24px",
            gap: "16px",
            minHeight: height ?? "200px",
            ...style,
          }}
        >
          <span
            className="spin"
            style={{
              width: "32px",
              height: "32px",
              borderRadius: "50%",
              border: `3px solid ${COLORS.border}`,
              borderTopColor: COLORS.primary,
              display: "block",
            }}
          />
          {message && (
            <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>{message}</span>
          )}
        </div>
      );
    }

    // ─── Skeleton Rows ──────────────────────────────────────────
    if (variant === "skeleton") {
      return (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px", padding: "16px 0", ...style }}>
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              className="skeleton"
              style={{ height: "16px", width: `${100 - i * 5}%` }}
            />
          ))}
        </div>
      );
    }

    // ─── Skeleton Card ──────────────────────────────────────────
    return (
      <div
        style={{
          borderRadius: "12px",
          border: `1px solid ${COLORS.border}`,
          padding: "20px",
          ...style,
        }}
      >
        <div className="skeleton" style={{ height: "16px", width: "40%", marginBottom: "12px" }} />
        <div className="skeleton" style={{ height: "32px", width: "60%", marginBottom: "8px" }} />
        <div className="skeleton" style={{ height: "12px", width: "30%" }} />
      </div>
    );
  },
);

LoadingState.displayName = "LoadingState";
