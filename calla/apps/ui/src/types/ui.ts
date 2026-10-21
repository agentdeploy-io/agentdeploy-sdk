/**
 * UI Type Definitions
 * ───────────────────
 * Minimal types for views, navigation, toasts, and async state.
 * Calla's route grammar is intentionally small — pages are built by
 * the shell team on top of these.
 */

import type { RecoveryAction } from "@/constants/errors";

// ─── View Identifiers ────────────────────────────────────────────

export type ViewId =
  | "fleet"
  | "data"
  | "inbox"
  | "conversations"
  | "reports"
  | "calls"
  | "setup"
  | "agent-detail"
  | "not-found";

// ─── Route ───────────────────────────────────────────────────────

export interface Route {
  view: ViewId;
  /** Agent ID when view === "agent-detail" */
  agentId?: string;
  /** Tab within agent detail view (defaults to "chat") */
  tab?: string;
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
