/**
 * Error Handler — Centralized Error Processing
 * ────────────────────────────────────────────
 * Routes errors to the appropriate display mechanism (toast, inline,
 * modal) based on severity and context. This is the single entry
 * point for all error display in the application.
 *
 * Usage:
 *   errorHandler.handleError(error, { showToast: true })
 *   errorHandler.handleAsync(() => fetchSomething())
 */

import { AppError } from "./AppError";
import { ErrorCode, TOAST_CONFIG, type ErrorCodeValue } from "../constants/errors";
import type { Toast, ToastVariant } from "../types/ui";

// ─── Error Handler Config ────────────────────────────────────────

export interface HandleErrorOptions {
  /** Show a toast notification (default: true) */
  showToast?: boolean;
  /** Additional context to merge */
  context?: Record<string, unknown>;
  /** Override severity for display purposes */
  severityOverride?: ToastVariant;
  /** Agent ID for scoping the error */
  agentId?: string;
  /**
   * Error code to use when the error is not already an AppError.
   * If the error IS an AppError, its existing code takes precedence.
   */
  code?: ErrorCodeValue;
}

// ─── Listener Pattern ────────────────────────────────────────────

export type ErrorListener = (error: AppError, toast?: Toast) => void;

class ErrorHandler {
  private listeners: Set<ErrorListener> = new Set();

  /**
   * Subscribe to error events. Returns an unsubscribe function.
   */
  subscribe(listener: ErrorListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Process an error through the centralized handler.
   * This is the main entry point for all errors.
   */
  handleError(error: unknown, options?: HandleErrorOptions): AppError {
    // If the error is already an AppError, use it as-is.
    // Otherwise, wrap it with the caller-specified code (or default).
    const appError =
      error instanceof AppError
        ? error
        : AppError.fromCaught(error, options?.code ?? ErrorCode.API_SERVER_ERROR);

    // Merge additional context
    if (options?.context) {
      Object.assign(appError.context, options.context);
    }
    if (options?.agentId) {
      appError.context.agentId = options.agentId;
    }

    // Determine display variant
    const variant = options?.severityOverride ?? this.severityToVariant(appError.severity);

    // Build toast (if needed) — only if not already reported
    let toast: Toast | undefined;
    if (options?.showToast !== false && !appError.reported) {
      toast = this.buildToast(appError, variant);
      // Mark as reported so subsequent handleError calls for the same
      // error instance don't produce duplicate toasts.
      appError.reported = true;
    }

    // Notify listeners
    this.listeners.forEach((listener) => {
      try {
        listener(appError, toast);
      } catch (listenerError) {
        // Listener errors must not propagate
        console.error("[ErrorHandler] Listener threw:", listenerError);
      }
    });

    // Always log to console for debugging
    if (appError.severity === "fatal") {
      console.error("[ErrorHandler] Fatal error:", appError.toJSON());
    } else if (appError.severity === "error") {
      console.error("[ErrorHandler] Error:", appError.toJSON());
    } else if (appError.severity === "warning") {
      console.warn("[ErrorHandler] Warning:", appError.toJSON());
    }

    return appError;
  }

  /**
   * Wrap an async function with error handling.
   * Returns the result or null on error (error is dispatched to listeners).
   */
  async handleAsync<T>(
    fn: () => Promise<T>,
    options?: HandleErrorOptions & { fallbackValue?: T },
  ): Promise<T | null> {
    try {
      return await fn();
    } catch (error) {
      this.handleError(error, options);
      return options?.fallbackValue ?? null;
    }
  }

  /**
   * Create a toast from an AppError.
   */
  private buildToast(error: AppError, variant: ToastVariant): Toast {
    const duration = TOAST_CONFIG.duration[variant] ?? TOAST_CONFIG.duration.error;

    const action =
      error.recovery === "retry"
        ? { label: "Retry", type: "retry" as const }
        : error.recovery === "reload"
          ? { label: "Reload", type: "reload" as const }
          : error.recovery === "reconnect"
            ? { label: "Reconnect", type: "reconnect" as const }
            : error.recovery === "go-home"
              ? { label: "Go Home", type: "go-home" as const }
              : undefined;

    return {
      id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      variant,
      title: this.getErrorTitle(error.code),
      message: error.message,
      duration,
      createdAt: Date.now(),
      action,
    };
  }

  /**
   * Map error severity to toast variant.
   */
  private severityToVariant(severity: string): ToastVariant {
    switch (severity) {
      case "info":
        return "info";
      case "warning":
        return "warning";
      case "error":
        return "error";
      case "fatal":
        return "fatal";
      default:
        return "error";
    }
  }

  /**
   * Get a short, human-readable title for an error code.
   */
  private getErrorTitle(code: ErrorCodeValue): string {
    const titles: Partial<Record<ErrorCodeValue, string>> = {
      WS_CONNECTION_FAILED: "Connection Failed",
      WS_CONNECTION_TIMEOUT: "Connection Timeout",
      WS_RECONNECT_EXHAUSTED: "Reconnect Failed",
      WS_MESSAGE_SEND_FAILED: "Send Failed",
      WS_INVALID_MESSAGE: "Invalid Message",

      AGENT_NOT_FOUND: "Agent Not Found",
      AGENT_UNHEALTHY: "Agent Unhealthy",
      AGENT_RPC_FAILED: "Request Failed",
      AGENT_CONFIG_INVALID: "Invalid Configuration",
      AGENT_STATE_FETCH_FAILED: "State Unavailable",

      NETWORK_REQUEST_FAILED: "Network Error",
      NETWORK_TIMEOUT: "Request Timeout",
      API_NOT_FOUND: "Not Found",
      API_UNAUTHORIZED: "Unauthorized",
      API_RATE_LIMITED: "Rate Limited",
      API_SERVER_ERROR: "Server Error",

      DATA_LOAD_FAILED: "Load Failed",
      DATA_SAVE_FAILED: "Save Failed",
      DATA_VALIDATION_FAILED: "Validation Error",
      STORAGE_QUOTA_EXCEEDED: "Storage Full",

      VIEW_NOT_FOUND: "View Not Found",
      COMPONENT_RENDER_ERROR: "Render Error",
      FORM_VALIDATION_ERROR: "Validation Error",

      ACTION_UNAUTHORIZED: "Not Allowed",
      ACTION_CANCELLED: "Cancelled",
      INVALID_INPUT: "Invalid Input",
    };
    return titles[code] ?? "Error";
  }
}

// ─── Singleton Export ────────────────────────────────────────────

export const errorHandler = new ErrorHandler();
