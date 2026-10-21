import { createStep, createWorkflow } from "@mastra/core/workflows";
import { z } from "zod";
import { CALLA_EVENTS, type RiskLevel } from "@calla/shared";
import { getCallaStore } from "../../store/index.js";

/**
 * Gate pattern adapted from chrislema/mastra-builder (deliveryDeploymentWorkflow):
 * suspend() carries a resumeLabel, the resume schema captures the APPROVER
 * identity + notes, and every gate transition is written to a durable event
 * log (here: Calla's hash-chained audit store) before/after suspension.
 */

/** Resume label clients pass to run.resume({label}) — stable public contract. */
export const APPROVAL_RESUME_LABEL = "approve-calla-gate";

/** Default approval window before escalation (24h), per spec §5 "Timeout & Escalation". */
export const DEFAULT_APPROVAL_WINDOW_MS = 24 * 60 * 60 * 1000;

const riskLevels: [RiskLevel, ...RiskLevel[]] = ["low", "medium", "high", "critical"];

export const approvalInputSchema = z.object({
  approvalId: z.string().min(1).describe("Correlates with the unified ApprovalRequest id in the UI."),
  reason: z.string().min(1).describe("Why human approval is required."),
  summary: z.string().optional().describe("Human-readable summary shown on the approval card."),
  risk: z.enum(riskLevels).default("medium"),
  agentId: z.string().optional(),
  timeoutMs: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_APPROVAL_WINDOW_MS)
    .describe("Approval window; escalation fires when the window closes without approval."),
});

/** Payload persisted with the suspended snapshot — surfaced in the UI approval inbox. */
export const approvalSuspendSchema = z.object({
  reason: z.string(),
  requestedAt: z.string(),
  approvalId: z.string(),
});

/** Resume payload the UI/decision endpoint sends back. */
export const approvalResumeSchema = z.object({
  approved: z.boolean(),
  /** WHO decided — persisted to the decision + audit chain (mastra-builder pattern). */
  approver: z.string().optional(),
  /** Optional approval context / decline reason. */
  notes: z.string().optional(),
  /** Back-compat alias for notes. */
  input: z.string().optional(),
});

export const approvalDecisionSchema = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
  approver: z.string().optional(),
  input: z.string().optional(),
  risk: z.enum(riskLevels),
  timeoutMs: z.number(),
  requestedAt: z.string(),
  decidedAt: z.string(),
});

export const approvalOutcomeSchema = z.object({
  approvalId: z.string(),
  approved: z.boolean(),
  escalated: z.boolean(),
  approver: z.string().optional(),
  note: z.string(),
});

/**
 * Stub secondary-approver notification. In production this pages/email the
 * on-call approver (e.g. via the event bus / an integration); here it only
 * records a structured log line.
 */
export async function notifySecondaryApprover(
  approvalId: string,
  detail: { reason: string; risk: RiskLevel; timeoutMs: number; requestedAt: string },
): Promise<{ notified: boolean; channel: string; secondaryApprover: string }> {
  const secondaryApprover = process.env.CALLA_SECONDARY_APPROVER ?? "secondary-approver@calla.local";
  console.log(
    JSON.stringify({
      level: "warn",
      service: "calla-brain",
      workflow: "approval-with-escalation",
      event: CALLA_EVENTS.approvalRequest,
      escalation: true,
      approvalId,
      secondaryApprover,
      ...detail,
      escalatedAt: new Date().toISOString(),
      note: "STUB notifySecondaryApprover — integrate a real paging/email channel here.",
    }),
  );
  return { notified: true, channel: "log", secondaryApprover };
}

/**
 * Best-effort durable gate event → hash-chained audit store.
 * Mirrors mastra-builder's appendDeliveryEventState: every human-input
 * transition is persisted so gates are reconstructable after restarts.
 */
async function auditGate(
  kind: "gate.suspended" | "gate.decided" | "gate.escalated",
  entry: Record<string, unknown>,
): Promise<void> {
  try {
    await getCallaStore().appendAudit({ kind, entry });
  } catch (err) {
    console.warn(`[calla-brain] auditGate(${kind}) failed (non-fatal):`, err);
  }
}

/**
 * Step 1 — request approval: suspends the run with {reason, requestedAt,
 * approvalId} until a human resumes it with {approved, approver?, notes?}.
 * The snapshot is persisted to storage, so the suspension survives restarts
 * and shows up in the HITL inbox.
 */
export const requestApprovalStep = createStep({
  id: "request-approval",
  description: `Suspend until a human approves or declines; resume with { approved, approver?, notes? } (label: ${APPROVAL_RESUME_LABEL}).`,
  inputSchema: approvalInputSchema,
  outputSchema: approvalDecisionSchema,
  suspendSchema: approvalSuspendSchema,
  resumeSchema: approvalResumeSchema,
  execute: async ({ inputData, resumeData, suspendData, suspend }) => {
    if (resumeData) {
      const decidedAt = new Date().toISOString();
      await auditGate("gate.decided", {
        approvalId: inputData.approvalId,
        approved: resumeData.approved,
        approver: resumeData.approver ?? null,
        notes: resumeData.notes ?? resumeData.input ?? null,
        risk: inputData.risk,
        requestedAt: suspendData?.requestedAt ?? null,
        decidedAt,
      });
      return {
        approvalId: inputData.approvalId,
        approved: resumeData.approved,
        approver: resumeData.approver,
        input: resumeData.notes ?? resumeData.input,
        risk: inputData.risk,
        timeoutMs: inputData.timeoutMs,
        requestedAt: suspendData?.requestedAt ?? new Date().toISOString(),
        decidedAt,
      };
    }

    const requestedAt = new Date().toISOString();
    await auditGate("gate.suspended", {
      approvalId: inputData.approvalId,
      reason: inputData.reason,
      summary: inputData.summary ?? null,
      risk: inputData.risk,
      agentId: inputData.agentId ?? null,
      timeoutMs: inputData.timeoutMs,
      requestedAt,
      resumeLabel: APPROVAL_RESUME_LABEL,
    });

    return await suspend(
      {
        reason: inputData.reason,
        requestedAt,
        approvalId: inputData.approvalId,
      },
      { resumeLabel: APPROVAL_RESUME_LABEL },
    );
  },
});

/**
 * Step 2 — escalate: when the window closed without approval, notify the
 * secondary approver (stub). Approved requests pass straight through.
 */
export const escalateStep = createStep({
  id: "escalate",
  description: "Escalate to the secondary approver when the request was not approved.",
  inputSchema: approvalDecisionSchema,
  outputSchema: approvalOutcomeSchema,
  execute: async ({ inputData }) => {
    if (inputData.approved) {
      return {
        approvalId: inputData.approvalId,
        approved: true,
        escalated: false,
        approver: inputData.approver,
        note: `Approval ${inputData.approvalId} granted by ${inputData.approver ?? "the primary approver"} within the ${inputData.timeoutMs}ms window; no escalation needed.`,
      };
    }

    await notifySecondaryApprover(inputData.approvalId, {
      reason: inputData.input ?? "Approval window closed without approval.",
      risk: inputData.risk,
      timeoutMs: inputData.timeoutMs,
      requestedAt: inputData.requestedAt,
    });
    await auditGate("gate.escalated", {
      approvalId: inputData.approvalId,
      risk: inputData.risk,
      declinedBy: inputData.approver ?? null,
      notes: inputData.input ?? null,
    });

    return {
      approvalId: inputData.approvalId,
      approved: false,
      escalated: true,
      approver: inputData.approver,
      note: `Approval ${inputData.approvalId} was not granted within the ${inputData.timeoutMs}ms window; secondary approver notified (stub).`,
    };
  },
});

/**
 * HITL approval workflow with escalation (spec §5 "Timeout & Escalation").
 *
 * createRun().start({inputData}) runs until request-approval suspends;
 * run.resume({resumeData: {approved, input?}, step: 'request-approval'})
 * continues into the escalate step.
 */
export const approvalWithEscalation = createWorkflow({
  id: "approval-with-escalation",
  description:
    "Human-in-the-loop approval gate: suspends for a decision, then escalates to a secondary approver when the request was not approved within the window.",
  inputSchema: approvalInputSchema,
  outputSchema: approvalOutcomeSchema,
})
  .then(requestApprovalStep)
  .then(escalateStep)
  .commit();
