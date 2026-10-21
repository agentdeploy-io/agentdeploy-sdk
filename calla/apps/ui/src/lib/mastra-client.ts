/**
 * Mastra Brain REST Adapter
 * ─────────────────────────
 * Thin client over the Calla brain (Mastra) HTTP API.
 *
 * Base URL comes from runtime config (BRAIN_URL, default "/brain" — the
 * Vite dev proxy forwards /brain/* to the brain on :3000; in production
 * the edge worker or reverse proxy does the same).
 *
 * Graceful degradation: when BRAIN_URL is "" or "none", the brain is
 * optional/absent — `enabled` is false and every method resolves to an
 * empty/no-op result so UI code never needs brain-presence checks.
 *
 * Endpoints:
 *   GET  {base}/agents/{agentId}/suspended-runs   → SuspendedRun[]
 *   POST {base}/agents/{agentId}/approve-tool-call { runId, toolCallId, updatedArgs? }
 *   POST {base}/agents/{agentId}/decline-tool-call { runId, toolCallId }
 *   POST {base}/agents/{agentId}/generate          { messages, threadId? }
 *   POST {base}/agents/{agentId}/stream            { messages, threadId? } → NDJSON
 */

import type { ApprovalRequest, RiskLevel } from "@calla/shared";
import { getBrainUrl } from "@/config";
import { authFetch } from "@/hooks/useAuthFetch";

// ─── Types ───────────────────────────────────────────────────────

export interface MastraChatMessage {
  id?: string;
  role: "user" | "assistant" | "system";
  content: string;
}

/** Raw suspended-run shape as returned by the brain (defensively mapped). */
export interface SuspendedRun {
  runId: string;
  toolCallId: string;
  toolName: string;
  args: Record<string, unknown>;
  riskLevel?: RiskLevel;
  agentId?: string;
  suspendedAt?: string;
  [key: string]: unknown;
}

/** One NDJSON line from the /stream endpoint. */
export type MastraStreamChunk =
  | { type: "text-delta"; delta: string; [key: string]: unknown }
  | { type: "tool-input-available"; toolCallId?: string; toolName?: string; input?: unknown; [key: string]: unknown }
  | { type: "finish"; [key: string]: unknown }
  | { type: string; [key: string]: unknown };

export interface ToolCallDecisionInput {
  runId: string;
  toolCallId: string;
  /** "Edit & Approve" — the brain resumes the tool call with these args. */
  updatedArgs?: Record<string, unknown>;
  /** Decline only — returned to the model in place of the tool result so it can adjust. */
  reason?: string;
}

export interface MastraClient {
  /** False when BRAIN_URL is empty/"none" — all methods become no-ops. */
  enabled: boolean;
  /** Resolved brain base URL. */
  baseUrl: string;
  /** Suspended runs for an agent, mapped to unified ApprovalRequest entities. */
  listSuspendedRuns(agentId: string): Promise<ApprovalRequest[]>;
  /** Resume a suspended tool call (optionally with edited args). */
  approveToolCall(agentId: string, input: ToolCallDecisionInput): Promise<void>;
  /** Decline a suspended tool call — the run resumes with a rejection. */
  declineToolCall(agentId: string, input: ToolCallDecisionInput): Promise<void>;
  /** Non-streaming generation. */
  generate(
    agentId: string,
    input: { messages: MastraChatMessage[]; threadId?: string },
  ): Promise<Record<string, unknown>>;
  /** Streaming generation — async iterator over NDJSON chunks. */
  streamNDJSON(
    agentId: string,
    input: { messages: MastraChatMessage[]; threadId?: string },
  ): Promise<AsyncIterable<MastraStreamChunk>>;
}

// ─── Helpers ─────────────────────────────────────────────────────

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];

function asRisk(value: unknown): RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as string[]).includes(value)
    ? (value as RiskLevel)
    : "medium";
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * Map a raw brain suspended-run into the unified ApprovalRequest entity
 * consumed by useApprovals / the Inbox.
 */
export function suspendedRunToApproval(
  run: SuspendedRun,
  fallbackAgentId: string,
): ApprovalRequest {
  const extra = asRecord(run);
  const payload = asRecord(extra.payload);
  const args = asRecord(run.args ?? payload.args ?? extra.input ?? extra.arguments);
  const risk = asRisk(run.riskLevel ?? payload.riskLevel ?? payload.risk);
  const requestedAt =
    (typeof run.suspendedAt === "string" && run.suspendedAt) ||
    (typeof payload.requestedAt === "string" && payload.requestedAt) ||
    (typeof extra.createdAt === "string" && extra.createdAt) ||
    new Date().toISOString();

  return {
    id: `mastra:${run.runId}:${run.toolCallId}`,
    source: "mastra",
    agentId: run.agentId ?? (typeof extra.agentId === "string" ? extra.agentId : fallbackAgentId),
    runId: run.runId,
    toolCallId: run.toolCallId,
    toolName: run.toolName ?? "tool-call",
    arguments: args,
    risk,
    summary:
      (typeof payload.summary === "string" && payload.summary) ||
      `Brain run suspended awaiting approval for "${run.toolName ?? "tool-call"}"`,
    requestedAt,
    expiresAt: null,
    status: "pending",
  };
}

/** Normalize the brain's suspended-runs response into SuspendedRun[]. */
function normalizeSuspendedRuns(data: unknown): SuspendedRun[] {
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { runs?: unknown })?.runs)
      ? ((data as { runs: unknown[] }).runs)
      : Array.isArray((data as { suspendedRuns?: unknown })?.suspendedRuns)
        ? ((data as { suspendedRuns: unknown[] }).suspendedRuns)
        : [];

  const runs: SuspendedRun[] = [];
  for (const item of list) {
    const rec = asRecord(item);
    const runId =
      (typeof rec.runId === "string" && rec.runId) ||
      (typeof rec.id === "string" && rec.id) ||
      "";
    if (!runId) continue;

    // Tool call info may sit at the top level or inside a nested object.
    const toolCall = asRecord(rec.toolCall ?? rec.toolCallInfo);
    const toolCallId =
      (typeof rec.toolCallId === "string" && rec.toolCallId) ||
      (typeof toolCall.id === "string" && toolCall.id) ||
      (typeof toolCall.toolCallId === "string" && toolCall.toolCallId) ||
      "";
    const toolName =
      (typeof rec.toolName === "string" && rec.toolName) ||
      (typeof toolCall.toolName === "string" && toolCall.toolName) ||
      "";

    runs.push({
      ...rec,
      runId,
      toolCallId,
      toolName,
      args: asRecord(rec.args ?? toolCall.args ?? toolCall.input ?? rec.input),
      riskLevel:
        typeof rec.riskLevel === "string"
          ? (rec.riskLevel as RiskLevel)
          : typeof rec.risk === "string"
            ? (rec.risk as RiskLevel)
            : undefined,
      agentId: typeof rec.agentId === "string" ? rec.agentId : undefined,
      suspendedAt:
        typeof rec.suspendedAt === "string"
          ? rec.suspendedAt
          : typeof rec.createdAt === "string"
            ? rec.createdAt
            : undefined,
    });
  }
  return runs;
}

async function emptyAsyncIterable(): Promise<AsyncIterable<MastraStreamChunk>> {
  return {
    async *[Symbol.asyncIterator]() {
      // no-op — brain disabled
    },
  };
}

// ─── Factory ─────────────────────────────────────────────────────

export function createMastraClient(baseUrl: string = getBrainUrl()): MastraClient {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const enabled = base.length > 0 && base.toLowerCase() !== "none";

  const agentBase = (agentId: string) =>
    `${base}/agents/${encodeURIComponent(agentId)}`;

  async function postJson(path: string, body: unknown): Promise<Response> {
    return authFetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    });
  }

  return {
    enabled,
    baseUrl: base,

    async listSuspendedRuns(agentId: string): Promise<ApprovalRequest[]> {
      if (!enabled) return [];
      try {
        const res = await authFetch(`${agentBase(agentId)}/suspended-runs`, {
          headers: { Accept: "application/json" },
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        const data: unknown = await res.json();
        return normalizeSuspendedRuns(data).map((run) =>
          suspendedRunToApproval(run, agentId),
        );
      } catch {
        // Brain is optional — degrade silently; the Inbox shows the other
        // sources and surfaces a global error only for hard failures.
        return [];
      }
    },

    async approveToolCall(agentId: string, input: ToolCallDecisionInput): Promise<void> {
      if (!enabled) return;
      const res = await postJson(`${agentBase(agentId)}/approve-tool-call`, {
        runId: input.runId,
        toolCallId: input.toolCallId,
        ...(input.updatedArgs ? { updatedArgs: input.updatedArgs } : {}),
      });
      if (!res.ok) {
        throw new Error(`approve-tool-call failed: ${res.status} ${res.statusText}`);
      }
    },

    async declineToolCall(agentId: string, input: ToolCallDecisionInput): Promise<void> {
      if (!enabled) return;
      const res = await postJson(`${agentBase(agentId)}/decline-tool-call`, {
        runId: input.runId,
        toolCallId: input.toolCallId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
      if (!res.ok) {
        throw new Error(`decline-tool-call failed: ${res.status} ${res.statusText}`);
      }
    },

    async generate(
      agentId: string,
      input: { messages: MastraChatMessage[]; threadId?: string },
    ): Promise<Record<string, unknown>> {
      if (!enabled) return {};
      const res = await postJson(`${agentBase(agentId)}/generate`, {
        messages: input.messages,
        ...(input.threadId ? { threadId: input.threadId } : {}),
      });
      if (!res.ok) {
        throw new Error(`generate failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as Record<string, unknown>;
    },

    async streamNDJSON(
      agentId: string,
      input: { messages: MastraChatMessage[]; threadId?: string },
    ): Promise<AsyncIterable<MastraStreamChunk>> {
      if (!enabled) return emptyAsyncIterable();

      const res = await authFetch(`${agentBase(agentId)}/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
        body: JSON.stringify({
          messages: input.messages,
          ...(input.threadId ? { threadId: input.threadId } : {}),
        }),
      });
      if (!res.ok) {
        throw new Error(`stream failed: ${res.status} ${res.statusText}`);
      }
      if (!res.body) {
        return emptyAsyncIterable();
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();

      async function* iterate(): AsyncGenerator<MastraStreamChunk> {
        let buffer = "";
        try {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });

            let newlineIdx = buffer.indexOf("\n");
            while (newlineIdx >= 0) {
              const line = buffer.slice(0, newlineIdx).trim();
              buffer = buffer.slice(newlineIdx + 1);
              newlineIdx = buffer.indexOf("\n");
              if (!line) continue;
              try {
                yield JSON.parse(line) as MastraStreamChunk;
              } catch {
                // Skip malformed NDJSON lines (keep the stream alive).
              }
            }
          }
          // Flush a trailing line without a newline terminator.
          const tail = buffer.trim();
          if (tail) {
            try {
              yield JSON.parse(tail) as MastraStreamChunk;
            } catch {
              // ignore
            }
          }
        } finally {
          reader.releaseLock();
        }
      }

      return iterate();
    },
  };
}

/** Default client bound to the runtime BRAIN_URL config. */
export const mastraClient: MastraClient = createMastraClient();
