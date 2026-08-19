/**
 * Button Component
 * ────────────────
 * Primary interactive element. Supports 5 variants matching the
 * edge.pen design system spec:
 *   - primary: Solid blue (#2563EB) with white text
 *   - secondary: Zinc-100 fill with dark text
 *   - outline: Transparent with border
 *   - ghost: Transparent, no border (hover reveals bg)
 *   - destructive: Red (#DC2626) with white text
 *
 * Design spec: cornerRadius:8, padding:[10,16], fontSize:14, fontWeight:500, gap:8
 *
 * Features:
 *   - Loading state with spinner (disables interaction)
 *   - Left/right icon slots
 *   - Icon-only mode (square button)
 *   - Full width option
 *   - Proper a11y (aria-busy, aria-disabled, focus-visible)
 */

import React from "react";
import { COMPONENT_SPEC, COLORS, TRANSITIONS } from "../../constants/theme";
import type { ButtonVariant } from "../../constants/theme";

// ─── Props ───────────────────────────────────────────────────────

export interface ButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "type"> {
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg" | "icon";
  loading?: boolean;
  fullWidth?: boolean;
  leftIcon?: React.ReactNode;
  rightIcon?: React.ReactNode;
  children?: React.ReactNode;
  /** Override default type="button" */
  type?: "button" | "submit" | "reset";
}

// ─── Component ───────────────────────────────────────────────────

export const Button: React.FC<ButtonProps> = React.memo(
  ({
    variant = "primary",
    size = "md",
    loading = false,
    fullWidth = false,
    leftIcon,
    rightIcon,
    children,
    disabled,
    type = "button",
    style,
    ...rest
  }) => {
    const isDisabled = disabled || loading;

    return (
      <button
        type={type}
        disabled={isDisabled}
        aria-busy={loading}
        aria-disabled={isDisabled}
        style={{
          ...baseStyles,
          ...variantStyles[variant],
          ...sizeStyles[size],
          ...(fullWidth ? { width: "100%" } : {}),
          ...(isDisabled ? disabledStyles : {}),
          ...style,
        }}
        {...rest}
      >
        {/* Loading spinner */}
        {loading && <span style={spinnerStyle} className="spin" aria-hidden />}

        {/* Left icon (hidden when loading to avoid double icons) */}
        {!loading && leftIcon && <span style={iconStyle}>{leftIcon}</span>}

        {/* Content */}
        {children && <span>{children}</span>}

        {/* Right icon */}
        {!loading && rightIcon && <span style={iconStyle}>{rightIcon}</span>}
      </button>
    );
  },
);

Button.displayName = "Button";

// ─── Styles ──────────────────────────────────────────────────────

const baseStyles: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: COMPONENT_SPEC.button.gap,
  fontFamily: "var(--font-sans)",
  fontSize: COMPONENT_SPEC.button.fontSize,
  fontWeight: COMPONENT_SPEC.button.fontWeight,
  lineHeight: "1",
  borderRadius: COMPONENT_SPEC.button.borderRadius,
  border: "1px solid transparent",
  cursor: "pointer",
  transition: `background-color ${TRANSITIONS.fast}, color ${TRANSITIONS.fast}, border-color ${TRANSITIONS.fast}, box-shadow ${TRANSITIONS.fast}`,
  userSelect: "none",
  whiteSpace: "nowrap",
  verticalAlign: "middle",
};

const variantStyles: Record<ButtonVariant, React.CSSProperties> = {
  primary: {
    backgroundColor: COLORS.primary,
    color: COLORS.primaryForeground,
    borderColor: COLORS.primary,
  },
  secondary: {
    backgroundColor: COLORS.secondary,
    color: COLORS.secondaryForeground,
    borderColor: "transparent",
  },
  outline: {
    backgroundColor: "transparent",
    color: COLORS.foreground,
    borderColor: COLORS.border,
  },
  ghost: {
    backgroundColor: "transparent",
    color: COLORS.foreground,
    borderColor: "transparent",
  },
  destructive: {
    backgroundColor: COLORS.destructive,
    color: COLORS.destructiveForeground,
    borderColor: COLORS.destructive,
  },
};

const sizeStyles: Record<string, React.CSSProperties> = {
  sm: { height: "32px", padding: "0 12px", fontSize: "0.8125rem" },
  md: {
    height: COMPONENT_SPEC.button.height,
    padding: `${COMPONENT_SPEC.button.paddingY} ${COMPONENT_SPEC.button.paddingX}`,
  },
  lg: { height: "44px", padding: "0 20px", fontSize: "0.9375rem" },
  icon: {
    height: COMPONENT_SPEC.button.height,
    width: COMPONENT_SPEC.button.height,
    padding: "0",
  },
};

const disabledStyles: React.CSSProperties = {
  opacity: 0.5,
  cursor: "not-allowed",
  pointerEvents: "none",
};

const iconStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  flexShrink: 0,
};

const spinnerStyle: React.CSSProperties = {
  width: "16px",
  height: "16px",
  borderRadius: "50%",
  border: "2px solid currentColor",
  borderTopColor: "transparent",
  flexShrink: 0,
};
