/**
 * DashboardShell — Agent monitoring dashboard
 *
 * Shows agent state, recent activity, schedules, and metrics.
 * Used for "management plane" UIs on top of scheduled agents.
 *
 * This shell uses useAgent() for WebSocket state synchronization.
 * It works with any Agent (not just AIChatAgent) by using:
 *   - onStateUpdate: receives agent state changes
 *   - agent.call(): invokes @callable() RPC methods on the agent
 *
 * @example
 * ```tsx
 * import { DashboardShell } from "@agentdeploy/edge-ui/dashboard";
 *
 * <DashboardShell agent="monitor" title="System Monitor" host="localhost:8787" />
 * ```
 */

import React, { useState, useCallback } from "react";
import { useAgent } from "@agentdeploy/agents/react";
import type { UITheme } from "../../theme.js";
import { themeToCSSVars, DEFAULT_LIGHT_THEME } from "../../theme.js";

export interface DashboardMetric {
  label: string;
  value: string | number;
  unit?: string;
  trend?: "up" | "down" | "flat";
}

export interface DashboardShellProps {
  /** Agent class name to connect to */
  agent: string;
  /** Agent instance name */
  name?: string;
  /** Host for the agent WebSocket connection (e.g. "localhost:8787") */
  host?: string;
  /** Whether to use wss:// (true) or ws:// (false) */
  secure?: boolean;
  /** Title shown in the header */
  title?: string;
  /** Theme override */
  theme?: UITheme;
  /** Custom metrics to display */
  metrics?: DashboardMetric[];
  /** Called when the "refresh" button is clicked */
  onRefresh?: () => void;
  /** Show a trigger button that calls an RPC method on the agent */
  triggerLabel?: string;
  /** RPC method name to call when trigger button is pressed */
  triggerMethod?: string;
}

export function DashboardShell({
  agent,
  name = "default",
  host,
  secure,
  title = "Dashboard",
  theme = DEFAULT_LIGHT_THEME,
  metrics = [],
  onRefresh,
  triggerLabel,
  triggerMethod,
}: DashboardShellProps) {
  const [agentState, setAgentState] = useState<Record<string, unknown> | null>(null);
  const [lastUpdate, setLastUpdate] = useState<string>("");
  const [triggering, setTriggering] = useState(false);
  const [triggerError, setTriggerError] = useState<string | null>(null);

  const socketAgent = useAgent({
    agent: agent as never,
    name,
    host: host as never,
    secure: secure as never,
    onStateUpdate: useCallback((state: unknown) => {
      setAgentState(state as Record<string, unknown>);
      setLastUpdate(new Date().toISOString());
    }, []),
  } as never);

  const cssVars = themeToCSSVars(theme);
  const connected = (socketAgent as { identified?: boolean })?.identified ?? false;
  const currentState = (socketAgent as { state?: unknown })?.state;

  // Sync initial state from the agent connection
  const effectiveState = agentState ?? (currentState as Record<string, unknown> | undefined) ?? null;

  const handleTrigger = useCallback(async () => {
    if (!triggerMethod) return;
    setTriggering(true);
    setTriggerError(null);
    try {
      await (socketAgent as { call?: (method: string, args?: unknown[]) => Promise<unknown> })
        ?.call?.(triggerMethod, []);
    } catch (err) {
      setTriggerError(err instanceof Error ? err.message : "Trigger failed");
    } finally {
      setTriggering(false);
    }
  }, [triggerMethod, socketAgent]);

  return (
    <div
      style={{
        ...cssVars,
        minHeight: "100%",
        backgroundColor: "var(--ad-bg)",
        color: "var(--ad-text)",
        fontFamily: "var(--ad-font-family)",
        fontSize: "var(--ad-font-size)",
        padding: "24px",
      } as React.CSSProperties}
    >
      {/* Header */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "24px",
        }}
      >
        <div>
          <h1 style={{ margin: 0, fontSize: "1.5em", fontWeight: 700 }}>{title}</h1>
          {lastUpdate && (
            <p style={{ margin: "4px 0 0", fontSize: "0.85em", color: "var(--ad-text-muted)" }}>
              Last updated: {new Date(lastUpdate).toLocaleString()}
            </p>
          )}
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "0.8em",
              color: "var(--ad-text-muted)",
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                backgroundColor: connected ? "var(--ad-success)" : "var(--ad-text-muted)",
              }}
            />
            {connected ? "Connected" : "Connecting..."}
          </span>
          {onRefresh && (
            <button
              onClick={onRefresh}
              style={{
                padding: "6px 14px",
                border: `1px solid var(--ad-border)`,
                borderRadius: "var(--ad-radius)",
                backgroundColor: "var(--ad-surface)",
                color: "var(--ad-text)",
                cursor: "pointer",
                fontSize: "0.85em",
              }}
            >
              ↻ Refresh
            </button>
          )}
          {triggerLabel && triggerMethod && (
            <button
              onClick={handleTrigger}
              disabled={triggering || !connected}
              style={{
                padding: "6px 14px",
                border: "none",
                borderRadius: "var(--ad-radius)",
                backgroundColor: "var(--ad-primary)",
                color: "var(--ad-primary-text)",
                cursor: triggering || !connected ? "not-allowed" : "pointer",
                opacity: triggering || !connected ? 0.5 : 1,
                fontSize: "0.85em",
                fontWeight: 500,
              }}
            >
              {triggering ? "Running..." : triggerLabel}
            </button>
          )}
        </div>
      </div>

      {/* Trigger error */}
      {triggerError && (
        <div
          style={{
            marginBottom: "16px",
            padding: "10px 14px",
            borderRadius: "var(--ad-radius)",
            backgroundColor: "var(--ad-error)",
            color: "var(--ad-primary-text)",
            fontSize: "0.85em",
          }}
        >
          {triggerError}
        </div>
      )}

      {/* Metrics grid */}
      {metrics.length > 0 && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "16px",
            marginBottom: "24px",
          }}
        >
          {metrics.map((m) => (
            <div
              key={m.label}
              style={{
                padding: "20px",
                backgroundColor: "var(--ad-surface)",
                borderRadius: "var(--ad-radius)",
                border: `1px solid var(--ad-border)`,
              }}
            >
              <div style={{ fontSize: "0.8em", color: "var(--ad-text-muted)", marginBottom: "8px" }}>
                {m.label}
              </div>
              <div style={{ fontSize: "1.8em", fontWeight: 700 }}>
                {m.value}
                {m.unit && (
                  <span style={{ fontSize: "0.6em", color: "var(--ad-text-muted)", marginLeft: "4px" }}>
                    {m.unit}
                  </span>
                )}
                {m.trend && (
                  <span
                    style={{
                      marginLeft: "8px",
                      fontSize: "0.7em",
                      color:
                        m.trend === "up" ? "var(--ad-success)" :
                        m.trend === "down" ? "var(--ad-error)" :
                        "var(--ad-text-muted)",
                    }}
                  >
                    {m.trend === "up" ? "\u2191" : m.trend === "down" ? "\u2193" : "\u2192"}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Agent state viewer */}
      {effectiveState && (
        <div
          style={{
            padding: "20px",
            backgroundColor: "var(--ad-surface)",
            borderRadius: "var(--ad-radius)",
            border: `1px solid var(--ad-border)`,
          }}
        >
          <h2 style={{ margin: "0 0 12px", fontSize: "1em", fontWeight: 600 }}>
            Agent State
          </h2>
          <pre
            style={{
              margin: 0,
              padding: "12px",
              backgroundColor: "var(--ad-bg)",
              borderRadius: `calc(var(--ad-radius) - 4px)`,
              overflow: "auto",
              fontSize: "0.85em",
              lineHeight: 1.5,
            }}
          >
            {JSON.stringify(effectiveState, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
