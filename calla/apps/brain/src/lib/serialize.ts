import type { FullOutput } from "@mastra/core/stream";
import type { AgentRun } from "@mastra/core/agent";
import type { RiskLevel } from "@calla/shared";

/** Per-tool default risk used to enrich suspended-run rows for the UI inbox. */
const TOOL_RISK: Record<string, RiskLevel> = {
  "send-external-email": "high",
  "dispatch-edge-task": "medium",
  "list-fleet": "low",
};

export function riskForTool(toolName: string | undefined | null): RiskLevel {
  return (toolName && TOOL_RISK[toolName]) || "medium";
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** JSON.stringify that survives Error objects and BigInt values. */
export function safeStringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (v instanceof Error) return { name: v.name, message: v.message };
        if (typeof v === "bigint") return v.toString();
        return v;
      }) ?? "null"
    );
  } catch {
    return JSON.stringify({ error: "unserializable value", repr: String(value) });
  }
}

export interface SerializedToolCall {
  toolCallId: string;
  toolName: string;
  args: unknown;
}

export interface SerializedToolResult {
  toolCallId: string;
  toolName: string;
  result: unknown;
  isError?: boolean;
}

/** JSON-safe subset of Mastra's FullOutput — the /generate + approve/decline contract. */
export interface SerializedOutput {
  text: string;
  finishReason: string | null;
  runId: string | null;
  /** Present when the run suspended again (e.g. another approval-gated tool call). */
  suspendPayload: unknown | null;
  toolCalls: SerializedToolCall[];
  toolResults: SerializedToolResult[];
  usage: { inputTokens?: number; outputTokens?: number; totalTokens?: number } | null;
  error: string | null;
}

export function serializeFullOutput(output: FullOutput<unknown>): SerializedOutput {
  return {
    text: output.text ?? "",
    finishReason: output.finishReason ?? null,
    runId: output.runId ?? null,
    suspendPayload: output.suspendPayload ?? null,
    toolCalls: (output.toolCalls ?? []).map((tc) => ({
      toolCallId: tc.payload?.toolCallId ?? "",
      toolName: tc.payload?.toolName ?? "",
      args: tc.payload?.args ?? null,
    })),
    toolResults: (output.toolResults ?? []).map((tr) => ({
      toolCallId: tr.payload?.toolCallId ?? "",
      toolName: tr.payload?.toolName ?? "",
      result: tr.payload?.result ?? null,
      isError: tr.payload?.isError ?? false,
    })),
    usage: output.usage ?? null,
    error: output.error ? errorMessage(output.error) : null,
  };
}

/**
 * Flat, UI-friendly suspended-run rows.
 *
 * Mastra 1.74 returns AgentRun = { runId, status, threadId?, resourceId?,
 * suspendedAt: Date, toolCalls: [{ toolCallId?, toolName?, args?,
 * requiresApproval, suspendPayload? }] }. The UI adapter
 * (apps/ui/src/lib/mastra-client.ts) expects one row per pending tool call
 * with runId/toolCallId/toolName/args/suspendedAt at the top level, so each
 * run is expanded across its suspended tool calls. The nested `toolCalls`
 * array is preserved for completeness.
 */
export interface SerializedSuspendedRun {
  runId: string;
  status: string;
  agentId: string;
  threadId: string | null;
  resourceId: string | null;
  suspendedAt: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  requiresApproval: boolean;
  riskLevel: RiskLevel;
  suspendPayload: unknown | null;
  toolCalls: AgentRun["toolCalls"];
}

export function flattenSuspendedRuns(runs: AgentRun[], agentId: string): SerializedSuspendedRun[] {
  const flat: SerializedSuspendedRun[] = [];
  for (const run of runs) {
    const suspendedAt =
      run.suspendedAt instanceof Date
        ? run.suspendedAt.toISOString()
        : run.suspendedAt
          ? new Date(run.suspendedAt).toISOString()
          : new Date().toISOString();
    const base = {
      runId: run.runId,
      status: run.status,
      agentId,
      threadId: run.threadId ?? null,
      resourceId: run.resourceId ?? null,
      suspendedAt,
      toolCalls: run.toolCalls ?? [],
    };
    const toolCalls = run.toolCalls ?? [];
    if (toolCalls.length === 0) {
      flat.push({
        ...base,
        toolCallId: "",
        toolName: "",
        args: {},
        requiresApproval: false,
        riskLevel: "medium",
        suspendPayload: null,
      });
      continue;
    }
    for (const tc of toolCalls) {
      flat.push({
        ...base,
        toolCallId: tc.toolCallId ?? "",
        toolName: tc.toolName ?? "",
        args: (tc.args ?? {}) as Record<string, unknown>,
        requiresApproval: tc.requiresApproval,
        riskLevel: riskForTool(tc.toolName),
        suspendPayload: tc.suspendPayload ?? null,
      });
    }
  }
  return flat;
}
