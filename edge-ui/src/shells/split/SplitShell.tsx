/**
 * SplitShell — Chat + Dashboard side-by-side
 *
 * Ideal for agents that need both conversation and data monitoring.
 *
 * @example
 * ```tsx
 * import { SplitShell } from "@agentdeploy/edge-ui/split";
 *
 * <SplitShell agent="support" title="Support Console" />
 * ```
 */

import React from "react";
import { ChatShell } from "../chat/ChatShell.js";
import { DashboardShell } from "../dashboard/DashboardShell.js";
import type { UITheme } from "../../theme.js";
import { DEFAULT_LIGHT_THEME } from "../../theme.js";
import type { DashboardMetric } from "../dashboard/DashboardShell.js";

export interface SplitShellProps {
  agent: string;
  name?: string;
  host?: string;
  secure?: boolean;
  title?: string;
  subtitle?: string;
  theme?: UITheme;
  placeholder?: string;
  metrics?: DashboardMetric[];
  chatTitle?: string;
  dashboardTitle?: string;
  triggerLabel?: string;
  triggerMethod?: string;
}

export function SplitShell({
  agent,
  name = "default",
  host,
  secure,
  title = "Agent Console",
  subtitle,
  theme = DEFAULT_LIGHT_THEME,
  placeholder,
  metrics = [],
  chatTitle = "Chat",
  dashboardTitle = "Status",
  triggerLabel,
  triggerMethod,
}: SplitShellProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100vh",
        maxHeight: "100dvh",
        backgroundColor: theme.background,
        color: theme.text,
        fontFamily: theme.fontFamily,
      }}
    >
      {/* Top bar */}
      <div
        style={{
          padding: "12px 24px",
          borderBottom: `1px solid ${theme.border}`,
          backgroundColor: theme.surface,
          display: "flex",
          alignItems: "center",
          gap: "12px",
          flexShrink: 0,
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.1em", fontWeight: 600 }}>{title}</h1>
        {subtitle && (
          <span style={{ fontSize: "0.85em", color: theme.textMuted }}>{subtitle}</span>
        )}
      </div>

      {/* Split content */}
      <div
        style={{
          display: "flex",
          flex: 1,
          overflow: "hidden",
          flexDirection: "row",
        }}
      >
        {/* Left: Dashboard */}
        <div
          style={{
            width: "40%",
            minWidth: "300px",
            overflowY: "auto",
            borderRight: `1px solid ${theme.border}`,
          }}
        >
          <DashboardShell
            agent={agent}
            name={name}
            host={host}
            secure={secure}
            title={dashboardTitle}
            theme={theme}
            metrics={metrics}
            triggerLabel={triggerLabel}
            triggerMethod={triggerMethod}
          />
        </div>

        {/* Right: Chat */}
        <div style={{ flex: 1, overflow: "hidden" }}>
          <ChatShell
            agent={agent}
            name={name}
            host={host}
            secure={secure}
            title={chatTitle}
            subtitle={subtitle}
            theme={theme}
            placeholder={placeholder}
          />
        </div>
      </div>
    </div>
  );
}
