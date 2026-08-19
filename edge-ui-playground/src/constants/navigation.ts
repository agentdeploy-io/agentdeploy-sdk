/**
 * Navigation Constants
 * ────────────────────
 * Sidebar navigation structure and view routing configuration.
 * This is the single source of truth for what views exist and
 * how they're organized in the navigation tree.
 */

import type { ViewId } from "../types/ui";

// ─── Navigation Items ────────────────────────────────────────────

export interface NavItemConfig {
  id: ViewId;
  label: string;
  icon: string; // Lucide icon name (lowercase, kebab-case)
  /** Route path (without leading slash for relative routing) */
  path: string;
  /** Badge count key (optional, populated at runtime) */
  badgeKey?: string;
  /** Whether this item is visible in the sidebar */
  visible: boolean;
  /** Sort order within its group */
  order: number;
}

export interface NavGroupConfig {
  id: string;
  label: string;
  items: NavItemConfig[];
}

// ─── Primary Navigation Groups ───────────────────────────────────

export const NAV_GROUPS: NavGroupConfig[] = [
  {
    id: "monitor",
    label: "Monitor",
    items: [
      {
        id: "overview",
        label: "Overview",
        icon: "layout-dashboard",
        path: "/",
        visible: true,
        order: 0,
      },
      {
        id: "agents",
        label: "Agents",
        icon: "bot",
        path: "/agents",
        visible: true,
        order: 1,
      },
      {
        id: "conversations",
        label: "Conversations",
        icon: "messages-square",
        path: "/conversations",
        visible: true,
        order: 2,
      },
    ],
  },
  {
    id: "manage",
    label: "Manage",
    items: [
      {
        id: "workers",
        label: "Workers & Deployments",
        icon: "cloud",
        path: "/workers",
        visible: true,
        order: 3,
      },
      {
        id: "config",
        label: "Configuration",
        icon: "settings-2",
        path: "/config",
        visible: true,
        order: 4,
      },
      {
        id: "observability",
        label: "Observability",
        icon: "activity",
        path: "/observability",
        visible: true,
        order: 5,
      },
    ],
  },
  {
    id: "system",
    label: "System",
    items: [
      {
        id: "settings",
        label: "Settings",
        icon: "gear",
        path: "/settings",
        visible: true,
        order: 6,
      },
    ],
  },
];

// ─── Flattened Nav Items (for quick lookups) ─────────────────────

export const ALL_NAV_ITEMS: NavItemConfig[] = NAV_GROUPS.flatMap(
  (group) => group.items,
);

export function getNavItem(viewId: ViewId): NavItemConfig | undefined {
  return ALL_NAV_ITEMS.find((item) => item.id === viewId);
}

// ─── Agent Detail Sub-Tabs ───────────────────────────────────────

export interface AgentTabConfig {
  id: string;
  label: string;
  icon: string;
  order: number;
}

export const AGENT_TABS: AgentTabConfig[] = [
  { id: "chat", label: "Chat", icon: "message-circle", order: 0 },
  { id: "monitor", label: "Monitor", icon: "activity", order: 1 },
  { id: "config", label: "Configuration", icon: "settings-2", order: 2 },
  { id: "schedules", label: "Schedules", icon: "clock", order: 3 },
  { id: "storage", label: "Storage", icon: "database", order: 4 },
  { id: "logs", label: "Logs", icon: "scroll-text", order: 5 },
  { id: "traces", label: "Traces", icon: "git-branch", order: 6 },
  { id: "versions", label: "Versions", icon: "git-commit", order: 7 },
];

// ─── Environment Switcher ────────────────────────────────────────

export interface EnvironmentConfig {
  id: string;
  label: string;
  /** API base URL for this environment */
  apiBaseUrl: string;
  /** Whether this environment is selectable in the UI */
  enabled: boolean;
}

export const ENVIRONMENTS: EnvironmentConfig[] = [
  {
    id: "local",
    label: "Local",
    apiBaseUrl: "http://localhost:8787",
    enabled: true,
  },
  {
    id: "staging",
    label: "Staging",
    apiBaseUrl: "",
    enabled: false, // Enable when staging is provisioned
  },
  {
    id: "production",
    label: "Production",
    apiBaseUrl: "",
    enabled: false, // Enable when production is provisioned
  },
];

export const DEFAULT_ENVIRONMENT = "local";
