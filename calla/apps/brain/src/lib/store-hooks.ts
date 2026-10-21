/**
 * Best-effort bridges between the HTTP request path and the durable Calla
 * store: pending-approval recording on suspend, decision recording on
 * approve/decline, and evaluator firing after generate/stream complete.
 *
 * EVERY entry point swallows storage failures (logged, never thrown) —
 * storage problems must never break LLM responses.
 */
import { getCallaStore, type CallaStore } from "../store/index.js";
import { fireEvaluators } from "../evaluators/runner.js";
import type { EvalMessage } from "../evaluators/types.js";
import { riskForTool, safeStringify, type SerializedOutput } from "./serialize.js";

/** Run a store operation best-effort; logs and returns undefined on failure. */
export async function withStore<T>(
  label: string,
  fn: (store: CallaStore) => Promise<T>,
): Promise<T | undefined> {
  try {
    return await fn(getCallaStore());
  } catch (err) {
    console.error(`[calla-brain] calla store ${label} failed:`, err);
    return undefined;
  }
}

/** Normalize the /generate + /stream `messages` body into EvalMessages. */
export function normalizeInputMessages(messages: unknown): EvalMessage[] {
  if (typeof messages === "string") return [{ role: "user", content: messages }];
  if (!Array.isArray(messages)) return [];
  return messages.map((m) => {
    const msg = (m ?? {}) as { role?: unknown; content?: unknown };
    return {
      role: typeof msg.role === "string" ? msg.role : "user",
      content: typeof msg.content === "string" ? msg.content : safeStringify(msg.content),
    };
  });
}

export interface FireEvaluatorsParams {
  agentId: string;
  runId?: string | null;
  startedAt: number;
  input: EvalMessage[];
  output: {
    text?: string;
    toolCalls?: { toolCallId: string; toolName: string; args?: unknown }[];
    finishReason?: string | null;
  };
  threadId?: string;
  resourceId?: string;
}

/** Fire-and-forget the evaluator pipeline with measured durationMs. */
export function fireRunEvaluators(params: FireEvaluatorsParams): void {
  fireEvaluators({
    agentId: params.agentId,
    ...(params.runId ? { runId: params.runId } : {}),
    input: params.input,
    output: params.output,
    startedAt: params.startedAt,
    durationMs: Date.now() - params.startedAt,
    ...(params.threadId ? { threadId: params.threadId } : {}),
    ...(params.resourceId ? { resourceId: params.resourceId } : {}),
  });
}

// ─── Pending approvals (suspend path) ────────────────────────────

export interface PendingApprovalInput {
  agentId: string;
  toolName: string;
  toolCallId?: string | null;
  args?: Record<string, unknown> | null;
  runId?: string | null;
}

/** Record a `pending` approval row + `approval.requested` audit entry. */
export async function recordPendingApproval(p: PendingApprovalInput): Promise<void> {
  const risk = riskForTool(p.toolName);
  const row = await withStore("recordApproval(pending)", (s) =>
    s.recordApproval({
      source: "mastra",
      agentId: p.agentId,
      toolName: p.toolName,
      args: p.args ?? {},
      risk,
      summary: `Approval required: ${p.toolName}`,
      status: "pending",
      runId: p.runId ?? null,
      toolCallId: p.toolCallId ?? null,
    }),
  );
  await withStore("appendAudit(approval.requested)", (s) =>
    s.appendAudit({
      agentId: p.agentId,
      kind: "approval.requested",
      entry: {
        approvalId: row?.id ?? null,
        runId: p.runId ?? null,
        toolCallId: p.toolCallId ?? null,
        toolName: p.toolName,
        risk,
        agentId: p.agentId,
      },
    }),
  );
}

/**
 * When a generate/approve/decline result finished `suspended`, record a
 * pending approval for every gated tool call without a tool result.
 */
export function recordSuspendedFromOutput(agentId: string, output: SerializedOutput): void {
  if (output.finishReason !== "suspended") return;
  const resolved = new Set(output.toolResults.map((tr) => tr.toolCallId).filter(Boolean));
  const seen = new Set<string>();
  for (const tc of output.toolCalls) {
    if (tc.toolCallId && resolved.has(tc.toolCallId)) continue;
    const key = tc.toolCallId || tc.toolName;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    void recordPendingApproval({
      agentId,
      toolName: tc.toolName || "unknown",
      toolCallId: tc.toolCallId || null,
      args: (tc.args ?? {}) as Record<string, unknown>,
      runId: output.runId,
    }).catch((err) => console.error("[calla-brain] recordPendingApproval failed:", err));
  }
}

// ─── Decisions (approve/decline path) ────────────────────────────

export interface ApprovalDecisionInput {
  agentId: string;
  decision: "approved" | "declined";
  runId: string;
  toolCallId?: string | null;
  reason?: string | null;
  /** "Edit & Approve" args (logged for audit; Mastra resumes original args). */
  updatedArgs?: Record<string, unknown> | null;
  /** Resumed run output — used as fallback when no pending row is found. */
  fallbackOutput?: SerializedOutput;
}

/**
 * Record the decision: append a decided approval row (history is append-only)
 * plus an `approval.decided` audit entry. Enriches toolName/args/risk from the
 * pending row(s) recorded at suspend time when available.
 */
export async function recordApprovalDecision(params: ApprovalDecisionInput): Promise<void> {
  try {
    const store = getCallaStore();
    const pending =
      (await store
        .listApprovals({ runId: params.runId, status: "pending", limit: 100 })
        .catch(() => [])) ?? [];
    const matches = pending.filter(
      (p) => !params.toolCallId || !p.toolCallId || p.toolCallId === params.toolCallId,
    );

    if (matches.length > 0) {
      for (const p of matches) {
        const toolCallId = p.toolCallId ?? params.toolCallId ?? null;
        await withStore("recordApproval(decided)", (s) =>
          s.recordApproval({
            source: p.source,
            agentId: params.agentId,
            toolName: p.toolName,
            args: p.args,
            risk: p.risk,
            summary: p.summary,
            status: params.decision,
            runId: p.runId ?? params.runId,
            toolCallId,
            deploymentId: p.deploymentId,
          }),
        );
        await withStore("appendAudit(approval.decided)", (s) =>
          s.appendAudit({
            agentId: params.agentId,
            kind: "approval.decided",
            entry: {
              decision: params.decision,
              approvalId: p.id,
              runId: params.runId,
              toolCallId,
              toolName: p.toolName,
              risk: p.risk,
              decidedBy: "human",
              ...(params.reason ? { reason: params.reason } : {}),
              ...(params.updatedArgs ? { updatedArgsProvided: true } : {}),
            },
          }),
        );
      }
      return;
    }

    // No pending row (pre-store suspension / pruned db): fall back to the
    // resumed run's tool info so the decision is still in the history.
    const tc = params.fallbackOutput?.toolCalls?.find(
      (t) => !params.toolCallId || !t.toolCallId || t.toolCallId === params.toolCallId,
    );
    const toolName = tc?.toolName ?? "unknown";
    const toolCallId = params.toolCallId ?? tc?.toolCallId ?? null;
    await withStore("recordApproval(decided)", (s) =>
      s.recordApproval({
        source: "mastra",
        agentId: params.agentId,
        toolName,
        args: (tc?.args ?? {}) as Record<string, unknown>,
        risk: riskForTool(toolName),
        summary: `Decision ${params.decision}: ${toolName}`,
        status: params.decision,
        runId: params.runId,
        toolCallId,
      }),
    );
    await withStore("appendAudit(approval.decided)", (s) =>
      s.appendAudit({
        agentId: params.agentId,
        kind: "approval.decided",
        entry: {
          decision: params.decision,
          approvalId: null,
          runId: params.runId,
          toolCallId,
          toolName,
          decidedBy: "human",
          note: "no pending row found — recorded from the resumed run",
          ...(params.reason ? { reason: params.reason } : {}),
        },
      }),
    );
  } catch (err) {
    console.error(`[calla-brain] recordApprovalDecision(${params.decision}) failed:`, err);
  }
}
