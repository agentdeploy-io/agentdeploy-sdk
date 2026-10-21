/**
 * MessageBubble
 * ─────────────
 * One chat message rendered per role:
 *   - user      → primary bubble, right-aligned (rounded-br-sm tail)
 *   - assistant → card bubble, left-aligned (rounded-bl-sm tail), markdown,
 *                 streaming caret while message.streaming
 *   - system    → centered muted italic notice (markdown-aware: command
 *                 results carrying code fences render left-aligned)
 *
 * Tailwind rebuild of the playground AgentDetailView MessageBubble
 * (voice read-aloud intentionally omitted — future work).
 */

import React, { useMemo } from "react";
import { Paperclip } from "lucide-react";
import { renderMarkdown } from "@/lib/markdown";
import { cn, relativeTime } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";

export interface MessageBubbleProps {
  message: ChatMessage;
  className?: string;
}

export const MessageBubble: React.FC<MessageBubbleProps> = React.memo(
  ({ message, className }) => {
    const isUser = message.role === "user";
    const isSystem = message.role === "system";

    // Assistant + system content is markdown (DOMPurify-sanitized).
    const html = useMemo(
      () => (isUser ? "" : renderMarkdown(message.content)),
      [isUser, message.content],
    );

    const time = useMemo(() => {
      try {
        return relativeTime(message.timestamp);
      } catch {
        return "";
      }
    }, [message.timestamp]);

    // ─── System notice ───────────────────────────────────────────
    if (isSystem) {
      // Slash-command results carry markdown (code fences / bold); plain
      // notices stay centered italic text.
      const hasMarkdown = message.content.includes("```") || message.content.includes("**");
      return (
        <div
          className={cn(
            "mx-auto my-1 flex max-w-[90%] flex-col items-center gap-0.5",
            className,
          )}
        >
          {hasMarkdown ? (
            <div
              className="chat-markdown w-full rounded-lg bg-surface-canvas px-3 py-2 text-xs text-muted-foreground"
              // Sanitized by renderMarkdown (DOMPurify) — safe to inject.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : (
            <p className="break-words text-center text-xs italic text-muted-foreground">
              {message.content}
            </p>
          )}
          {time && <span className="text-[10px] text-faint">{time}</span>}
        </div>
      );
    }

    // ─── User bubble ─────────────────────────────────────────────
    if (isUser) {
      return (
        <div className={cn("flex flex-col items-end", className)}>
          <div className="ml-auto max-w-[80%] rounded-2xl rounded-br-sm bg-primary px-3.5 py-2 text-sm text-primary-foreground shadow-control">
            {message.attachmentNames && message.attachmentNames.length > 0 && (
              <div className="mb-1 flex flex-col gap-0.5 text-xs opacity-85">
                {message.attachmentNames.map((name) => (
                  <span
                    key={name}
                    className="inline-flex items-center gap-1 truncate"
                  >
                    <Paperclip className="size-3 shrink-0" />
                    <span className="truncate">{name}</span>
                  </span>
                ))}
              </div>
            )}
            <div className="break-words whitespace-pre-wrap">{message.content}</div>
          </div>
          {time && (
            <span className="mt-0.5 pr-1 text-[10px] text-faint">{time}</span>
          )}
        </div>
      );
    }

    // ─── Assistant bubble ────────────────────────────────────────
    return (
      <div className={cn("flex flex-col items-start", className)}>
        <div className="max-w-[80%] rounded-2xl rounded-bl-sm border border-border bg-card px-3.5 py-2 text-sm text-foreground shadow-control">
          {message.content ? (
            <div
              className="chat-markdown break-words"
              // Sanitized by renderMarkdown (DOMPurify) — safe to inject.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          ) : null}
          {message.streaming && (
            <span className="ml-0.5 inline-block animate-pulse-dot font-mono text-primary">
              ▍
            </span>
          )}
        </div>
        {time && (
          <span className="mt-0.5 pl-1 text-[10px] text-faint">{time}</span>
        )}
      </div>
    );
  },
);

MessageBubble.displayName = "MessageBubble";
