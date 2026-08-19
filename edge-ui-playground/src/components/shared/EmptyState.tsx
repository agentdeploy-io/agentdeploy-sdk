/**
 * EmptyState Component
 * ────────────────────
 * Displays a friendly empty state when there's no data to show.
 * Used in tables, lists, and views when data hasn't loaded or
 * doesn't exist yet.
 *
 * Props match EmptyStateConfig type from types/ui.ts
 */

import React from "react";
import { COLORS } from "../../constants/theme";
import { Button } from "../ui/Button";
import type { EmptyStateConfig } from "../../types/ui";

export interface EmptyStateProps extends EmptyStateConfig {
  /** Override the default button variant */
  actionVariant?: "primary" | "secondary" | "outline";
  style?: React.CSSProperties;
}

export const EmptyState: React.FC<EmptyStateProps> = React.memo(
  ({ icon, title, message, action, actionVariant = "primary", style }) => (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "48px 24px",
        gap: "12px",
        textAlign: "center",
        ...style,
      }}
    >
      <span style={{ fontSize: "2.5rem", lineHeight: 1 }}>{icon}</span>
      <h3 style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground }}>{title}</h3>
      <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, maxWidth: "360px" }}>
        {message}
      </p>
      {action && (
        <Button variant={actionVariant} size="sm" onClick={action.onClick} style={{ marginTop: "8px" }}>
          {action.label}
        </Button>
      )}
    </div>
  ),
);

EmptyState.displayName = "EmptyState";
