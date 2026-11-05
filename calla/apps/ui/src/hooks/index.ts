/**
 * Hooks Barrel Export
 * ────────────────────
 * Single import point for all hooks: @/hooks
 */

// ─── Toasts ──────────────────────────────────────────────────────
export { useToast, ToastProvider, toast, registerToastPusher } from "./useToast";
export type { ToastContextValue } from "./useToast";

// ─── Auth ────────────────────────────────────────────────────────
export { useAuth, AuthProvider, getAuthToken } from "./useAuth";
export type { AuthActionResult } from "./useAuth";
export { authFetch, getEdgeJwt, buildAuthedWsUrl } from "./useAuthFetch";
export type { AuthFetchOptions } from "./useAuthFetch";

// ─── Routing ─────────────────────────────────────────────────────
export {
  useRouter,
  buildAgentRoute,
  buildInboxRoute,
  buildFleetRoute,
  VALID_VIEWS,
  DEFAULT_AGENT_TAB,
} from "./useRouter";
export type { UseRouterResult } from "./useRouter";

// ─── Generic utilities ───────────────────────────────────────────
export { useLocalStorage } from "./useLocalStorage";
export { useAsync } from "./useAsync";
export type { UseAsyncResult, UseAsyncOptions } from "./useAsync";
export { useTheme } from "./useTheme";
export type { ThemeMode, ResolvedTheme } from "./useTheme";
export { useKeyboardShortcuts } from "./useKeyboard";
export type { KeyboardShortcutHandlers } from "./useKeyboard";
export { useMediaQuery, useIsMobile, useIsTablet, useIsDesktop } from "./useMediaQuery";

// ─── Registry & deployments ──────────────────────────────────────
export { useDeployments } from "./useDeployments";
export type { UseDeploymentsResult } from "./useDeployments";
export { AgentRegistryProvider, useAgentRegistry } from "./useAgentRegistry";
export type { AgentRegistryContextValue } from "./useAgentRegistry";
export { DeploymentSelectorProvider, useDeploymentSelector } from "./useDeploymentSelector";

// ─── Agent runtime ───────────────────────────────────────────────
export { useAgentConnection } from "./useAgentConnection";
export type { UseAgentConnectionResult, AgentCommand } from "./useAgentConnection";
export { useAgentHealth } from "./useAgentHealth";
export type { UseAgentHealthResult } from "./useAgentHealth";
export { useAgentInfo } from "./useAgentInfo";
export type { AgentInfo, UseAgentInfoResult } from "./useAgentInfo";

// ─── Calla event feed & approvals ────────────────────────────────
export {
  useCallaEvents,
  buildCallaEventsUrl,
  normalizeCallaFrame,
  EVENTS_BUFFER_LIMIT,
} from "./useCallaEvents";
export type {
  CallaEventsStatus,
  UseCallaEventsOptions,
  UseCallaEventsResult,
} from "./useCallaEvents";
export { useApprovals } from "./useApprovals";
export type {
  ApprovalCounts,
  UseApprovalsOptions,
  UseApprovalsResult,
} from "./useApprovals";

// ─── Data plane (/d/{id} proxy) ──────────────────────────────────
export {
  useLeads,
  useLeadDetail,
  useUpdateLead,
  useSendLead,
  useTestSend,
  useBulkAction,
  useDeleteRows,
  useExportCsv,
  useImportCsv,
  usePipeline,
  useRuns,
  useSchedules,
  useScheduleActions,
  useWire,
  useSettings,
  useSecrets,
} from "./useDataApi";
export type {
  DataFilters,
  DataPage,
  PipelineStage,
  PipelineData,
  RunEntry,
  PipelineStatus,
  ImportDryRun,
  ScheduleEntry,
  WireTopology,
  SettingsData,
  SecretEntry,
  SendResult,
} from "./useDataApi";

// ─── Core (Fly.io VM) plane ──────────────────────────────────────
export { useCoreDeployment } from "./useCoreDeployment";
export type {
  CoreTask,
  CoreSupervision,
  CoreEvent,
  UseCoreDeploymentResult,
} from "./useCoreDeployment";
export { useCoreDeployments } from "./useCoreDeployments";
export type { CoreDeploymentSummary, UseCoreDeploymentsResult } from "./useCoreDeployments";
