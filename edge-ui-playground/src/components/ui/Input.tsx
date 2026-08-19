/**
 * Input Component
 * ────────────────
 * Text input with label, error state, and icon support.
 *
 * Design spec: cornerRadius:8, height:40, padding:[8,12], border:1px
 *
 * Features:
 *   - Label + optional description text
 *   - Error state with message
 *   - Left icon slot (e.g., search icon)
 *   - Right adornment slot (e.g., clear button)
 *   - Full width by default
 *   - Disabled state
 *   - Textarea variant for multi-line
 */

import React from "react";
import { COMPONENT_SPEC, COLORS, STATUS_COLORS } from "../../constants/theme";

// ─── Props ───────────────────────────────────────────────────────

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  description?: string;
  error?: string | null;
  leftIcon?: React.ReactNode;
  rightAdornment?: React.ReactNode;
  containerStyle?: React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────────

export const Input: React.FC<InputProps> = React.memo(
  ({
    label,
    description,
    error,
    leftIcon,
    rightAdornment,
    containerStyle,
    disabled,
    style,
    onFocus,
    onBlur,
    ...rest
  }) => {
    const [focused, setFocused] = React.useState(false);

    const handleFocus = React.useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        setFocused(true);
        onFocus?.(e);
      },
      [onFocus],
    );

    const handleBlur = React.useCallback(
      (e: React.FocusEvent<HTMLInputElement>) => {
        setFocused(false);
        onBlur?.(e);
      },
      [onBlur],
    );

    const hasError = !!error;

    return (
      <div style={{ width: "100%", ...containerStyle }}>
        {/* Label */}
        {label && (
          <label
            style={{
              display: "block",
              fontSize: "0.8125rem",
              fontWeight: 500,
              color: COLORS.foreground,
              marginBottom: "6px",
            }}
          >
            {label}
          </label>
        )}

        {/* Description */}
        {description && !error && (
          <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            {description}
          </p>
        )}

        {/* Input wrapper */}
        <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
          {/* Left icon */}
          {leftIcon && (
            <span
              style={{
                position: "absolute",
                left: "12px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: COLORS.mutedForeground,
                pointerEvents: "none",
                zIndex: 1,
              }}
            >
              {leftIcon}
            </span>
          )}

          {/* Input element */}
          <input
            disabled={disabled}
            onFocus={handleFocus}
            onBlur={handleBlur}
            style={{
              width: "100%",
              height: COMPONENT_SPEC.input.height,
              padding: `${COMPONENT_SPEC.input.paddingY} ${COMPONENT_SPEC.input.paddingX}`,
              paddingLeft: leftIcon ? "36px" : COMPONENT_SPEC.input.paddingX,
              paddingRight: rightAdornment ? "36px" : COMPONENT_SPEC.input.paddingX,
              borderRadius: COMPONENT_SPEC.input.borderRadius,
              border: `${COMPONENT_SPEC.input.borderWidth} solid ${
                hasError
                  ? STATUS_COLORS.error
                  : focused
                    ? COLORS.primary
                    : COLORS.border
              }`,
              backgroundColor: COLORS.background,
              color: COLORS.foreground,
              fontSize: "0.875rem",
              outline: "none",
              transition: "border-color 150ms ease, box-shadow 150ms ease",
              boxShadow: focused && !hasError ? `0 0 0 3px ${STATUS_COLORS.infoBg}` : "none",
              opacity: disabled ? 0.5 : 1,
              cursor: disabled ? "not-allowed" : "text",
              ...style,
            }}
            {...rest}
          />

          {/* Right adornment */}
          {rightAdornment && (
            <span
              style={{
                position: "absolute",
                right: "8px",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 1,
              }}
            >
              {rightAdornment}
            </span>
          )}
        </div>

        {/* Error message */}
        {hasError && (
          <p
            style={{
              fontSize: "0.75rem",
              color: STATUS_COLORS.error,
              marginTop: "6px",
            }}
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    );
  },
);

Input.displayName = "Input";

// ─── Textarea Variant ────────────────────────────────────────────

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement> {
  label?: string;
  description?: string;
  error?: string | null;
  containerStyle?: React.CSSProperties;
}

export const Textarea: React.FC<TextareaProps> = React.memo(
  ({ label, description, error, containerStyle, disabled, style, ...rest }) => {
    const hasError = !!error;

    return (
      <div style={{ width: "100%", ...containerStyle }}>
        {label && (
          <label
            style={{
              display: "block",
              fontSize: "0.8125rem",
              fontWeight: 500,
              color: COLORS.foreground,
              marginBottom: "6px",
            }}
          >
            {label}
          </label>
        )}

        {description && !error && (
          <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            {description}
          </p>
        )}

        <textarea
          disabled={disabled}
          style={{
            width: "100%",
            minHeight: "80px",
            padding: "8px 12px",
            borderRadius: COMPONENT_SPEC.input.borderRadius,
            border: `${COMPONENT_SPEC.input.borderWidth} solid ${
              hasError ? STATUS_COLORS.error : COLORS.border
            }`,
            backgroundColor: COLORS.background,
            color: COLORS.foreground,
            fontSize: "0.875rem",
            fontFamily: "inherit",
            lineHeight: 1.5,
            outline: "none",
            resize: "vertical",
            transition: "border-color 150ms ease",
            opacity: disabled ? 0.5 : 1,
            cursor: disabled ? "not-allowed" : "text",
            ...style,
          }}
          {...rest}
        />

        {hasError && (
          <p style={{ fontSize: "0.75rem", color: STATUS_COLORS.error, marginTop: "6px" }} role="alert">
            {error}
          </p>
        )}
      </div>
    );
  },
);

Textarea.displayName = "Textarea";
