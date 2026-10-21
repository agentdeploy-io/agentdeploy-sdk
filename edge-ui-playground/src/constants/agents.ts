/**
 * Agent Registry Constants
 * ────────────────────────
 * Central registry of all agents managed by the Edge Console.
 * This maps agent IDs to their WebSocket endpoints, metadata, and
 * runtime configuration. New agents are added here — nowhere else.
 *
 * 12factor.net: Endpoints and ports are config, not hardcoded in views.
 */

// ─── Agent Definitions ───────────────────────────────────────────

export interface AgentRegistryEntry {
  /** Unique identifier used in URLs and WebSocket connections */
  id: string;
  /** Display name shown in the UI */
  name: string;
  /** Short description of what this agent does */
  description: string;
  /** Emoji or icon identifier for visual identification */
  icon: string;
  /** Agent category for filtering/grouping */
  kind: AgentKind;
  /** WebSocket path (appended to configured base URL) */
  wsPath: string;
  /** Durable Object class name (production deployments only) */
  className?: string;
  /** Which port the agent runs on (for dev proxy config) */
  port: number;
  /** Whether this agent supports live chat */
  supportsChat: boolean;
  /** Whether this agent has scheduled/cron triggers */
  hasCron: boolean;
  /** Capabilities this agent exposes */
  capabilities: string[];
  /**
   * Lifecycle status of the underlying deployment (production only).
   * Absent/"active" = healthy; suspended/failed render with actions.
   */
  deploymentStatus?: "active" | "suspended" | "pending" | "failed" | string;
  /**
   * Personal/demo agents (e.g., polymarket-intel, gmail-invoices) are only
   * shown in local dev when explicitly opted in via
   * VITE_PERSONAL_AGENTS="true". They never render on auth-disabled
   * deployments by default.
   */
  personal?: boolean;
}

export type AgentKind = "chat" | "cron" | "api" | "worker";

export const AGENTS: AgentRegistryEntry[] = [
  {
    id: "support",
    name: "Support Agent",
    description: "Customer support chatbot handling tickets and FAQs",
    icon: "🎧",
    kind: "chat",
    /** Agents SDK routes /agents/{namespace}/{instance} — namespace is the DO binding name */
    wsPath: "/agents/support/default",
    port: 8789,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset", "rpc:flag"],
  },
  {
    id: "sales",
    name: "Sales Agent",
    description: "Lead qualification and product recommendation assistant",
    icon: "💼",
    kind: "chat",
    wsPath: "/agents/sales/default",
    port: 8789,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset"],
  },
  {
    id: "markie",
    name: "Business Outreach (Markie)",
    description: "Registry-grounded BD: crawl → score → gated pitch → reply tracking",
    icon: "📈",
    kind: "chat",
    wsPath: "/agents/markie-agent/main",
    port: 8791,
    supportsChat: true,
    hasCron: true,
    capabilities: ["chat", "cron:0 1 * * *"],
  },
  {
    id: "polymarket-intel",
    name: "Polymarket Intel",
    description: "Scheduled market intelligence aggregator for prediction markets",
    icon: "📊",
    kind: "cron",
    wsPath: "/agents/polymarket-intel/default",
    port: 8787,
    supportsChat: true,
    hasCron: true,
    capabilities: ["chat", "rpc:fetch-markets", "cron:*/20 * * * *"],
    personal: true,
  },
  {
    id: "gmail-invoices",
    name: "Gmail Invoices",
    description: "Automated invoice detection and extraction from Gmail",
    icon: "📧",
    kind: "cron",
    wsPath: "/agents/gmail-invoices/default",
    port: 8788,
    supportsChat: true,
    hasCron: true,
    capabilities: ["chat", "rpc:scan-inbox", "cron:*/20 * * * *"],
    personal: true,
  },
];

/**
 * Whether personal/demo agents are visible. Explicit opt-in only —
 * auth being disabled alone does NOT surface them.
 */
export const PERSONAL_AGENTS_ENABLED: boolean =
  import.meta.env.VITE_PERSONAL_AGENTS === "true";

/**
 * Agents visible in the local-dev fallback registry.
 * Personal agents are filtered out unless explicitly opted in.
 */
export const VISIBLE_LOCAL_AGENTS: AgentRegistryEntry[] = AGENTS.filter(
  (agent) => !agent.personal || PERSONAL_AGENTS_ENABLED
);

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Get an agent by ID with safe fallback.
 * Returns undefined if not found (intentional — caller handles).
 */
export function getAgentById(id: string): AgentRegistryEntry | undefined {
  return AGENTS.find((agent) => agent.id === id);
}

/**
 * Build a WebSocket URL for an agent.
 * Uses same-origin in dev (Vite proxy handles routing).
 *
 * Auth is handled separately by `buildAuthedWsUrl()` from useAuthFetch:
 *   - Subdomain (*.agentdeploy.io): session cookie sent automatically
 *   - Custom domain: edge JWT appended as ?token= query param
 *   - Local dev: no auth needed
 */
export function buildAgentWsUrl(agent: AgentRegistryEntry): string {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  const host = window.location.host;
  return `${protocol}//${host}${agent.wsPath}`;
}

/**
 * Base prefix for deterministic /cmd/<name> routes (slash commands, review
 * queue). Null when no route can reach the agent.
 *
 *   - Production: the console proxy route (/d/<deploymentId>) — the console
 *     worker forwards /d/<id>/* to the agent worker and mints the JWT.
 *   - Local dev (agent.port > 0): same-origin wsPath — the Vite proxy routes
 *     /agents/<namespace>/* straight to the local worker (no auth).
 */
export function agentCmdPrefix(agent: AgentRegistryEntry): string | null {
  const p = agent.wsPath.split("/agents/")[0];
  if (p && p.startsWith("/d/")) return p;
  if (agent.port > 0) return agent.wsPath;
  return null;
}

/**
 * Get agents filtered by kind.
 */
export function getAgentsByKind(kind: AgentKind): AgentRegistryEntry[] {
  return AGENTS.filter((agent) => agent.kind === kind);
}

/**
 * Get the count of agents by status (computed at runtime from health checks).
 */
export const AGENT_COUNT = AGENTS.length;

// ─── Default Agent Configuration ─────────────────────────────────

export const DEFAULT_AGENT_CONFIG = {
  /** Auto-reconnect WebSocket if connection drops */
  autoReconnect: true,
  /** Max reconnect attempts before giving up */
  maxReconnectAttempts: 5,
  /** Base delay between reconnects (exponential backoff) */
  reconnectBaseDelay: 1000,
  /** Health check poll interval when WS is down (ms) */
  healthCheckInterval: 30000,
  /** Message history limit per conversation */
  messageHistoryLimit: 100,
} as const;

// ─── Agent Status Labels ─────────────────────────────────────────

export const AGENT_STATUS_LABELS = {
  connected: "Connected",
  connecting: "Connecting…",
  disconnected: "Disconnected",
  error: "Error",
  degraded: "Degraded",
  unknown: "Unknown",
} as const;

export const AGENT_STATUS_BADGE_VARIANT = {
  connected: "success" as const,
  connecting: "info" as const,
  disconnected: "neutral" as const,
  error: "error" as const,
  degraded: "warning" as const,
  unknown: "neutral" as const,
};
