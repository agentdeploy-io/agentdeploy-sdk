/**
 * @agentdeploy-io/edge-ui — Pre-built UI shells for AgentDeploy edge agents
 *
 * This package provides React components that sellers can bundle with
 * their agent templates to ship a complete UI alongside their agent.
 *
 * Shells available:
 *   - ChatShell     — Full-page conversational interface
 *   - WidgetShell   — Embedded floating chat widget
 *   - DashboardShell — Agent monitoring dashboard
 *   - SplitShell    — Chat + dashboard side-by-side
 *
 * @example
 * ```tsx
 * import { ChatShell } from "@agentdeploy-io/edge-ui";
 *
 * export default function App() {
 *   return <ChatShell agent="support" title="Customer Support" />;
 * }
 * ```
 */

// Shells
export { ChatShell } from "./shells/chat/ChatShell.js";
export type { ChatShellProps, ChatMessage } from "./shells/chat/ChatShell.js";

export { WidgetShell } from "./shells/widget/WidgetShell.js";
export type { WidgetShellProps } from "./shells/widget/WidgetShell.js";

export { DashboardShell } from "./shells/dashboard/DashboardShell.js";
export type { DashboardShellProps, DashboardMetric } from "./shells/dashboard/DashboardShell.js";

export { SplitShell } from "./shells/split/SplitShell.js";
export type { SplitShellProps } from "./shells/split/SplitShell.js";

// Theme system
export {
  DEFAULT_LIGHT_THEME,
  DEFAULT_DARK_THEME,
  createTheme,
  autoTheme,
  themeToCSSVars,
  isSystemDark,
} from "./theme.js";
export type { UITheme } from "./theme.js";

// Runtime (for Worker-side asset handling)
export { createUIHandler, isUIPath, spaFallback } from "./runtime.js";

// Shell type enum for CLI/template use
export type ShellType = "chat" | "widget" | "dashboard" | "split";

export const SHELL_TYPES: ShellType[] = ["chat", "widget", "dashboard", "split"];
