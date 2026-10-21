import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import type { ApprovalWorkflowParams, Env } from "../env";

/** Hard ceiling on the approval window (Cloudflare Workflows sleep max ≈ 1 year,
 *  but we cap the HITL gate at 24h so an ignored approval always resolves). */
const MAX_WINDOW_MS = 86_400_000;
const MIN_WINDOW_MS = 1_000;

/**
 * CallaApprovalWorkflow — the durable timer behind every edge HITL gate.
 *
 * Started by CallaEdgeAgent.requestApproval() with `{agentName, approvalId,
 * timeoutMs}`. It:
 *   (a) sleeps for the (capped) approval window, then
 *   (b) calls back into the owning edge agent's `expireApprovalIfPending` RPC.
 *       If the human never decided, the agent marks the gate `expired` and
 *       publishes `calla:approval:resolved {status:"expired"}`. If it was
 *       already approved/declined, the callback is a no-op.
 *
 * Because it is a Workflow, the timer survives isolate eviction and worker
 * deploys — the gate expiry is durable, not a best-effort setTimeout.
 */
export class CallaApprovalWorkflow extends WorkflowEntrypoint<
  Env,
  ApprovalWorkflowParams
> {
  async run(
    event: WorkflowEvent<ApprovalWorkflowParams>,
    step: WorkflowStep,
  ): Promise<unknown> {
    const { agentName, approvalId, timeoutMs } = event.payload;

    const cappedMs = Math.min(
      Math.max(Number.isFinite(timeoutMs) ? timeoutMs : MAX_WINDOW_MS, MIN_WINDOW_MS),
      MAX_WINDOW_MS,
    );
    // Use the unambiguous "<n> seconds" string form so we never depend on the
    // numeric-duration unit interpretation.
    const seconds = Math.max(1, Math.floor(cappedMs / 1000));

    // (a) Durable wait for the approval window.
    await step.sleep("approval-window", `${seconds} seconds`);

    // (b) Expire the gate if — and only if — it is still pending.
    const result = await step.do("expire-if-pending", async () => {
      const agent = this.env.CALLA_EDGE_AGENT.getByName(agentName);
      const res = await agent.expireApprovalIfPending({ approvalId });
      return {
        approvalId: res.approvalId,
        expired: res.expired,
        status: res.status,
      };
    });

    return result;
  }
}
