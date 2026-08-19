/**
 * AppError — Centralized Error Class
 * ──────────────────────────────────
 * Every error in the application is wrapped in AppError before
 * reaching the UI layer. This ensures:
 *
 *   1. Consistent error structure (code, message, severity, recovery)
 *   2. No raw Error objects leaking to components
 *   3. Errors are serializable for logging/telemetry
 *   4. Recovery actions are deterministic
 *
 * Usage:
 *   throw new AppError(ErrorCode.WS_CONNECTION_FAILED, { context: { agentId } })
 *   throw AppError.fromCaught(originalError, ErrorCode.NETWORK_REQUEST_FAILED)
 */

import {
  ErrorCode,
  ERROR_MESSAGES,
  ERROR_SEVERITY,
  ERROR_RECOVERY,
  type ErrorCodeValue,
  type ErrorSeverity,
  type RecoveryAction,
} from "../constants/errors";

export interface AppErrorOptions {
  /** Override the default message */
  message?: string;
  /** Additional context for debugging/logging */
  context?: Record<string, unknown>;
  /** The original error (if this wraps a caught error) */
  cause?: unknown;
  /** Whether this error has already been reported to the user */
  reported?: boolean;
}

export class AppError extends Error {
  readonly code: ErrorCodeValue;
  readonly severity: ErrorSeverity;
  readonly recovery: RecoveryAction;
  readonly context: Record<string, unknown>;
  readonly cause?: unknown;
  /** Whether this error has already been reported to the user (mutable) */
  reported: boolean;
  readonly timestamp: string;

  constructor(code: ErrorCodeValue, options?: AppErrorOptions) {
    const message = options?.message ?? ERROR_MESSAGES[code] ?? "An unexpected error occurred.";

    super(message);

    this.name = "AppError";
    this.code = code;
    this.severity = ERROR_SEVERITY[code] ?? "error";
    this.recovery = ERROR_RECOVERY[code] ?? "dismiss";
    this.context = options?.context ?? {};
    this.cause = options?.cause;
    this.reported = options?.reported ?? false;
    this.timestamp = new Date().toISOString();

    // Preserve stack trace (V8 engines)
    if (typeof Error.captureStackTrace === "function") {
      Error.captureStackTrace(this, AppError);
    }
  }

  /**
   * Wrap an unknown caught error into an AppError.
   * If the error is already an AppError, return as-is.
   * If it's a native Error, wrap it with the given code.
   * If it's unknown, use a generic code.
   */
  static fromCaught(error: unknown, code: ErrorCodeValue = ErrorCode.API_SERVER_ERROR): AppError {
    if (error instanceof AppError) {
      return error;
    }

    if (error instanceof Error) {
      return new AppError(code, {
        message: error.message,
        cause: error,
      });
    }

    // Non-Error throw (string, object, etc.)
    return new AppError(code, {
      message: typeof error === "string" ? error : "Unknown error occurred",
      cause: error,
    });
  }

  /**
   * Mark this error as reported (shown to user, logged, etc.)
   * Returns a new instance to maintain immutability.
   */
  markReported(): AppError {
    return new AppError(this.code, {
      message: this.message,
      context: this.context,
      cause: this.cause,
      reported: true,
    });
  }

  /**
   * Serialize for logging or telemetry.
   */
  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      severity: this.severity,
      recovery: this.recovery,
      context: this.context,
      timestamp: this.timestamp,
      stack: this.stack,
      cause: this.cause instanceof Error ? this.cause.message : this.cause,
    };
  }

  /**
   * Check if this error is fatal (should stop the world).
   */
  isFatal(): boolean {
    return this.severity === "fatal";
  }

  /**
   * Check if this error is recoverable with automatic action.
   */
  isRecoverable(): boolean {
    return this.recovery !== "none" && this.recovery !== "dismiss";
  }
}

// ─── Factory helpers for common patterns ─────────────────────────

export const AppErrors = {
  agentNotFound: (agentId: string): AppError =>
    new AppError(ErrorCode.AGENT_NOT_FOUND, {
      context: { agentId },
    }),

  connectionFailed: (agentId: string, cause?: unknown): AppError =>
    new AppError(ErrorCode.WS_CONNECTION_FAILED, {
      context: { agentId },
      cause,
    }),

  reconnectExhausted: (agentId: string, attempts: number): AppError =>
    new AppError(ErrorCode.WS_RECONNECT_EXHAUSTED, {
      context: { agentId, attempts },
    }),

  networkError: (url: string, cause?: unknown): AppError =>
    new AppError(ErrorCode.NETWORK_REQUEST_FAILED, {
      context: { url },
      cause,
    }),

  validationError: (field: string, value: unknown): AppError =>
    new AppError(ErrorCode.DATA_VALIDATION_FAILED, {
      context: { field, value },
      message: `Validation failed for field "${field}".`,
    }),

  viewNotFound: (viewId: string): AppError =>
    new AppError(ErrorCode.VIEW_NOT_FOUND, {
      context: { viewId },
    }),
};
