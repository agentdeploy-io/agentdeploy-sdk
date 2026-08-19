/**
 * WidgetShell — Embedded floating chat widget
 *
 * Renders as a floating button that expands into a chat panel.
 * Ideal for embedding on third-party sites.
 *
 * @example
 * ```tsx
 * import { WidgetShell } from "@agentdeploy/edge-ui/widget";
 *
 * <WidgetShell agent="support" title="Help" />
 * ```
 */

import React, { useState } from "react";
import { ChatShell } from "../chat/ChatShell.js";
import type { UITheme } from "../../theme.js";
import { themeToCSSVars, DEFAULT_LIGHT_THEME } from "../../theme.js";

export interface WidgetShellProps {
  agent: string;
  name?: string;
  host?: string;
  secure?: boolean;
  title?: string;
  subtitle?: string;
  theme?: UITheme;
  placeholder?: string;
  position?: "bottom-right" | "bottom-left";
  buttonColor?: string;
  buttonIcon?: string;
}

export function WidgetShell({
  agent,
  name = "default",
  host,
  secure,
  title = "Chat",
  subtitle,
  theme = DEFAULT_LIGHT_THEME,
  placeholder,
  position = "bottom-right",
  buttonColor,
  buttonIcon = "💬",
}: WidgetShellProps) {
  const [open, setOpen] = useState(false);
  const cssVars = themeToCSSVars(theme);

  const positionStyles: React.CSSProperties =
    position === "bottom-right"
      ? { right: 20, bottom: 20 }
      : { left: 20, bottom: 20 };

  if (!open) {
    return (
      <div style={{ ...cssVars } as React.CSSProperties}>
        <button
          onClick={() => setOpen(true)}
          style={{
            position: "fixed",
            ...positionStyles,
            width: 60,
            height: 60,
            borderRadius: "50%",
            border: "none",
            backgroundColor: buttonColor ?? theme.primary,
            color: theme.primaryText,
            fontSize: 24,
            cursor: "pointer",
            boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
            zIndex: 99998,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            transition: "transform 0.2s",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.transform = "scale(1.1)")}
          onMouseLeave={(e) => (e.currentTarget.style.transform = "scale(1)")}
        >
          {buttonIcon}
        </button>
      </div>
    );
  }

  return (
    <div
      style={{
        position: "fixed",
        ...positionStyles,
        width: "min(400px, calc(100vw - 40px))",
        height: "min(600px, calc(100vh - 40px))",
        borderRadius: theme.radius,
        overflow: "hidden",
        boxShadow: "0 8px 32px rgba(0,0,0,0.15)",
        zIndex: 99999,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ position: "relative", flex: 1, overflow: "hidden" }}>
        <ChatShell
          agent={agent}
          name={name}
          host={host}
          secure={secure}
          title={title}
          subtitle={subtitle}
          theme={theme}
          placeholder={placeholder}
          showStatus
        />
        <button
          onClick={() => setOpen(false)}
          style={{
            position: "absolute",
            top: 12,
            right: 12,
            width: 28,
            height: 28,
            borderRadius: "50%",
            border: "none",
            backgroundColor: theme.surface,
            color: theme.textMuted,
            cursor: "pointer",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: 16,
            zIndex: 1,
          }}
        >
          ✕
        </button>
      </div>
    </div>
  );
}
