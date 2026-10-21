/**
 * ChatInput
 * ─────────
 * Auto-growing composer for an edge agent chat:
 *   - Enter sends, Shift+Enter inserts a newline, max 8 rows then scrolls
 *   - Disabled (with reason) whenever the WS isn't connected
 *   - Send button (idle) ⇄ Stop button (variant destructive) while streaming
 *   - Slash-command autocomplete: typing "/…" filters `commands` into a
 *     SlashCommandMenu above the input; Arrow keys navigate, Tab/Enter
 *     complete, Escape dismisses.
 *   - Sending a matched slash command POSTs {agentCmdPrefix}/cmd/{name}
 *     (120s timeout) and appends the rendered result as a system message.
 *
 * Tailwind rebuild of the playground AgentChatTab composer. Voice input and
 * file attachments are intentionally omitted (future work).
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Send, Square } from "lucide-react";
import { Button, Textarea } from "@/components/ui";
import { SlashCommandMenu } from "./SlashCommandMenu";
import { agentCmdPrefix, type AgentRegistryEntry } from "@/constants/agents";
import { authFetch } from "@/hooks/useAuthFetch";
import { toast } from "@/hooks/useToast";
import { cn } from "@/lib/utils";
import type { AgentCommand } from "@/hooks/useAgentConnection";
import type { AgentConnectionStatus, ChatMessage } from "@/types/agent";

/** Cap the auto-grow at ~8 rows before the textarea scrolls internally. */
const MAX_HEIGHT_PX = 8 * 24;
const COMMAND_TIMEOUT_MS = 120_000;

export interface ChatInputProps {
  agent: AgentRegistryEntry;
  status: AgentConnectionStatus;
  isStreaming: boolean;
  commands?: AgentCommand[];
  /** Send a normal chat turn (WebSocket). */
  onSend: (text: string) => void;
  /** Abort the in-flight reply. */
  onStop: () => void;
  /** Append a message to the pane (slash-command echo + results). */
  appendMessage: (message: ChatMessage) => void;
  className?: string;
}

// ─── Slash-command parsing ───────────────────────────────────────

/**
 * Char-scan tokenizer for console commands. Whitespace separates tokens, but
 * quotes group — and are stripped from — the run they wrap, even mid-token, so
 * both `key="quoted value"` and `"whole quoted"` collapse to one token with the
 * quotes removed. (The playground split on whitespace first, which mis-parsed
 * inline quotes like key="a b" as a malformed arg.)
 */
function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) tokens.push(current);
  return tokens;
}

function parseArgs(
  tokens: string[],
): { args: Record<string, string>; malformed: string | null } {
  const args: Record<string, string> = {};
  for (const token of tokens) {
    const eq = token.indexOf("=");
    if (eq <= 0) return { args, malformed: token };
    args[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return { args, malformed: null };
}

function makeId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const ChatInput: React.FC<ChatInputProps> = ({
  agent,
  status,
  isStreaming,
  commands = [],
  onSend,
  onStop,
  appendMessage,
  className,
}) => {
  const [input, setInput] = useState("");
  const [commandBusy, setCommandBusy] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const agentPrefix = useMemo(() => agentCmdPrefix(agent), [agent]);

  const isConnected = status === "connected";

  // ─── Autocomplete candidates ───────────────────────────────────
  const slashMatch = useMemo(() => {
    const m = input.match(/^\/([\w-]*)$/);
    return m ? m[1] : null;
  }, [input]);

  const slashCandidates = useMemo(() => {
    if (slashMatch === null || commands.length === 0) return [];
    if (slashMatch === "") return commands;
    return commands.filter((c) => c.name.startsWith(slashMatch));
  }, [slashMatch, commands]);

  const menuOpen = slashCandidates.length > 0 && !dismissed && !commandBusy;

  // Reset the highlight whenever the typed prefix changes.
  useEffect(() => {
    setActiveIndex(0);
  }, [slashMatch]);

  // Clamp the highlight if the candidate list shrinks.
  useEffect(() => {
    setActiveIndex((i) => Math.min(i, Math.max(0, slashCandidates.length - 1)));
  }, [slashCandidates.length]);

  // ─── Auto-grow ─────────────────────────────────────────────────
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, MAX_HEIGHT_PX)}px`;
  }, [input]);

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    // Any edit re-arms the menu after an Escape.
    if (dismissed) setDismissed(false);
  };

  const complete = useCallback(
    (command: AgentCommand) => {
      setInput(`/${command.name} `);
      setDismissed(false);
      requestAnimationFrame(() => textareaRef.current?.focus());
    },
    [],
  );

  // ─── Slash-command execution ───────────────────────────────────
  const runSlashCommand = useCallback(
    async (text: string): Promise<void> => {
      const tokens = tokenize(text.slice(1));
      const name = tokens[0];
      const cmd = commands.find((c) => c.name === name);
      if (!cmd) return;

      if (!agentPrefix) {
        toast.error("Command", "No agent proxy route available.");
        return;
      }

      const { args, malformed } = parseArgs(tokens.slice(1));
      if (malformed !== null) {
        toast.error(`/${cmd.name}`, `Malformed argument: ${malformed} (expected key=value)`);
        return;
      }
      const missing = cmd.args.filter((a) => !a.optional && !(a.name in args));
      if (missing.length > 0) {
        toast.error(
          `/${cmd.name}`,
          `Missing required argument: ${missing.map((a) => a.name).join(", ")}`,
        );
        return;
      }

      setCommandBusy(true);
      appendMessage({
        id: makeId("cmd-in"),
        role: "user",
        content: text,
        timestamp: new Date().toISOString(),
      });

      try {
        const res = await authFetch(`${agentPrefix}/cmd/${cmd.name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(COMMAND_TIMEOUT_MS),
        });
        const payload: unknown = await res.json().catch(() => null);
        let content: string;
        if (!res.ok) {
          const msg =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error: unknown }).error)
              : `Command failed (${res.status})`;
          content = `**/${cmd.name}** failed: ${msg}`;
        } else if (cmd.render === "markdown") {
          const md =
            payload && typeof payload === "object" && "result" in payload
              ? (payload as { result: unknown }).result
              : payload;
          content = typeof md === "string" ? md : `**/${cmd.name}**\n\n\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
        } else {
          // json + table (table renders as pretty JSON for now).
          content = `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\``;
        }
        appendMessage({
          id: makeId("cmd-out"),
          role: "system",
          content,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        appendMessage({
          id: makeId("cmd-err"),
          role: "system",
          content: `**/${cmd.name}** failed: ${err instanceof Error ? err.message : "network error"}`,
          timestamp: new Date().toISOString(),
        });
      } finally {
        setCommandBusy(false);
      }
    },
    [commands, agentPrefix, appendMessage],
  );

  const submit = useCallback(() => {
    const text = input.trim();
    if (!text || isStreaming || commandBusy || !isConnected) return;
    const isCommand =
      text.startsWith("/") &&
      commands.some((c) => tokenize(text.slice(1))[0] === c.name);
    if (isCommand) {
      void runSlashCommand(text);
      setInput("");
      return;
    }
    onSend(text);
    setInput("");
  }, [input, isStreaming, commandBusy, isConnected, commands, runSlashCommand, onSend]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Autocomplete navigation takes precedence while the menu is open.
    if (menuOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % slashCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + slashCandidates.length) % slashCandidates.length);
        return;
      }
      if (e.key === "Tab" || (e.key === "Enter" && !e.shiftKey)) {
        e.preventDefault();
        const pick = slashCandidates[activeIndex] ?? slashCandidates[0];
        if (pick) complete(pick);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(true);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  const disabledReason =
    status === "connecting"
      ? "Connecting…"
      : status === "error"
        ? "Connection error — reconnect to chat"
        : status === "disconnected"
          ? "Disconnected — reconnect to chat"
          : null;

  const placeholder = isConnected
    ? `Message ${agent.name}…  (type / for commands)`
    : (disabledReason ?? "Connect to send messages");

  const canSend = isConnected && input.trim().length > 0 && !isStreaming && !commandBusy;

  return (
    <div className={cn("relative border-t border-border p-3", className)}>
      {menuOpen && (
        <div className="absolute inset-x-3 bottom-full z-20 mb-2">
          <SlashCommandMenu
            commands={slashCandidates}
            activeIndex={activeIndex}
            onSelect={complete}
            onActiveIndexChange={setActiveIndex}
          />
        </div>
      )}

      <div className="flex items-end gap-2">
        <Textarea
          ref={textareaRef}
          value={input}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          rows={1}
          disabled={!isConnected || isStreaming}
          placeholder={placeholder}
          className="scrollbar-thin max-h-48 min-h-[40px] flex-1 resize-none overflow-y-auto py-2.5 leading-6"
          aria-label={`Message ${agent.name}`}
        />

        {isStreaming ? (
          <Button
            type="button"
            variant="destructive"
            size="icon"
            onClick={onStop}
            title="Stop generating"
            aria-label="Stop generating"
          >
            <Square className="size-4" />
          </Button>
        ) : (
          <Button
            type="button"
            size="icon"
            onClick={submit}
            disabled={!canSend}
            title={commandBusy ? "Running command…" : "Send"}
            aria-label="Send message"
          >
            <Send className="size-4" />
          </Button>
        )}
      </div>

      {commandBusy && (
        <p className="mt-1.5 text-[0.6875rem] text-muted-foreground">Running command…</p>
      )}
    </div>
  );
};

ChatInput.displayName = "ChatInput";
