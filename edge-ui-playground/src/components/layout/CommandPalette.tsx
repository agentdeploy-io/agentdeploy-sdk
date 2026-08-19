/**
 * CommandPalette Component
 * ────────────────────────
 * Cmd+K (or Ctrl+K) command palette for fast keyboard navigation.
 * Inspired by Linear, Raycast, and Vercel dashboards.
 *
 * Features:
 *   - Fuzzy search across commands and agents
 *   - Keyboard navigation (arrow keys, enter, escape)
 *   - Grouped results (Navigation, Agents, Actions)
 *   - Recently used commands (future)
 *   - Inline command descriptions
 *
 * Commands:
 *   Navigation: go to overview, agents, conversations, workers, etc.
 *   Agents: go to support-agent, sales-agent, etc.
 *   Actions: toggle theme, clear data, reconnect agents
 */

import React from "react";
import { COLORS, RADIUS, Z_INDEX, TRANSITIONS } from "../../constants/theme";
import { NAV_GROUPS } from "../../constants/navigation";
import { AGENTS } from "../../constants/agents";
import type { ViewId } from "../../types/ui";

// ─── Types ───────────────────────────────────────────────────────

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  icon: React.ReactNode;
  group: string;
  keywords?: string;
  action: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onToggleTheme: () => void;
}

// ─── Component ───────────────────────────────────────────────────

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  onToggleTheme,
}) => {
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  // ─── Build Commands ───────────────────────────────────────────

  const commands = React.useMemo<CommandItem[]>(() => {
    const navCommands: CommandItem[] = NAV_GROUPS.flatMap((group) =>
      group.items
        .filter((item) => item.visible)
        .map((item) => ({
          id: `nav-${item.id}`,
          label: item.label,
          icon: "📍",
          group: "Navigation",
          keywords: item.path,
          action: () => {
            onNavigate(item.path);
            onClose();
          },
        })),
    );

    const agentCommands: CommandItem[] = AGENTS.map((agent) => ({
      id: `agent-${agent.id}`,
      label: agent.name,
      description: agent.description,
      icon: agent.icon,
      group: "Agents",
      keywords: agent.id,
      action: () => {
        onNavigate(`/agents/${agent.id}/chat`);
        onClose();
      },
    }));

    const actionCommands: CommandItem[] = [
      {
        id: "action-toggle-theme",
        label: "Toggle Theme",
        description: "Switch between light and dark mode",
        icon: "🎨",
        group: "Actions",
        action: () => {
          onToggleTheme();
          onClose();
        },
      },
      {
        id: "action-reload",
        label: "Reload Page",
        description: "Refresh the browser",
        icon: "🔄",
        group: "Actions",
        action: () => window.location.reload(),
      },
    ];

    return [...navCommands, ...agentCommands, ...actionCommands];
  }, [onNavigate, onClose, onToggleTheme]);

  // ─── Filter Commands ─────────────────────────────────────────

  const filteredCommands = React.useMemo(() => {
    if (!query.trim()) return commands;

    const q = query.toLowerCase();
    return commands.filter((cmd) => {
      return (
        cmd.label.toLowerCase().includes(q) ||
        cmd.description?.toLowerCase().includes(q) ||
        cmd.keywords?.toLowerCase().includes(q) ||
        cmd.group.toLowerCase().includes(q)
      );
    });
  }, [commands, query]);

  // ─── Group Filtered Commands ─────────────────────────────────

  const grouped = React.useMemo(() => {
    const groups: Record<string, CommandItem[]> = {};
    filteredCommands.forEach((cmd) => {
      if (!groups[cmd.group]) groups[cmd.group] = [];
      groups[cmd.group].push(cmd);
    });
    return Object.entries(groups);
  }, [filteredCommands]);

  // ─── Reset on open ───────────────────────────────────────────

  React.useEffect(() => {
    if (open) {
      setQuery("");
      setSelectedIndex(0);
      // Focus input after render
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  // ─── Clamp selection ─────────────────────────────────────────

  React.useEffect(() => {
    if (selectedIndex >= filteredCommands.length) {
      setSelectedIndex(0);
    }
  }, [filteredCommands.length, selectedIndex]);

  // ─── Keyboard Navigation ─────────────────────────────────────

  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => Math.min(prev + 1, filteredCommands.length - 1));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) => Math.max(prev - 1, 0));
          break;
        case "Enter":
          e.preventDefault();
          filteredCommands[selectedIndex]?.action();
          break;
        case "Escape":
          e.preventDefault();
          onClose();
          break;
      }
    },
    [filteredCommands, selectedIndex, onClose],
  );

  // ─── Scroll selected item into view ──────────────────────────

  React.useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const selected = list.querySelector(`[data-index="${selectedIndex}"]`);
    selected?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  // ─── Flatten for indexing ────────────────────────────────────

  let flatIndex = 0;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.4)",
          backdropFilter: "blur(2px)",
          zIndex: Z_INDEX.overlay,
          animation: "fadeIn 150ms ease-out",
        }}
      />

      {/* Palette */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onKeyDown={handleKeyDown}
        style={{
          position: "fixed",
          top: "20vh",
          left: "50%",
          transform: "translateX(-50%)",
          width: "min(560px, 90vw)",
          maxHeight: "60vh",
          backgroundColor: COLORS.card,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          boxShadow: "0 20px 45px -5px rgba(0,0,0,0.15), 0 8px 10px -6px rgba(0,0,0,0.08)",
          zIndex: Z_INDEX.modal,
          overflow: "hidden",
          display: "flex",
          flexDirection: "column",
          animation: "slideIn 150ms ease-out",
        }}
      >
        {/* Search Input */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "12px",
            padding: "16px 20px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={COLORS.mutedForeground} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Type a command or search…"
            style={{
              flex: 1,
              border: "none",
              outline: "none",
              backgroundColor: "transparent",
              color: COLORS.foreground,
              fontSize: "0.9375rem",
              fontFamily: "inherit",
            }}
          />
          <kbd
            style={{
              fontSize: "0.6875rem",
              padding: "2px 6px",
              borderRadius: "4px",
              backgroundColor: COLORS.secondary,
              color: COLORS.mutedForeground,
              fontWeight: 500,
            }}
          >
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} style={{ overflowY: "auto", flex: 1, padding: "8px" }}>
          {grouped.length === 0 ? (
            <div
              style={{
                padding: "32px",
                textAlign: "center",
                color: COLORS.mutedForeground,
                fontSize: "0.875rem",
              }}
            >
              No results for "{query}"
            </div>
          ) : (
            grouped.map(([groupName, items]) => (
              <div key={groupName} style={{ marginBottom: "8px" }}>
                {/* Group Header */}
                <div
                  style={{
                    fontSize: "0.6875rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.06em",
                    color: COLORS.mutedForeground,
                    padding: "8px 12px 4px",
                  }}
                >
                  {groupName}
                </div>

                {/* Items */}
                {items.map((cmd) => {
                  const idx = flatIndex++;
                  const isSelected = idx === selectedIndex;
                  return (
                    <button
                      key={cmd.id}
                      data-index={idx}
                      onMouseEnter={() => setSelectedIndex(idx)}
                      onClick={cmd.action}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: "12px",
                        width: "100%",
                        padding: "8px 12px",
                        borderRadius: RADIUS.md,
                        border: "none",
                        backgroundColor: isSelected ? COLORS.secondary : "transparent",
                        cursor: "pointer",
                        textAlign: "left",
                        transition: `background-color ${TRANSITIONS.fast}`,
                      }}
                    >
                      <span style={{ fontSize: "1rem", flexShrink: 0 }}>{cmd.icon}</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontSize: "0.875rem",
                            fontWeight: 500,
                            color: isSelected ? COLORS.foreground : COLORS.foreground,
                          }}
                        >
                          {cmd.label}
                        </div>
                        {cmd.description && (
                          <div
                            style={{
                              fontSize: "0.75rem",
                              color: COLORS.mutedForeground,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {cmd.description}
                          </div>
                        )}
                      </div>
                      {isSelected && (
                        <kbd
                          style={{
                            fontSize: "0.6875rem",
                            padding: "2px 6px",
                            borderRadius: "4px",
                            backgroundColor: COLORS.card,
                            color: COLORS.mutedForeground,
                            border: `1px solid ${COLORS.border}`,
                          }}
                        >
                          ↵
                        </kbd>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "8px 20px",
            borderTop: `1px solid ${COLORS.border}`,
            fontSize: "0.75rem",
            color: COLORS.mutedForeground,
          }}
        >
          <div style={{ display: "flex", gap: "12px" }}>
            <span>
              <kbd style={kbdStyle}>↑</kbd> <kbd style={kbdStyle}>↓</kbd> Navigate
            </span>
            <span>
              <kbd style={kbdStyle}>↵</kbd> Select
            </span>
          </div>
          <span>{filteredCommands.length} results</span>
        </div>
      </div>
    </>
  );
};

const kbdStyle: React.CSSProperties = {
  fontSize: "0.6875rem",
  padding: "1px 5px",
  borderRadius: "3px",
  backgroundColor: "transparent",
  border: `1px solid ${COLORS.border}`,
  fontFamily: "inherit",
};
