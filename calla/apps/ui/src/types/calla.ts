/**
 * Calla Shared Type Re-exports
 * ────────────────────────────
 * Canonical Calla entities live in @calla/shared (shared with the edge
 * worker and the Mastra brain). The UI imports them through this module
 * so pages have a single @/types entry point.
 */

export type {
  Agent,
  AgentType,
  AgentRuntime,
  AgentStatus,
  ApprovalRequest,
  ApprovalDecision,
  ApprovalSource,
  ApprovalStatus,
  RiskLevel,
  AgentEvent,
  AgentEventType,
  CallaStep,
  StepResult,
  PendingApproval,
  CompletedStep,
  CallaState,
  CallaWsFrame,
  CallaEventName,
  CallaControlName,
} from "@calla/shared";

export { CALLA_EVENTS, CALLA_CONTROL, callaFrame, INITIAL_CALLA_STATE } from "@calla/shared";
