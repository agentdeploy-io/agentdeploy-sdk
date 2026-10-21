/**
 * SlashCommandMenu
 * ────────────────
 * Autocomplete popup for console slash commands (manifest arrives via
 * cf_agent_meta → useAgentConnection.commands). Rendered ABOVE the chat
 * input; the input owns keyboard navigation and passes activeIndex down.
 *
 * Tailwind rebuild of the playground AgentChatTab slash popup.
 */

import React, { useEffect, useRef } from "react";
import { cn } from "@/lib/utils";
import type { AgentCommand } from "@/hooks/useAgentConnection";

export interface SlashCommandMenuProps {
  /** Filtered candidates (already matched against the typed prefix). */
  commands: AgentCommand[];
  /** Highlighted candidate (arrow-key navigation lives in ChatInput). */
  activeIndex: number;
  onSelect: (command: AgentCommand) => void;
  onActiveIndexChange: (index: number) => void;
  className?: string;
}

export const SlashCommandMenu: React.FC<SlashCommandMenuProps> = ({
  commands,
  activeIndex,
  onSelect,
  onActiveIndexChange,
  className,
}) => {
  const listRef = useRef<HTMLDivElement>(null);

  // Keep the highlighted row visible while arrowing through a long list.
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const active = list.children[activeIndex] as HTMLElement | undefined;
    active?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (commands.length === 0) return null;

  return (
    <div
      ref={listRef}
      role="listbox"
      aria-label="Slash commands"
      className={cn(
        "scrollbar-thin max-h-56 overflow-y-auto rounded-lg border border-border bg-card shadow-float",
        className,
      )}
    >
      {commands.map((command, index) => (
        <button
          key={command.name}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          onMouseEnter={() => onActiveIndexChange(index)}
          // preventDefault keeps focus in the textarea when completing.
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onSelect(command)}
          className={cn(
            "block w-full border-b border-border px-3 py-2 text-left transition-colors last:border-b-0",
            index === activeIndex ? "bg-surface-hover" : "bg-transparent",
          )}
        >
          <span className="font-mono text-[0.8125rem] font-medium text-foreground">
            /{command.name}
            {command.args.length > 0 && (
              <span className="font-sans font-normal text-muted-foreground">
                {" "}
                {command.args
                  .map((a) => `<${a.name}${a.optional ? "?" : ""}>`)
                  .join(" ")}
              </span>
            )}
          </span>
          {command.description && (
            <span className="mt-0.5 block truncate text-xs text-muted-foreground">
              {command.description}
            </span>
          )}
        </button>
      ))}
    </div>
  );
};

SlashCommandMenu.displayName = "SlashCommandMenu";
