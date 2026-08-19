/**
 * Hooks Barrel Export
 * ────────────────────
 * Single import point for all hooks.
 */

export { useToast, ToastProvider, toast, registerToastPusher } from "./useToast";

export { useLocalStorage } from "./useLocalStorage";

export { useAgentConnection } from "./useAgentConnection";
export type { UseAgentConnectionResult } from "./useAgentConnection";

export { useAgentHealth } from "./useAgentHealth";
export type { UseAgentHealthResult } from "./useAgentHealth";

export { useAgentInfo } from "./useAgentInfo";
export type { AgentInfo, UseAgentInfoResult } from "./useAgentInfo";

export { useRouter, buildAgentRoute } from "./useRouter";
export type { UseRouterResult } from "./useRouter";

export { useAsync } from "./useAsync";
export type { UseAsyncResult, UseAsyncOptions } from "./useAsync";

export { useTheme } from "./useTheme";
export type { ThemeMode, ResolvedTheme } from "./useTheme";

export { useKeyboardShortcuts } from "./useKeyboard";
export type { KeyboardShortcutHandlers } from "./useKeyboard";

export { useMediaQuery, useIsMobile, useIsTablet, useIsDesktop } from "./useMediaQuery";

export { useAuth, AuthProvider, getAuthToken } from "./useAuth";
export { authFetch, buildAuthedWsUrl } from "./useAuthFetch";
export type { AuthFetchOptions } from "./useAuthFetch";
export { useDeployments } from "./useDeployments";
export type { UseDeploymentsResult } from "./useDeployments";
