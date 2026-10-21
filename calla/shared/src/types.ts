/**
 * Calla canonical entities.
 * Shared across the Manager UI, the Cloudflare edge worker, and the Mastra brain.
 * @see plans/prd-business-intelligence-agent/06-playground-pivot-to-calla.md §4.1
 */

// ─── Agents ──────────────────────────────────────────────────────

export type AgentType = "edge" | "brain" | "sub" | "core" | "classifier";
export type AgentRuntime = "cloudflare" | "fly";
export type AgentStatus =
  | "idle"
  | "running"
  | "awaiting_approval"
  | "error"
  | "offline";

export interface Agent {
  id: string;
  name: string;
  type: AgentType;
  runtime: AgentRuntime;
  status: AgentStatus;
  capabilities: string[];
  createdAt: string;
  lastHeartbeat: string;
  /** Deployment id this agent belongs to (edge agents behind /d/{id}). */
  deploymentId?: string;
  /** Extra runtime-specific metadata (model, template, version...). */
  meta?: Record<string, unknown>;
}

// ─── Approvals (HITL) ────────────────────────────────────────────

/** Where an approval originates. */
export type ApprovalSource = "mastra" | "cloudflare" | "core" | "data";
export type RiskLevel = "low" | "medium" | "high" | "critical";
export type ApprovalStatus = "pending" | "approved" | "declined" | "expired";

export interface ApprovalRequest {
  id: string;
  source: ApprovalSource;
  agentId: string;
  /** Mastra suspended-run id. */
  runId?: string;
  /** Mastra tool-call id. */
  toolCallId?: string;
  /** Cloudflare edge approval id (pendingApprovals[] entry). */
  approvalId?: string;
  /** Data-plane row key (lead / reply / website). */
  rowKey?: string;
  /** Core VM task id awaiting input. */
  taskId?: string;
  toolName: string;
  arguments: Record<string, unknown>;
  risk: RiskLevel;
  summary: string;
  requestedAt: string;
  expiresAt: string | null;
  status: ApprovalStatus;
  deploymentId?: string;
}

export interface ApprovalDecision {
  approved: boolean;
  /** Optional edited arguments ("Edit & Approve"). */
  updatedArgs?: Record<string, unknown>;
  /** Optional free-text response (core task resume input). */
  input?: string;
}

// ─── Events ──────────────────────────────────────────────────────

export type AgentEventType =
  | "state_change"
  | "tool_call"
  | "approval_request"
  | "approval_resolved"
  | "message"
  | "error"
  | "classification_completed";

export interface AgentEvent {
  id: string;
  agentId: string;
  type: AgentEventType;
  payload: unknown;
  timestamp: string;
}

// ─── Edge steps (Cloudflare) ─────────────────────────────────────

export interface CallaStep {
  id: string;
  action: string;
  params: Record<string, unknown>;
  requiresApproval: boolean;
  risk?: RiskLevel;
  /** Approval window; the workflow expires the gate after this. */
  timeoutMs?: number;
}

export type StepResult =
  | { status: "completed"; stepId: string; output: unknown }
  | { status: "awaiting_approval"; stepId: string; approvalId: string }
  | { status: "declined"; stepId: string; approvalId: string }
  | { status: "expired"; stepId: string; approvalId: string }
  | { status: "failed"; stepId: string; error: string };

export interface PendingApproval {
  id: string;
  step: CallaStep;
  requestedAt: number;
  risk: RiskLevel;
  status: ApprovalStatus;
  decidedAt?: number;
}

export interface CompletedStep {
  stepId: string;
  action: string;
  output: unknown;
  completedAt: number;
}

/** Durable Object state for CallaEdgeAgent. */
export interface CallaState {
  status: AgentStatus;
  currentTask: string | null;
  pendingApprovals: PendingApproval[];
  completedSteps: CompletedStep[];
}

export const INITIAL_CALLA_STATE: CallaState = {
  status: "idle",
  currentTask: null,
  pendingApprovals: [],
  completedSteps: [],
};
