/**
 * Lib Barrel Export
 * ─────────────────
 * Single import point for the logic layer: @/lib
 */

export {
  showAuthTransition,
  redirectWithAuthTransition,
  hideAuthTransition,
} from "./auth-transition";

export { renderMarkdown } from "./markdown";

export {
  getVoiceStatus,
  transcribeAudio,
  synthesizeSpeech,
  pickRecordingMimeType,
  stripMarkdownForSpeech,
  type VoiceStatus,
} from "./voice";

export {
  CRON_PRESETS,
  validateCron,
  cronToHumanReadable,
  getNextRun,
  type CronPreset,
} from "./cron";

export {
  createMastraClient,
  mastraClient,
  suspendedRunToApproval,
  type MastraClient,
  type MastraChatMessage,
  type MastraStreamChunk,
  type SuspendedRun,
  type ToolCallDecisionInput,
} from "./mastra-client";

export {
  createSkillsClient,
  skillsClient,
  SKILLS_CLIENT_DISABLED,
  type SkillsClient,
  type CreateSkillInput,
  type UpdateSkillInput,
  type CreateConfigInput,
  type UpdateConfigInput,
  type ResolvedSkillEntry,
  type ResolvedSkillsResponse,
} from "./skills-client";

export {
  createOpsClient,
  opsClient,
  OPS_CLIENT_DISABLED,
  type OpsClient,
  type OpsResult,
  type FlowRun,
  type FlowRunRouting,
  type Appointment,
  type AuditEntry,
  type AuditKindCount,
} from "./ops-client";

export {
  createConversationsClient,
  conversationsClient,
  mapConversationFlowRun,
  CONVERSATIONS_CLIENT_DISABLED,
  type ConversationsClient,
  type ConversationsResult,
  type ConversationPlatform,
  type ConversationMessageKind,
  type ConversationSummary,
  type ConversationListData,
  type ConversationMessage,
  type ConversationContact,
  type ConversationLead,
  type ConversationFlowRouting,
  type ConversationFlowRun,
  type ConversationDetail,
  type SendMessageData,
  type SetTakeoverData,
  type RemoveConversationData,
} from "./conversations-client";

export {
  createEdgeClient,
  edgeClient,
  type EdgeClient,
  type EdgeClientOptions,
  type ApprovalDecisionInput,
} from "./edge-client";

export {
  WsLifecycleManager,
  type WsState,
  type WsJitter,
  type WsStats,
  type WsSendResult,
  type WsOpenInfo,
  type WsErrorInfo,
  type WsListener,
  type WsLifecycleOptions,
  type WsHeartbeatConfig,
  type WsBackoffConfig,
  type WsQueueConfig,
} from "./ws-lifecycle";

export {
  acquireManager,
  resetWsRegistry,
  wsRegistrySize,
  type AcquiredManager,
} from "./ws-registry";
