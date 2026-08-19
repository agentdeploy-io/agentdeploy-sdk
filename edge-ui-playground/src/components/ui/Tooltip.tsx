/**
 * Tooltip Component
 * ─────────────────
 * Lightweight hover tooltip with positioning.
 * No dependencies — uses pure CSS + React state.
 *
 * Features:
 *   - Smart positioning (auto-avoids viewport edges)
 *   - Configurable delay
 *   - Supports keyboard focus
 *   - Dark background with white text (works in both themes)
 */

import React from "react";
import { COLORS, RADIUS, Z_INDEX } from "../../constants/theme";

export interface TooltipProps {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  delay?: number;
  style?: React.CSSProperties;
}

type Side = NonNullable<TooltipProps["side"]>;

export const Tooltip: React.FC<TooltipProps> = ({
  content,
  children,
  side = "top",
  delay = 300,
  style,
}) => {
  const [visible, setVisible] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const childRef = React.useRef<HTMLElement | null>(null);

  const show = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  const hide = React.useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setVisible(false);
  }, []);

  React.useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  // Clone child to attach event handlers
  const childProps = children.props as React.HTMLAttributes<HTMLElement>;
  const child = React.cloneElement(children, {
    ref: childRef,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      show();
      (childProps.onMouseEnter as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      hide();
      (childProps.onMouseLeave as ((e: React.MouseEvent<HTMLElement>) => void) | undefined)?.(e);
    },
    onFocus: (e: React.FocusEvent<HTMLElement>) => {
      show();
      (childProps.onFocus as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
    },
    onBlur: (e: React.FocusEvent<HTMLElement>) => {
      hide();
      (childProps.onBlur as ((e: React.FocusEvent<HTMLElement>) => void) | undefined)?.(e);
    },
  } as React.HTMLAttributes<HTMLElement>);

  const positions: Record<Side, React.CSSProperties> = {
    top: {
      bottom: "100%",
      left: "50%",
      transform: "translateX(-50%)",
      marginBottom: "8px",
    },
    bottom: {
      top: "100%",
      left: "50%",
      transform: "translateX(-50%)",
      marginTop: "8px",
    },
    left: {
      right: "100%",
      top: "50%",
      transform: "translateY(-50%)",
      marginRight: "8px",
    },
    right: {
      left: "100%",
      top: "50%",
      transform: "translateY(-50%)",
      marginLeft: "8px",
    },
  };

  return (
    <span style={{ position: "relative", display: "inline-flex" }}>
      {child}
      {visible && content && (
        <span
          role="tooltip"
          style={{
            position: "absolute",
            zIndex: Z_INDEX.tooltip,
            padding: "6px 10px",
            backgroundColor: "#18181B",
            color: "#FAFAFA",
            fontSize: "0.75rem",
            fontWeight: 500,
            borderRadius: RADIUS.sm,
            whiteSpace: "nowrap",
            pointerEvents: "none",
            boxShadow: "0 4px 6px -1px rgba(0,0,0,0.2)",
            animation: "fadeIn 100ms ease-out",
            ...positions[side],
            ...style,
          }}
        >
          {content}
        </span>
      )}
    </span>
  );
};
