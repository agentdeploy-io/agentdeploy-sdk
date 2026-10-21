/**
 * MessageList
 * ───────────
 * Scrollable chat transcript with the playground's auto-scroll rules:
 *   - jump to bottom on a NEW user message (always)
 *   - follow new assistant messages / streaming growth ONLY when the
 *     reader is already near the bottom (within NEAR_BOTTOM_PX)
 *   - floating "scroll to latest" button while scrolled up
 *   - friendly empty state
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import { MessageBubble } from "./MessageBubble";
import { cn } from "@/lib/utils";
import type { ChatMessage } from "@/types/agent";

/** Distance from the bottom (px) still considered "following" the stream. */
const NEAR_BOTTOM_PX = 120;

export interface MessageListProps {
  messages: ChatMessage[];
  /** Shown in the empty state (default "No messages yet — say hello"). */
  emptyMessage?: string;
  className?: string;
}

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  emptyMessage = "No messages yet — say hello",
  className,
}) => {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [showScrollButton, setShowScrollButton] = useState(false);
  const prevCountRef = useRef(0);
  const prevContentLenRef = useRef(0);

  const isNearBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX;
  }, []);

  const scrollToBottom = useCallback((smooth = true) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({
      top: el.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  const handleScroll = useCallback(() => {
    setShowScrollButton(!isNearBottom());
  }, [isNearBottom]);

  // Auto-scroll on new messages / streaming growth (only while near bottom).
  useEffect(() => {
    const wasNearBottom = isNearBottom();
    const newCount = messages.length;
    const oldCount = prevCountRef.current;
    prevCountRef.current = newCount;

    // Streaming updates the LAST message's content in place — track total
    // content length so long replies keep following to the bottom.
    const totalContentLen = messages.reduce(
      (n, m) => n + (m.content ? m.content.length : 0),
      0,
    );
    const contentGrew = totalContentLen > prevContentLenRef.current;
    prevContentLenRef.current = totalContentLen;

    if (newCount > oldCount) {
      const last = messages[messages.length - 1];
      if (last?.role === "user") {
        // The reader's own message — always jump, after layout settles.
        requestAnimationFrame(() => scrollToBottom(false));
      } else if (wasNearBottom) {
        scrollToBottom();
      }
      return;
    }

    if (contentGrew && isNearBottom()) {
      // Instant while streaming so the view doesn't lag behind the deltas.
      scrollToBottom(false);
    }
  }, [messages, isNearBottom, scrollToBottom]);

  return (
    <div className={cn("relative min-h-0 flex-1", className)}>
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="scrollbar-thin h-full overflow-y-auto p-4"
      >
        {messages.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
            <MessageSquare className="size-8 opacity-50" aria-hidden />
            <span className="text-sm">{emptyMessage}</span>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {messages.map((message) => (
              <MessageBubble key={message.id} message={message} />
            ))}
          </div>
        )}
      </div>

      {showScrollButton && messages.length > 0 && (
        <button
          type="button"
          onClick={() => scrollToBottom()}
          aria-label="Scroll to latest"
          className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-card text-foreground shadow-elevated transition-colors hover:bg-surface-hover"
        >
          <ChevronDown className="size-4" />
        </button>
      )}
    </div>
  );
};

MessageList.displayName = "MessageList";
