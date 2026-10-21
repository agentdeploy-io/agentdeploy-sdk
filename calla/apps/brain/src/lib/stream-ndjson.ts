import type { ChunkType } from "@mastra/core/stream";
import type { MastraModelOutput } from "@mastra/core/stream";
import { errorMessage, safeStringify } from "./serialize.js";

/**
 * NDJSON line contract consumed by apps/ui/src/lib/mastra-client.ts:
 *   { type: "start", runId }
 *   { type: "text-delta", delta }                        ← assistant text
 *   { type: "reasoning-delta", delta }                   ← model reasoning (optional display)
 *   { type: "tool-input-available", toolCallId, toolName, input }  ← parsed tool call
 *   { type: "tool-result", toolCallId, toolName, result, isError }
 *   { type: "tool-call-approval", toolCallId, toolName, args, resumeSchema, runId }  ← HITL gate
 *   { type: "tool-call-suspended", toolCallId, toolName, args, suspendPayload, runId }
 *   { type: "finish", finishReason, usage, runId }
 *   { type: "error", error, runId? }
 *   { type: "done", runId }                              ← final line, stream closed cleanly
 */
export interface NdjsonLine {
  type: string;
  [key: string]: unknown;
}

type AnyChunk = ChunkType<unknown> & { type: string; payload?: Record<string, unknown> };

export function normalizeChunk(chunk: unknown): NdjsonLine | null {
  const c = chunk as AnyChunk;
  if (!c || typeof c !== "object" || typeof c.type !== "string") return null;
  const p = (c.payload ?? {}) as Record<string, unknown>;
  const runId = typeof c.runId === "string" ? c.runId : undefined;

  switch (c.type) {
    case "text-delta":
      return { type: "text-delta", delta: typeof p.text === "string" ? p.text : "", id: p.id };
    case "reasoning-delta":
      return { type: "reasoning-delta", delta: typeof p.text === "string" ? p.text : "" };
    case "tool-call":
      return {
        type: "tool-input-available",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        input: p.args,
        args: p.args,
      };
    case "tool-result":
      return {
        type: "tool-result",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        result: p.result,
        isError: p.isError ?? false,
      };
    case "tool-error":
      return {
        type: "tool-error",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        error: errorMessage(p.error),
      };
    case "tool-call-approval":
      return {
        type: "tool-call-approval",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        resumeSchema: p.resumeSchema,
        runId,
      };
    case "tool-call-suspended":
      return {
        type: "tool-call-suspended",
        toolCallId: p.toolCallId,
        toolName: p.toolName,
        args: p.args,
        suspendPayload: p.suspendPayload,
        runId,
      };
    case "finish": {
      const stepResult = (p.stepResult ?? {}) as Record<string, unknown>;
      const output = (p.output ?? {}) as Record<string, unknown>;
      return {
        type: "finish",
        finishReason: stepResult.reason ?? null,
        usage: output.usage ?? null,
        runId,
      };
    }
    case "error":
      return { type: "error", error: errorMessage(p.error), runId };
    default:
      // Drop noisy internals (raw, step-start, response-metadata, ...). The UI
      // ignores unknown types anyway; keep the wire lean.
      return null;
  }
}

/**
 * Wraps a Mastra model stream (agent.stream()/approveToolCall() result) into a
 * web ReadableStream of NDJSON lines for the HTTP response. Stops early when
 * the client disconnects (signal abort / stream cancel).
 *
 * `observer` is the least-invasive hook point for the durable store +
 * evaluator pipeline: onApprovalChunk fires per HITL gate chunk (pending
 * approval recording), onFinish fires exactly once when the stream ends
 * (done/error/cancel) with a summary the server turns into an EvalContext.
 * Observer callbacks are wrapped in try/catch — they can never break the wire.
 */
export interface StreamSummary {
  runId?: string;
  finishReason?: string | null;
  /** Full assistant text accumulated from text-delta chunks. */
  text: string;
  toolCalls: { toolCallId: string; toolName: string; args?: unknown }[];
  /** A tool-call-approval/suspended chunk was seen, or finishReason === "suspended". */
  suspended: boolean;
  /** Stream closed cleanly with a "done" line. */
  done: boolean;
  error?: string;
}

export interface StreamObserver {
  onApprovalChunk?(line: NdjsonLine): void;
  onFinish?(summary: StreamSummary): void;
}

export function createNdjsonStream(
  modelOutput: MastraModelOutput<unknown>,
  signal?: AbortSignal,
  observer?: StreamObserver,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cancelled = signal?.aborted ?? false;
  signal?.addEventListener("abort", () => {
    cancelled = true;
  });

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (line: NdjsonLine) => {
        if (cancelled) return;
        try {
          controller.enqueue(encoder.encode(`${safeStringify(line)}\n`));
        } catch {
          cancelled = true;
        }
      };

      // ─── Observer accumulation ────────────────────────────────
      const summary: StreamSummary = {
        runId: modelOutput.runId,
        finishReason: null,
        text: "",
        toolCalls: [],
        suspended: false,
        done: false,
      };
      const notify = (fn: (() => void) | undefined) => {
        if (!fn) return;
        try {
          fn();
        } catch (err) {
          console.error("[calla-brain] stream observer failed:", err);
        }
      };
      const observe = (line: NdjsonLine) => {
        switch (line.type) {
          case "text-delta":
            if (typeof line.delta === "string") summary.text += line.delta;
            break;
          case "tool-input-available":
            summary.toolCalls.push({
              toolCallId: typeof line.toolCallId === "string" ? line.toolCallId : "",
              toolName: typeof line.toolName === "string" ? line.toolName : "",
              args: line.args,
            });
            break;
          case "tool-call-approval":
          case "tool-call-suspended":
            summary.suspended = true;
            notify(() => observer?.onApprovalChunk?.(line));
            break;
          case "finish":
            if (typeof line.finishReason === "string") summary.finishReason = line.finishReason;
            if (summary.finishReason === "suspended") summary.suspended = true;
            break;
          case "error":
            summary.error = typeof line.error === "string" ? line.error : "stream error";
            break;
          default:
            break;
        }
      };

      try {
        send({ type: "start", runId: modelOutput.runId });
        for await (const chunk of modelOutput.fullStream) {
          if (cancelled) break;
          const line = normalizeChunk(chunk);
          if (line) {
            observe(line);
            send(line);
          }
        }
        if (!cancelled) {
          summary.done = true;
          send({ type: "done", runId: modelOutput.runId });
        }
      } catch (err) {
        summary.error = errorMessage(err);
        send({ type: "error", error: summary.error, runId: modelOutput.runId });
      } finally {
        notify(() => observer?.onFinish?.(summary));
        try {
          controller.close();
        } catch {
          // already closed/cancelled
        }
      }
    },
    cancel() {
      cancelled = true;
    },
  });
}
