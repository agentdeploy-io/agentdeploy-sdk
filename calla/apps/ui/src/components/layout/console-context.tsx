/**
 * Console data contexts
 * ─────────────────────
 * The shell owns exactly ONE /events WebSocket and ONE approval aggregator,
 * mounted by <ConsoleLayout>. Every screen (sidebar badge, fleet dashboard,
 * approval inbox) reads from these contexts instead of instantiating its own
 * hook — otherwise each consumer opens another socket and another poll loop
 * over the same four approval sources.
 *
 * Two separate contexts so an events frame doesn't re-render approval-only
 * consumers and vice versa.
 */

import { createContext, useContext, type ReactNode } from "react";
import {
  useApprovals,
  useCallaEvents,
  useDeploymentSelector,
  type UseApprovalsResult,
  type UseCallaEventsResult,
} from "@/hooks";

// ─── Events feed ─────────────────────────────────────────────────

const CallaEventsContext = createContext<UseCallaEventsResult | null>(null);

export function ConsoleEventsProvider({ children }: { children: ReactNode }) {
  const events = useCallaEvents();
  return <CallaEventsContext.Provider value={events}>{children}</CallaEventsContext.Provider>;
}

export function useConsoleEvents(): UseCallaEventsResult {
  const ctx = useContext(CallaEventsContext);
  if (!ctx) {
    throw new Error("useConsoleEvents must be used inside <ConsoleEventsProvider>");
  }
  return ctx;
}

// ─── Approvals ───────────────────────────────────────────────────

const ApprovalsContext = createContext<UseApprovalsResult | null>(null);

export function ConsoleApprovalsProvider({ children }: { children: ReactNode }) {
  const { deploymentId } = useDeploymentSelector();
  const approvals = useApprovals({ deploymentId });
  return <ApprovalsContext.Provider value={approvals}>{children}</ApprovalsContext.Provider>;
}

export function useConsoleApprovals(): UseApprovalsResult {
  const ctx = useContext(ApprovalsContext);
  if (!ctx) {
    throw new Error("useConsoleApprovals must be used inside <ConsoleApprovalsProvider>");
  }
  return ctx;
}
