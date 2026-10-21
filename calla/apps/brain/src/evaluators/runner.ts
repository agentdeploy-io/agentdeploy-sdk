/**
 * Evaluator runner — two-phase evaluation adapted from ElizaOS core
 * runtime.evaluate() (MIT):
 *   phase 1 (filter): keep evaluators with alwaysRun || didRespond, then run
 *           validate(ctx) — cheap gates only;
 *   phase 2 (execute): run survivors' handlers IN PARALLEL
 *           (Promise.allSettled) and collect outcomes.
 *
 * runEvaluators NEVER throws into the request path. Every evaluator failure
 * (validate or handler) appends a `evaluator.error` row to the hash-chained
 * audit log — best-effort: even audit failures are swallowed and logged.
 */
import { getCallaStore } from "../store/index.js";
import { errorMessage } from "../lib/serialize.js";
import type { CallaEvaluator, EvalContext, EvalOutcome } from "./types.js";
import { auditEvaluator } from "./audit-evaluator.js";
import { riskEvaluator } from "./risk-evaluator.js";

/** The default Calla evaluator set, wired into generate + stream. */
export const defaultEvaluators: CallaEvaluator[] = [auditEvaluator, riskEvaluator];

async function recordEvaluatorError(
  evaluatorName: string,
  phase: "validate" | "handler",
  err: unknown,
  ctx: EvalContext,
): Promise<void> {
  try {
    await getCallaStore().appendAudit({
      agentId: ctx.agentId,
      kind: "evaluator.error",
      entry: {
        evaluator: evaluatorName,
        phase,
        error: errorMessage(err),
        runId: ctx.runId ?? null,
        agentId: ctx.agentId,
      },
    });
  } catch (auditErr) {
    console.error(
      `[calla-brain] evaluator ${evaluatorName} failed AND its audit row could not be written:`,
      auditErr,
    );
  }
}

export async function runEvaluators(
  evaluators: CallaEvaluator[],
  ctx: EvalContext,
): Promise<EvalOutcome[]> {
  const outcomes: EvalOutcome[] = [];
  const didRespond = Boolean(ctx.output.text) || (ctx.output.toolCalls?.length ?? 0) > 0;

  // ─── Phase 1: filter ──────────────────────────────────────────
  const survivors: CallaEvaluator[] = [];
  for (const ev of evaluators) {
    try {
      if (!(ev.alwaysRun || didRespond)) {
        outcomes.push({ evaluator: ev.name, status: "skipped" });
        continue;
      }
      if (await ev.validate(ctx)) {
        survivors.push(ev);
      } else {
        outcomes.push({ evaluator: ev.name, status: "skipped" });
      }
    } catch (err) {
      await recordEvaluatorError(ev.name, "validate", err, ctx);
      outcomes.push({ evaluator: ev.name, status: "error", error: errorMessage(err) });
    }
  }

  // ─── Phase 2: run survivors in parallel ───────────────────────
  const settled = await Promise.allSettled(survivors.map((ev) => ev.handler(ctx)));
  settled.forEach((outcome, i) => {
    const ev = survivors[i];
    if (outcome.status === "fulfilled") {
      outcomes.push({ evaluator: ev.name, status: "ok", result: outcome.value });
    } else {
      // Audit asynchronously; never let this reject.
      void recordEvaluatorError(ev.name, "handler", outcome.reason, ctx);
      outcomes.push({ evaluator: ev.name, status: "error", error: errorMessage(outcome.reason) });
    }
  });

  return outcomes;
}

/** Fire-and-forget helper: evaluators must never break the LLM request path. */
export function fireEvaluators(
  ctx: EvalContext,
  evaluators: CallaEvaluator[] = defaultEvaluators,
): void {
  void runEvaluators(evaluators, ctx).catch((err) => {
    console.error("[calla-brain] evaluator run failed:", err);
  });
}
