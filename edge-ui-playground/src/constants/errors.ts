/**
 * Error Constants & Codes
 * ───────────────────────
 * Centralized error code registry. Every error in the application
 * uses one of these codes. This ensures:
 *   1. Consistent error messages across the UI
 *   2. No hardcoded error strings in components
 *   3. Easy to audit and update messaging
 *   4. Internationalization-ready (swap the messages here)
 *
 * 12factor.net: Error messages are config, not hardcoded in views.
 */

// ─── Error Codes ─────────────────────────────────────────────────

export const ErrorCode = {
  // Connection errors (1xxx)
  WS_CONNECTION_FAILED: "WS_CONNECTION_FAILED",
  WS_CONNECTION_TIMEOUT: "WS_CONNECTION_TIMEOUT",
  WS_RECONNECT_EXHAUSTED: "WS_RECONNECT_EXHAUSTED",
  WS_MESSAGE_SEND_FAILED: "WS_MESSAGE_SEND_FAILED",
  WS_INVALID_MESSAGE: "WS_INVALID_MESSAGE",

  // Agent errors (2xxx)
  AGENT_NOT_FOUND: "AGENT_NOT_FOUND",
  AGENT_UNHEALTHY: "AGENT_UNHEALTHY",
  AGENT_RPC_FAILED: "AGENT_RPC_FAILED",
  AGENT_CONFIG_INVALID: "AGENT_CONFIG_INVALID",
  AGENT_STATE_FETCH_FAILED: "AGENT_STATE_FETCH_FAILED",

  // Network/API errors (3xxx)
  NETWORK_REQUEST_FAILED: "NETWORK_REQUEST_FAILED",
  NETWORK_TIMEOUT: "NETWORK_TIMEOUT",
  API_NOT_FOUND: "API_NOT_FOUND",
  API_UNAUTHORIZED: "API_UNAUTHORIZED",
  API_RATE_LIMITED: "API_RATE_LIMITED",
  API_SERVER_ERROR: "API_SERVER_ERROR",

  // Data/persistence errors (4xxx)
  DATA_LOAD_FAILED: "DATA_LOAD_FAILED",
  DATA_SAVE_FAILED: "DATA_SAVE_FAILED",
  DATA_VALIDATION_FAILED: "DATA_VALIDATION_FAILED",
  STORAGE_QUOTA_EXCEEDED: "STORAGE_QUOTA_EXCEEDED",

  // UI/render errors (5xxx)
  VIEW_NOT_FOUND: "VIEW_NOT_FOUND",
  COMPONENT_RENDER_ERROR: "COMPONENT_RENDER_ERROR",
  FORM_VALIDATION_ERROR: "FORM_VALIDATION_ERROR",

  // User action errors (6xxx)
  ACTION_UNAUTHORIZED: "ACTION_UNAUTHORIZED",
  ACTION_CANCELLED: "ACTION_CANCELLED",
  INVALID_INPUT: "INVALID_INPUT",
} as const;

export type ErrorCodeValue = (typeof ErrorCode)[keyof typeof ErrorCode];

// ─── Error Messages ──────────────────────────────────────────────

export const ERROR_MESSAGES: Record<ErrorCodeValue, string> = {
  // Connection
  WS_CONNECTION_FAILED: "Failed to connect to the agent. Please check your network connection.",
  WS_CONNECTION_TIMEOUT: "Connection timed out. The agent may be starting up or unreachable.",
  WS_RECONNECT_EXHAUSTED: "Unable to reconnect after multiple attempts. The agent appears to be down.",
  WS_MESSAGE_SEND_FAILED: "Failed to send message. The connection may have been interrupted.",
  WS_INVALID_MESSAGE: "Received a malformed message from the agent.",

  // Agent
  AGENT_NOT_FOUND: "The requested agent could not be found. It may have been removed.",
  AGENT_UNHEALTHY: "The agent is not responding to health checks.",
  AGENT_RPC_FAILED: "The agent failed to process this request.",
  AGENT_CONFIG_INVALID: "The agent configuration contains invalid values.",
  AGENT_STATE_FETCH_FAILED: "Failed to retrieve the agent's current state.",

  // Network/API
  NETWORK_REQUEST_FAILED: "Network request failed. Please check your internet connection.",
  NETWORK_TIMEOUT: "Request timed out. The server took too long to respond.",
  API_NOT_FOUND: "The requested resource was not found.",
  API_UNAUTHORIZED: "You are not authorized to perform this action.",
  API_RATE_LIMITED: "Too many requests. Please wait a moment and try again.",
  API_SERVER_ERROR: "The server encountered an unexpected error.",

  // Data
  DATA_LOAD_FAILED: "Failed to load data. Please try refreshing.",
  DATA_SAVE_FAILED: "Failed to save changes. Please try again.",
  DATA_VALIDATION_FAILED: "The data contains validation errors.",
  STORAGE_QUOTA_EXCEEDED: "Local storage is full. Some data may not persist.",

  // UI
  VIEW_NOT_FOUND: "This view could not be found. It may have been moved or renamed.",
  COMPONENT_RENDER_ERROR: "Something went wrong while rendering this component.",
  FORM_VALIDATION_ERROR: "Please correct the highlighted fields and try again.",

  // User actions
  ACTION_UNAUTHORIZED: "You don't have permission to perform this action.",
  ACTION_CANCELLED: "This action was cancelled.",
  INVALID_INPUT: "Please check your input and try again.",
};

// ─── Error Severity ──────────────────────────────────────────────

export type ErrorSeverity = "info" | "warning" | "error" | "fatal";

export const ERROR_SEVERITY: Record<ErrorCodeValue, ErrorSeverity> = {
  WS_CONNECTION_FAILED: "error",
  WS_CONNECTION_TIMEOUT: "warning",
  WS_RECONNECT_EXHAUSTED: "error",
  WS_MESSAGE_SEND_FAILED: "error",
  WS_INVALID_MESSAGE: "warning",

  AGENT_NOT_FOUND: "error",
  AGENT_UNHEALTHY: "warning",
  AGENT_RPC_FAILED: "error",
  AGENT_CONFIG_INVALID: "warning",
  AGENT_STATE_FETCH_FAILED: "error",

  NETWORK_REQUEST_FAILED: "error",
  NETWORK_TIMEOUT: "warning",
  API_NOT_FOUND: "error",
  API_UNAUTHORIZED: "error",
  API_RATE_LIMITED: "warning",
  API_SERVER_ERROR: "error",

  DATA_LOAD_FAILED: "error",
  DATA_SAVE_FAILED: "error",
  DATA_VALIDATION_FAILED: "warning",
  STORAGE_QUOTA_EXCEEDED: "warning",

  VIEW_NOT_FOUND: "error",
  COMPONENT_RENDER_ERROR: "fatal",
  FORM_VALIDATION_ERROR: "warning",

  ACTION_UNAUTHORIZED: "error",
  ACTION_CANCELLED: "info",
  INVALID_INPUT: "warning",
};

// ─── Error Recovery Actions ──────────────────────────────────────

export type RecoveryAction = "retry" | "reload" | "reconnect" | "go-home" | "dismiss" | "none";

export const ERROR_RECOVERY: Record<ErrorCodeValue, RecoveryAction> = {
  WS_CONNECTION_FAILED: "reconnect",
  WS_CONNECTION_TIMEOUT: "retry",
  WS_RECONNECT_EXHAUSTED: "reload",
  WS_MESSAGE_SEND_FAILED: "retry",
  WS_INVALID_MESSAGE: "dismiss",

  AGENT_NOT_FOUND: "go-home",
  AGENT_UNHEALTHY: "retry",
  AGENT_RPC_FAILED: "retry",
  AGENT_CONFIG_INVALID: "dismiss",
  AGENT_STATE_FETCH_FAILED: "retry",

  NETWORK_REQUEST_FAILED: "retry",
  NETWORK_TIMEOUT: "retry",
  API_NOT_FOUND: "go-home",
  API_UNAUTHORIZED: "dismiss",
  API_RATE_LIMITED: "retry",
  API_SERVER_ERROR: "retry",

  DATA_LOAD_FAILED: "retry",
  DATA_SAVE_FAILED: "retry",
  DATA_VALIDATION_FAILED: "dismiss",
  STORAGE_QUOTA_EXCEEDED: "dismiss",

  VIEW_NOT_FOUND: "go-home",
  COMPONENT_RENDER_ERROR: "reload",
  FORM_VALIDATION_ERROR: "dismiss",

  ACTION_UNAUTHORIZED: "dismiss",
  ACTION_CANCELLED: "dismiss",
  INVALID_INPUT: "dismiss",
};

// ─── Toast Configuration ─────────────────────────────────────────

export const TOAST_CONFIG = {
  duration: {
    info: 4000,
    success: 3000,
    warning: 6000,
    error: 8000,
    fatal: 0, // persistent until dismissed
  },
  maxVisible: 3,
} as const;

// ─── Validation Patterns ─────────────────────────────────────────

export const VALIDATION_PATTERNS = {
  agentId: /^[a-z0-9-]+$/,
  cronExpression: /^(\*|([0-5]?\d)|([0-5]?\d-[0-5]?\d)|([0-5]?\d\/[0-5]?\d))\s+(\*|([01]?\d|2[0-3])|([01]?\d-2[0-3]|2[0-3]-2[0-3])|([01]?\d\/[01]?\d))\s+(\*|([1-9]|[12]\d|3[01])|([1-9]-[12]\d|3[01]))\s+(\*|([1-9]|1[0-2])|([1-9]-1[0-2]))\s+(\*|[0-6])$/,
  url: /^https?:\/\/.+/,
  port: /^(?:[1-9]\d{0,3}|[1-5]\d{4}|6[0-4]\d{3}|65[0-4]\d{2}|655[0-2]\d|6553[0-5])$/,
} as const;

export const VALIDATION_LIMITS = {
  agentNameMin: 2,
  agentNameMax: 64,
  descriptionMax: 256,
  messageMax: 4000,
  cronMinInterval: 60, // seconds — don't allow sub-minute crons
  maxReconnectAttempts: 10,
} as const;
