/**
 * UI Type Definitions
 * ───────────────────
 * Types for views, navigation, toasts, and UI state.
 */

import type { ErrorSeverity, RecoveryAction } from "../constants/errors";
import type { ButtonVariant, BadgeVariant } from "../constants/theme";

// ─── View Identifiers ────────────────────────────────────────────

export type ViewId =
  | "overview"
  | "agents"
  | "agent-detail"
  | "conversations"
  | "workers"
  | "config"
  | "observability"
  | "settings"
  | "not-found";

// ─── Route Params ────────────────────────────────────────────────

export interface RouteParams {
  view: ViewId;
  /** Agent ID when view === "agent-detail" */
  agentId?: string;
  /** Tab within agent detail view */
  tab?: string;
  /** Optional sub-id (e.g., conversation ID) */
  subId?: string;
}

// ─── Toast ───────────────────────────────────────────────────────

export type ToastVariant = "info" | "success" | "warning" | "error" | "fatal";

export interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  message: string;
  /** Auto-dismiss duration in ms (0 = persistent) */
  duration: number;
  /** Timestamp created */
  createdAt: number;
  /** Optional action button */
  action?: {
    label: string;
    type: RecoveryAction;
  };
}

// ─── Loading State ───────────────────────────────────────────────

export type LoadingState = "idle" | "loading" | "success" | "error";

export interface AsyncState<T> {
  data: T | null;
  status: LoadingState;
  error: string | null;
}

// ─── Table Types ─────────────────────────────────────────────────

export interface TableColumn<T = unknown> {
  key: keyof T | string;
  label: string;
  width?: string;
  align?: "left" | "center" | "right";
  sortable?: boolean;
  /** Custom render function */
  render?: (value: unknown, row: T) => React.ReactNode;
}

export type SortDirection = "asc" | "desc";

export interface SortState {
  column: string;
  direction: SortDirection;
}

// ─── Form Types ──────────────────────────────────────────────────

export interface FormField<T = string> {
  value: T;
  error: string | null;
  touched: boolean;
}

export type FormState<T extends Record<string, unknown>> = {
  [K in keyof T]: FormField<T[K]>;
};

// ─── Modal / Dialog ──────────────────────────────────────────────

export interface ModalConfig {
  id: string;
  title: string;
  description?: string;
  variant: "default" | "destructive";
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm?: () => void;
  onCancel?: () => void;
}

// ─── Empty State ─────────────────────────────────────────────────

export interface EmptyStateConfig {
  icon: string;
  title: string;
  message: string;
  action?: {
    label: string;
    onClick: () => void;
  };
}

// ─── Re-exports for convenience ──────────────────────────────────

export type { ButtonVariant, BadgeVariant, ErrorSeverity };
