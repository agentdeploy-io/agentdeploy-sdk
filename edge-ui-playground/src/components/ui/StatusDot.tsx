/**
 * StatusDot Component
 * ───────────────────
 * Small colored dot for indicating connection/health status.
 * Supports pulsing animation for live states.
 *
 * Variants match Badge variants: success, warning, error, info, neutral
 */

import React from "react";
import { STATUS_COLORS, COLORS } from "../../constants/theme";
import type { BadgeVariant } from "../../constants/theme";

export interface StatusDotProps {
  variant?: BadgeVariant;
  size?: number;
  pulse?: boolean;
  label?: string;
  showLabel?: boolean;
}

const variantColors: Record<BadgeVariant, string> = {
  success: STATUS_COLORS.success,
  warning: STATUS_COLORS.warning,
  error: STATUS_COLORS.error,
  info: STATUS_COLORS.info,
  neutral: COLORS.borderStrong,
};

export const StatusDot: React.FC<StatusDotProps> = React.memo(
  ({ variant = "neutral", size = 8, pulse = false, label, showLabel = false }) => {
    const color = variantColors[variant];

    return (
      <span
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
        }}
      >
        <span
          style={{
            width: `${size}px`,
            height: `${size}px`,
            borderRadius: "50%",
            backgroundColor: color,
            flexShrink: 0,
            boxShadow: `0 0 0 2px ${COLORS.card}`,
          }}
          className={pulse ? "pulse" : undefined}
        />
        {showLabel && label && (
          <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontWeight: 500 }}>
            {label}
          </span>
        )}
      </span>
    );
  },
);

StatusDot.displayName = "StatusDot";
