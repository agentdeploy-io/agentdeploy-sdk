/**
 * BrainChat
 * ─────────
 * Chat surface for runtime:"brain" agents (Mastra). Talks REST/NDJSON via
 * mastraClient.streamNDJSON instead of the edge WebSocket:
 *   - text-delta          → appends to the streaming assistant bubble
 *   - tool-input-available→ tool chip "running"
 *   - tool-result         → tool chip "done"
 *   - tool-call-approval  → INLINE approval card in the flow (HITL gate);
 *                           Approve/Decline → mastraClient.approve/declineToolCall
 *   - finish / error      → finalize
 *
 * When mastraClient.enabled === false (BRAIN_URL unset/"none") the whole
 * surface degrades to an EmptyState.
 *
 * Voice + file attachments are out of scope (future work).
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { Check, ShieldQuestion, X } from "lucide-react";
import { Badge, Button } from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { MessageBubble } from "./MessageBubble";
import { ToolCallIndicator, type ToolCallInfo } from "./ToolCallIndicator";
import { ChatInput } from "./ChatInput";
import { mastraClient, type MastraChatMessage } from "@/lib/mastra-client";
import type { AgentRegistryEntry } from "@/constants/agents";
import type { ChatMessage, MessageRole } from "@/types/agent";

export interface BrainChatProps {
  agent: AgentRegistryEntry;
  className?: string;
}

type ApprovalStatus = "pending" | "approved" | "declined" | "error";

interface MessageItem {
  kind: "message";
  data: ChatMessage;
}
interface ApprovalItem {
  kind: "approval";
  id: string;
  toolName: string;
  args: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  status: ApprovalStatus;
  busy: boolean;
}
type BrainItem = MessageItem | ApprovalItem;

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const BrainChat: React.FC<BrainChatProps> = ({ agent, className }) => {
  const [items, setItems] = useState<BrainItem[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [lastToolCall, setLastToolCall] = useState<ToolCallInfo | null>(null);
  const streamingIdRef = useRef<string | null>(null);
  const abortRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Keep the flow pinned to the bottom as it grows.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, isStreaming]);

  // ─── Item helpers ──────────────────────────────────────────────
  const pushMessage = useCallback((role: MessageRole, content: string) => {
    setItems((prev) => [
      ...prev,
      {
        kind: "message",
        data: {
          id: makeId("brain"),
          role,
          content,
          timestamp: new Date().toISOString(),
          ...(role === "assistant" ? { streaming: false } : {}),
        },
      },
    ]);
  }, []);

  const appendStreamText = useCallback((delta: string) => {
    setItems((prev) => {
      const id = streamingIdRef.current;
      if (id) {
        return prev.map((it) =>
          it.kind === "message" && it.data.id === id
            ? { ...it, data: { ...it.data, content: it.data.content + delta } }
            : it,
        );
      }
      const newId = makeId("brain-asst");
      streamingIdRef.current = newId;
      return [
        ...prev,
        {
          kind: "message",
          data: {
            id: newId,
            role: "assistant" as const,
            content: delta,
            timestamp: new Date().toISOString(),
            streaming: true,
          },
        },
      ];
    });
  }, []);

  const finalizeStreaming = useCallback(() => {
    const id = streamingIdRef.current;
    if (!id) return;
    streamingIdRef.current = null;
    setItems((prev) => {
      const target = prev.find(
        (it) => it.kind === "message" && it.data.id === id,
      ) as MessageItem | undefined;
      // Drop empty bubbles (tool-only turns produce no text).
      if (target && target.data.content === "") {
        return prev.filter((it) => !(it.kind === "message" && it.data.id === id));
      }
      return prev.map((it) =>
        it.kind === "message" && it.data.id === id
          ? { ...it, data: { ...it.data, streaming: false } }
          : it,
      );
    });
  }, []);

  // ─── Send (stream a turn) ──────────────────────────────────────
  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || isStreaming) return;

      abortRef.current = false;
      const history: MastraChatMessage[] = items
        .filter((it): it is MessageItem => it.kind === "message")
        .map((it) => ({ role: it.data.role, content: it.data.content }));
      history.push({ role: "user", content: trimmed });

      pushMessage("user", trimmed);
      setIsStreaming(true);

      try {
        const stream = await mastraClient.streamNDJSON(agent.id, {
          messages: history,
        });
        for await (const chunk of stream) {
          if (abortRef.current) break;
          const raw = chunk as Record<string, unknown>;
          switch (chunk.type) {
            case "text-delta": {
              const delta = str(raw.delta);
              if (delta) appendStreamText(delta);
              break;
            }
            case "tool-input-available": {
              setLastToolCall({
                name: str(raw.toolName) ?? "tool",
                status: "running",
              });
              break;
            }
            case "tool-result": {
              setLastToolCall((prev) =>
                prev ? { ...prev, status: "done" } : { name: "tool", status: "done" },
              );
              break;
            }
            case "tool-call-approval": {
              finalizeStreaming();
              setLastToolCall(null);
              setItems((prev) => [
                ...prev,
                {
                  kind: "approval",
                  id: makeId("approval"),
                  toolName: str(raw.toolName) ?? "tool-call",
                  args: asRecord(raw.args ?? raw.input),
                  runId: str(raw.runId),
                  toolCallId: str(raw.toolCallId),
                  status: "pending",
                  busy: false,
                },
              ]);
              break;
            }
            case "error": {
              finalizeStreaming();
              pushMessage(
                "system",
                `Brain error: ${str(raw.error) ?? str(raw.message) ?? "unknown error"}`,
              );
              break;
            }
            case "finish": {
              finalizeStreaming();
              break;
            }
            default:
              break;
          }
        }
      } catch (err) {
        pushMessage(
          "system",
          `Brain stream failed: ${err instanceof Error ? err.message : "network error"}`,
        );
      } finally {
        finalizeStreaming();
        setIsStreaming(false);
        setLastToolCall(null);
      }
    },
    [items, isStreaming, agent.id, pushMessage, appendStreamText, finalizeStreaming],
  );

  const stop = useCallback(() => {
    abortRef.current = true;
    finalizeStreaming();
    setIsStreaming(false);
    setLastToolCall(null);
  }, [finalizeStreaming]);

  // ─── HITL decision ─────────────────────────────────────────────
  const decide = useCallback(
    async (itemId: string, approved: boolean) => {
      const target = items.find(
        (it) => it.kind === "approval" && it.id === itemId,
      ) as ApprovalItem | undefined;
      if (!target || !target.runId || !target.toolCallId) return;

      setItems((prev) =>
        prev.map((it) =>
          it.kind === "approval" && it.id === itemId ? { ...it, busy: true } : it,
        ),
      );
      try {
        const input = { runId: target.runId, toolCallId: target.toolCallId };
        if (approved) await mastraClient.approveToolCall(agent.id, input);
        else await mastraClient.declineToolCall(agent.id, input);
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "approval" && it.id === itemId
              ? { ...it, busy: false, status: approved ? "approved" : "declined" }
              : it,
          ),
        );
        pushMessage(
          "system",
          approved
            ? `Approved "${target.toolName}" — the brain resumes the run.`
            : `Declined "${target.toolName}".`,
        );
      } catch (err) {
        setItems((prev) =>
          prev.map((it) =>
            it.kind === "approval" && it.id === itemId
              ? { ...it, busy: false, status: "error" }
              : it,
          ),
        );
        pushMessage(
          "system",
          `Decision failed: ${err instanceof Error ? err.message : "unknown error"}`,
        );
      }
    },
    [items, agent.id, pushMessage],
  );

  // ─── Brain disabled ────────────────────────────────────────────
  if (!mastraClient.enabled) {
    return (
      <EmptyState
        icon="🧠"
        title="Brain not configured"
        message="Set BRAIN_URL to connect the Mastra brain. Until then, streaming chat and HITL tool approvals are unavailable for this agent."
        className={className}
      />
    );
  }

  return (
    <div
      className={
        "flex h-[600px] flex-col overflow-hidden rounded-xl border bg-card shadow-panel " +
        (className ?? "")
      }
    >
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="text-lg leading-none">{agent.icon}</span>
          <span className="text-sm font-medium text-foreground">{agent.name}</span>
          <Badge variant="info">brain</Badge>
        </div>
        <span className="text-[0.6875rem] text-muted-foreground">
          Mastra · REST stream
        </span>
      </div>

      {/* Flow */}
      <div
        ref={scrollRef}
        className="scrollbar-thin flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
      >
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 text-center text-muted-foreground">
            <span className="text-4xl opacity-60">{agent.icon}</span>
            <p className="text-sm">
              Ask {agent.name} to plan something — high-risk tool calls pause here
              for your approval.
            </p>
          </div>
        ) : (
          items.map((item) =>
            item.kind === "message" ? (
              <MessageBubble key={item.data.id} message={item.data} />
            ) : (
              <BrainApprovalCard
                key={item.id}
                item={item}
                onDecide={decide}
              />
            ),
          )
        )}

        {lastToolCall && (
          <div className="pl-1">
            <ToolCallIndicator toolCall={lastToolCall} />
          </div>
        )}
      </div>

      {/* Composer */}
      <ChatInput
        agent={agent}
        status="connected"
        isStreaming={isStreaming}
        commands={[]}
        onSend={(text) => void send(text)}
        onStop={stop}
        appendMessage={(m) => setItems((prev) => [...prev, { kind: "message", data: m }])}
      />
    </div>
  );
};

BrainChat.displayName = "BrainChat";

// ─── Inline approval card ────────────────────────────────────────

const STATUS_META: Record<ApprovalStatus, { label: string; variant: "warning" | "success" | "muted" | "error" }> = {
  pending: { label: "Awaiting decision", variant: "warning" },
  approved: { label: "Approved", variant: "success" },
  declined: { label: "Declined", variant: "muted" },
  error: { label: "Decision failed", variant: "error" },
};

const BrainApprovalCard: React.FC<{
  item: ApprovalItem;
  onDecide: (id: string, approved: boolean) => void;
}> = ({ item, onDecide }) => {
  const meta = STATUS_META[item.status];
  const decided = item.status !== "pending";
  return (
    <div className="w-full max-w-[85%] rounded-xl border border-warning/40 bg-warning/5 p-3 shadow-control">
      <div className="flex items-center gap-2">
        <ShieldQuestion className="size-4 shrink-0 text-warning" aria-hidden />
        <span className="text-xs font-semibold text-foreground">
          Approval required
        </span>
        <code className="rounded bg-surface-tag px-1.5 py-0.5 font-mono text-[0.6875rem] text-body">
          {item.toolName}
        </code>
        <Badge variant={meta.variant} className="ml-auto">
          {meta.label}
        </Badge>
      </div>

      <pre className="scrollbar-thin mt-2 max-h-48 overflow-auto rounded-md bg-surface-canvas p-2 font-mono text-[0.6875rem] text-body">
        {JSON.stringify(item.args, null, 2)}
      </pre>

      {!decided && (
        <div className="mt-2 flex gap-2">
          <Button
            size="sm"
            variant="success"
            disabled={item.busy}
            onClick={() => onDecide(item.id, true)}
          >
            <Check className="size-4" />
            {item.busy ? "Working…" : "Approve"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={item.busy}
            onClick={() => onDecide(item.id, false)}
          >
            <X className="size-4" />
            Decline
          </Button>
        </div>
      )}
    </div>
  );
};
