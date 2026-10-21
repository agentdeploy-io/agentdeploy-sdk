/**
 * Audit evaluator — alwaysRun. Appends a `run.completed` row to the
 * hash-chained audit log for every LLM run (generate or stream), giving the
 * brain a tamper-evident execution history independent of Mastra's storage.
 */
import { getCallaStore } from "../store/index.js";
import type { CallaEvaluator, EvalContext, EvalResult } from "./types.js";

export const auditEvaluator: CallaEvaluator = {
  name: "calla-run-audit",
  description:
    "Append a hash-chained run.completed audit entry after every LLM run (runId, agentId, finishReason, tool calls, output size, duration).",
  similes: ["run logger", "execution audit trail", "hash chain recorder"],
  alwaysRun: true,

  validate(_ctx: EvalContext): boolean {
    return true;
  },

  async handler(ctx: EvalContext): Promise<EvalResult> {
    const store = getCallaStore();
    const toolCallNames = (ctx.output.toolCalls ?? []).map((tc) => tc.toolName).filter(Boolean);
    const record = await store.appendAudit({
      agentId: ctx.agentId,
      kind: "run.completed",
      entry: {
        runId: ctx.runId ?? null,
        agentId: ctx.agentId,
        finishReason: ctx.output.finishReason ?? null,
        toolCallNames,
        outputChars: (ctx.output.text ?? "").length,
        durationMs: ctx.durationMs,
        threadId: ctx.threadId ?? null,
        resourceId: ctx.resourceId ?? null,
      },
    });
    return {
      success: true,
      values: { audited: true, seq: record.seq, entryHash: record.entryHash },
    };
  },
};
