/**
 * Risk evaluator — flags risky tool calls in a completed run and appends a
 * `risk.flagged` row to the hash-chained audit log for each. Runs only when
 * the output actually contains tool calls.
 */
import { getCallaStore } from "../store/index.js";
import type { CallaEvaluator, EvalContext, EvalResult, EvalToolCall } from "./types.js";

export interface RiskFlag {
  toolName: string;
  toolCallId: string;
  risk: "high" | "medium";
}

/**
 * Risky-tool classifier:
 *  - send-external-email → high (outward-facing, HITL-gated)
 *  - delete-*            → high (destructive)
 *  - dispatch-edge-task  → medium baseline; high when the dispatched step
 *    itself carries step.requiresApproval (an edge HITL gate will fire).
 */
export function classifyToolRisk(tc: EvalToolCall): "high" | "medium" | null {
  const name = tc.toolName ?? "";
  if (name === "send-external-email") return "high";
  if (name.startsWith("delete-")) return "high";
  if (name === "dispatch-edge-task") {
    const args = (tc.args ?? {}) as { step?: { requiresApproval?: unknown } };
    return args?.step?.requiresApproval === true ? "high" : "medium";
  }
  return null;
}

export const riskEvaluator: CallaEvaluator = {
  name: "calla-risk-flag",
  description:
    "Flag risky tool calls (send-external-email, delete-*, approval-gated dispatch-edge-task) and append risk.flagged audit rows.",
  similes: ["tool risk scanner", "dangerous tool detector", "risk auditor"],

  validate(ctx: EvalContext): boolean {
    return (ctx.output.toolCalls?.length ?? 0) > 0;
  },

  async handler(ctx: EvalContext): Promise<EvalResult> {
    const store = getCallaStore();
    const flags: RiskFlag[] = [];
    for (const tc of ctx.output.toolCalls ?? []) {
      const risk = classifyToolRisk(tc);
      if (!risk) continue;
      flags.push({ toolName: tc.toolName, toolCallId: tc.toolCallId, risk });
    }

    for (const flag of flags) {
      await store.appendAudit({
        agentId: ctx.agentId,
        kind: "risk.flagged",
        entry: {
          toolName: flag.toolName,
          toolCallId: flag.toolCallId,
          risk: flag.risk,
          runId: ctx.runId ?? null,
          agentId: ctx.agentId,
        },
      });
    }

    return {
      success: true,
      values: {
        risky: flags.length > 0,
        tools: flags.map((f) => ({ toolName: f.toolName, risk: f.risk, toolCallId: f.toolCallId })),
      },
    };
  },
};
