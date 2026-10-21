/**
 * Agent Registry Constants
 * ────────────────────────
 * Central registry of all agents managed by the Calla UI.
 * Maps agent IDs to their WebSocket endpoints, metadata, and runtime
 * configuration. In production the live registry comes from
 * useDeployments (deployment-service API); CALLA_DEV_AGENTS is only
 * used in local dev when AUTH_DISABLED.
 *
 * 12factor.net: Endpoints and ports are config, not hardcoded in views.
 */

// ─── Agent Definitions ───────────────────────────────────────────

/**
 * Where an agent actually runs. Edge agents speak the cf_agent_* WS
 * protocol; core/brain/classifier entries are rendered on the fleet
 * dashboard without a WebSocket (REST/event-feed only).
 */
export type AgentRuntimeKind = "edge" | "core" | "brain" | "classifier";

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
  /** Runtime hosting the agent (default "edge" when absent) */
  runtime: AgentRuntimeKind;
  /** WebSocket path (appended to configured base URL). Empty for non-edge runtimes. */
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
}

export type AgentKind = "chat" | "cron" | "api" | "worker";

/**
 * Local-dev fleet (AUTH_DISABLED only). Matches the Calla fleet:
 *   Edge (Cloudflare Worker, cf_agent_* WS on :8787 via Vite proxy):
 *     supervisor, qualifier, researcher, writer, outreach
 *   Core (Fly.io VM — REST/supervision polling, no WS):
 *     crawler
 *   Classifier (jev — event-driven, no WS):
 *     jev
 *   Brain (Mastra — REST generate/stream, no WS):
 *     orchestrator
 */
export const CALLA_DEV_AGENTS: AgentRegistryEntry[] = [
  {
    id: "supervisor",
    name: "Supervisor",
    description: "Fleet coordinator — routes work and watches the pipeline",
    icon: "🧭",
    kind: "chat",
    runtime: "edge",
    wsPath: "/agents/calla-edge-agent/supervisor",
    port: 8787,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset"],
  },
  {
    id: "qualifier",
    name: "Qualifier",
    description: "Scores and qualifies inbound leads",
    icon: "🎯",
    kind: "chat",
    runtime: "edge",
    wsPath: "/agents/calla-edge-agent/qualifier",
    port: 8787,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset"],
  },
  {
    id: "researcher",
    name: "Researcher",
    description: "Company and contact research grounded in public data",
    icon: "🔎",
    kind: "chat",
    runtime: "edge",
    wsPath: "/agents/calla-edge-agent/researcher",
    port: 8787,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset"],
  },
  {
    id: "writer",
    name: "Writer",
    description: "Drafts outreach copy and reply handling",
    icon: "✍️",
    kind: "chat",
    runtime: "edge",
    wsPath: "/agents/calla-edge-agent/writer",
    port: 8787,
    supportsChat: true,
    hasCron: false,
    capabilities: ["chat", "rpc:reset"],
  },
  {
    id: "outreach",
    name: "Outreach",
    description: "Sends gated outreach and tracks replies",
    icon: "📣",
    kind: "chat",
    runtime: "edge",
    wsPath: "/agents/calla-edge-agent/outreach",
    port: 8787,
    supportsChat: true,
    hasCron: true,
    capabilities: ["chat", "cron:0 9 * * 1-5"],
  },
  {
    id: "crawler",
    name: "Crawler",
    description: "Core VM crawler — website discovery and enrichment",
    icon: "🕷️",
    kind: "worker",
    runtime: "core",
    wsPath: "",
    port: 0,
    supportsChat: false,
    hasCron: true,
    capabilities: ["crawl", "enrich"],
  },
  {
    id: "jev",
    name: "Jev (Classifier)",
    description: "Event classifier — routes inbound signals to the fleet",
    icon: "🧬",
    kind: "api",
    runtime: "classifier",
    wsPath: "",
    port: 0,
    supportsChat: false,
    hasCron: false,
    capabilities: ["classify"],
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    description: "Mastra brain — long-running plans with HITL tool gates",
    icon: "🧠",
    kind: "chat",
    runtime: "brain",
    wsPath: "",
    port: 0,
    supportsChat: false,
    hasCron: false,
    capabilities: ["generate", "stream", "suspended-runs"],
  },
];

// ─── Helper Functions ────────────────────────────────────────────

/**
 * Get a dev-fleet agent by ID with safe fallback.
 * Returns undefined if not found (intentional — caller handles).
 */
export function getAgentById(id: string): AgentRegistryEntry | undefined {
  return CALLA_DEV_AGENTS.find((agent) => agent.id === id);
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
  return CALLA_DEV_AGENTS.filter((agent) => agent.kind === kind);
}

/** Count of dev-fleet agents (production count comes from the registry hook). */
export const AGENT_COUNT = CALLA_DEV_AGENTS.length;

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
