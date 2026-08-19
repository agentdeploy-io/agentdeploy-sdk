/**
 * Badge Component
 * ────────────────
 * Status indicator pill. Supports 5 variants:
 *   success: Green bg/text — for healthy/active states
 *   warning: Amber bg/text — for degraded/pending states
 *   error: Red bg/text — for failed/error states
 *   info: Blue bg/text — for informational states
 *   neutral: Gray bg/text — for default/unknown states
 *
 * Design spec: cornerRadius:16, padding:[4,12], fontSize:12, fontWeight:500
 *
 * Also supports a leading dot indicator for live status.
 */

import React from "react";
import { COMPONENT_SPEC, STATUS_COLORS, COLORS } from "../../constants/theme";
import type { BadgeVariant } from "../../constants/theme";

// ─── Props ───────────────────────────────────────────────────────

export interface BadgeProps {
  variant?: BadgeVariant;
  /** Show a pulsing dot before the label */
  dot?: boolean;
  /** Custom label text */
  children: React.ReactNode;
  /** Optional click handler (makes it interactive) */
  onClick?: () => void;
  /** Uppercase the text */
  uppercase?: boolean;
  style?: React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────────

export const Badge: React.FC<BadgeProps> = React.memo(
  ({ variant = "neutral", dot = false, children, onClick, uppercase = false, style }) => {
    const styles = variantStyles[variant];

    return (
      <span
        onClick={onClick}
        role={onClick ? "button" : undefined}
        tabIndex={onClick ? 0 : undefined}
        style={{
          ...baseStyle,
          ...styles,
          ...(uppercase ? { textTransform: "uppercase", letterSpacing: "0.04em" } : {}),
          ...(onClick ? { cursor: "pointer" } : {}),
          ...style,
        }}
      >
        {dot && <span style={{ ...dotBaseStyle, backgroundColor: styles.color }} className="pulse" />}
        {children}
      </span>
    );
  },
);

Badge.displayName = "Badge";

// ─── Styles ──────────────────────────────────────────────────────

const baseStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: "6px",
  padding: `${COMPONENT_SPEC.badge.paddingY} ${COMPONENT_SPEC.badge.paddingX}`,
  fontSize: COMPONENT_SPEC.badge.fontSize,
  fontWeight: COMPONENT_SPEC.badge.fontWeight,
  lineHeight: "1.2",
  borderRadius: COMPONENT_SPEC.badge.borderRadius,
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const variantStyles: Record<BadgeVariant, React.CSSProperties> = {
  success: {
    backgroundColor: STATUS_COLORS.successBg,
    color: STATUS_COLORS.success,
  },
  warning: {
    backgroundColor: STATUS_COLORS.warningBg,
    color: STATUS_COLORS.warning,
  },
  error: {
    backgroundColor: STATUS_COLORS.errorBg,
    color: STATUS_COLORS.error,
  },
  info: {
    backgroundColor: STATUS_COLORS.infoBg,
    color: STATUS_COLORS.info,
  },
  neutral: {
    backgroundColor: COLORS.secondary,
    color: COLORS.mutedForeground,
  },
};

const dotBaseStyle: React.CSSProperties = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  flexShrink: 0,
};
