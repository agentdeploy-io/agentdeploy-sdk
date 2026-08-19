/**
 * Agent Type Definitions
 * ──────────────────────
 * Core domain types for agents, their state, and interactions.
 */

import type { AgentKind, AgentRegistryEntry } from "../constants/agents";
import type { ErrorCodeValue } from "../constants/errors";

// ─── Agent Status ────────────────────────────────────────────────

export type AgentConnectionStatus =
  | "connected"
  | "connecting"
  | "disconnected"
  | "error"
  | "degraded"
  | "unknown";

// ─── Agent Runtime State ─────────────────────────────────────────

export interface AgentRuntimeState {
  agentId: string;
  status: AgentConnectionStatus;
  /** ISO timestamp of last successful health check */
  lastHealthyAt: string | null;
  /** ISO timestamp of last connection attempt */
  lastConnectedAt: string | null;
  /** Number of messages exchanged in this session */
  messageCount: number;
  /** Agent-specific state object (from DO state) */
  state: Record<string, unknown>;
  /** Currently executing RPC calls (if any) */
  pendingActions: PendingAction[];
  /** Last error encountered (if any) */
  lastError: AgentError | null;
}

export interface PendingAction {
  id: string;
  name: string;
  startedAt: string;
  status: "pending" | "success" | "error";
}

export interface AgentError {
  code: ErrorCodeValue;
  message: string;
  timestamp: string;
  /** Whether this error is recoverable */
  recoverable: boolean;
}

// ─── Chat Message ────────────────────────────────────────────────

export type MessageRole = "user" | "assistant" | "system";

export interface ChatMessage {
  id: string;
  role: MessageRole;
  content: string;
  timestamp: string;
  /** Agent that produced this message (for assistant role) */
  agentId?: string;
  /** Whether this message is still streaming */
  streaming?: boolean;
  /** Error associated with this message (if delivery failed) */
  error?: AgentError;
}

// ─── Agent Configuration ─────────────────────────────────────────

export interface AgentConfiguration {
  id: string;
  name: string;
  description: string;
  kind: AgentKind;
  /** LLM model identifier (e.g., "gpt-4o", "claude-3.5-sonnet") */
  model: string;
  /** System prompt for the LLM */
  systemPrompt: string;
  /** Temperature (0-2) */
  temperature: number;
  /** Max output tokens */
  maxTokens: number;
  /** Whether streaming is enabled */
  streaming: boolean;
  /** Cron schedule (if kind === "cron") */
  cronSchedule?: string;
  /** Tools/functions available to this agent */
  tools: string[];
  /** Environment variables (secret refs, not values) */
  secrets: SecretRef[];
  /** KV namespace bindings */
  kvBindings: KVBinding[];
  /** Durable Object bindings */
  doBindings: DOBinding[];
}

export interface SecretRef {
  key: string;
  /** Whether the secret value is set (we never store the value client-side) */
  isSet: boolean;
  /** Last updated timestamp */
  updatedAt: string | null;
}

export interface KVBinding {
  name: string;
  namespaceId: string;
}

export interface DOBinding {
  name: string;
  className: string;
  migrationTag?: string;
}

// ─── Conversation ────────────────────────────────────────────────

export interface Conversation {
  id: string;
  agentId: string;
  title: string;
  /** First message preview */
  preview: string;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  /** Whether there are unread messages */
  hasUnread: boolean;
}

// ─── Worker / Deployment ─────────────────────────────────────────

export type WorkerStatus = "active" | "idle" | "error" | "deploying";

export interface WorkerInfo {
  id: string;
  name: string;
  url: string;
  status: WorkerStatus;
  region: string;
  /** Last deployment info */
  lastDeployment: DeploymentInfo | null;
  /** CPU time used (ms) in current billing period */
  cpuMs: number;
  /** Total requests in current billing period */
  requests: number;
  /** Errors in current billing period */
  errors: number;
}

export interface DeploymentInfo {
  id: string;
  version: string;
  deployedAt: string;
  deployedBy: string;
  status: "success" | "failed" | "in-progress";
  /** Git commit SHA if deployed from Git */
  commitSha?: string;
}

// ─── Observability ───────────────────────────────────────────────

export interface TraceEntry {
  id: string;
  agentId: string;
  /** Trace name (e.g., "chat.completion", "rpc.fetch-markets") */
  name: string;
  startTime: string;
  endTime: string | null;
  durationMs: number;
  status: "ok" | "error";
  /** Span count */
  spanCount: number;
  /** Token usage (if applicable) */
  tokensUsed?: {
    input: number;
    output: number;
    total: number;
  };
}

export interface LogEntry {
  id: string;
  agentId: string;
  level: "debug" | "info" | "warn" | "error";
  message: string;
  timestamp: string;
  /** Optional structured data */
  data?: Record<string, unknown>;
}

// ─── Health Check ────────────────────────────────────────────────

export interface HealthCheck {
  agentId: string;
  healthy: boolean;
  latencyMs: number;
  timestamp: string;
  error?: string;
}

// ─── Registry Entry Re-export ────────────────────────────────────

export type { AgentRegistryEntry, AgentKind };
