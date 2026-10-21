import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import type { StepResult } from "@calla/shared";

/** Default base URL of the Calla edge runtime (Cloudflare worker / dev server). */
export const DEFAULT_CALLA_EDGE_URL = "http://127.0.0.1:8787";

export function edgeBaseUrl(): string {
  return (process.env.CALLA_EDGE_URL ?? DEFAULT_CALLA_EDGE_URL).replace(/\/+$/, "");
}

const stepSchema = z.object({
  id: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  requiresApproval: z.boolean().default(false),
});

const stepResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("completed"), stepId: z.string(), output: z.unknown() }),
  z.object({ status: z.literal("awaiting_approval"), stepId: z.string(), approvalId: z.string() }),
  z.object({ status: z.literal("declined"), stepId: z.string(), approvalId: z.string() }),
  z.object({ status: z.literal("expired"), stepId: z.string(), approvalId: z.string() }),
  z.object({ status: z.literal("failed"), stepId: z.string(), error: z.string() }),
]);

/**
 * Dispatch a single step task to a Cloudflare edge agent.
 *
 * POSTs the step JSON to `${CALLA_EDGE_URL}/steps/${edgeAgentId}` and returns
 * the edge's StepResult. `requireApproval` is false here: edge agents enforce
 * their own approval gates (a gated step resolves to `awaiting_approval` with
 * an `approvalId` the UI can act on), so the brain must not double-gate.
 */
export const dispatchEdgeTask = createTool({
  id: "dispatch-edge-task",
  description:
    "Send a step task to a Cloudflare edge agent. The edge runtime enforces its own approval gates: a step with requiresApproval=true resolves to status 'awaiting_approval' with an approvalId instead of executing. Use list-fleet first to discover valid edgeAgentId values.",
  inputSchema: z.object({
    edgeAgentId: z.string().min(1).describe("Id of the edge agent to dispatch to (see list-fleet)."),
    step: stepSchema.describe("The step to execute on the edge agent."),
  }),
  outputSchema: stepResultSchema,
  requireApproval: false,
  execute: async ({ edgeAgentId, step }): Promise<StepResult> => {
    const url = `${edgeBaseUrl()}/steps/${encodeURIComponent(edgeAgentId)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(step),
      });
    } catch (err) {
      return {
        status: "failed",
        stepId: step.id,
        error: `edge runtime unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const raw = await res.text();
    if (!res.ok) {
      return {
        status: "failed",
        stepId: step.id,
        error: `edge responded ${res.status} ${res.statusText}: ${raw.slice(0, 500)}`,
      };
    }

    try {
      return stepResultSchema.parse(JSON.parse(raw)) as StepResult;
    } catch (err) {
      return {
        status: "failed",
        stepId: step.id,
        error: `edge returned a malformed StepResult: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
