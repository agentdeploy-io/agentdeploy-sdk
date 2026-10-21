/**
 * CommandPalette — ⌘K quick launcher
 * ──────────────────────────────────
 * Behavior ported from the playground palette, rebuilt on Tailwind tokens:
 * substring filter over label/description/keywords, grouped results
 * (Navigate / Agents / Actions), ↑↓ to move, Enter to run, Esc to close.
 */

import * as React from "react";
import {
  BarChart3,
  Database,
  Inbox,
  LayoutDashboard,
  MessagesSquare,
  Phone,
  RefreshCw,
  Search,
  Settings,
  SunMoon,
} from "lucide-react";
import { isModuleEnabled, type ModuleId } from "@calla/shared";
import { buildAgentRoute, useAgentRegistry } from "@/hooks";
import { useModuleConfig } from "@/lib/modules";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────

export interface CommandItem {
  id: string;
  label: string;
  description?: string;
  group: string;
  keywords?: string;
  icon: React.ReactNode;
  action: () => void;
  /** Owning module — hidden when the deployment disables it. */
  module?: ModuleId;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (path: string) => void;
  onToggleTheme: () => void;
  onReconnect: () => void;
}

const GROUP_ORDER = ["Navigate", "Agents", "Actions"];

// ─── Component ───────────────────────────────────────────────────

export const CommandPalette: React.FC<CommandPaletteProps> = ({
  open,
  onClose,
  onNavigate,
  onToggleTheme,
  onReconnect,
}) => {
  const { agents } = useAgentRegistry();
  const { modules } = useModuleConfig();
  const [query, setQuery] = React.useState("");
  const [selectedIndex, setSelectedIndex] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);

  const commands = React.useMemo<CommandItem[]>(() => {
    const allNav: CommandItem[] = [
      {
        id: "nav-fleet",
        label: "Fleet",
        description: "All agents, live status, pending approvals",
        group: "Navigate",
        keywords: "home overview dashboard agents g o",
        icon: <LayoutDashboard className="size-4" />,
        action: () => onNavigate("/"),
        module: "fleet",
      },
      {
        id: "nav-data",
        label: "Data",
        description: "Scraped leads — bulk outreach approval",
        group: "Navigate",
        keywords: "leads table bulk data g d",
        icon: <Database className="size-4" />,
        action: () => onNavigate("/data"),
        module: "data",
      },
      {
        id: "nav-inbox",
        label: "Approvals",
        description: "Unified HITL inbox",
        group: "Navigate",
        keywords: "inbox hitl review decisions g i",
        icon: <Inbox className="size-4" />,
        action: () => onNavigate("/inbox"),
        module: "inbox",
      },
      {
        id: "nav-conversations",
        label: "Conversations",
        description: "Customer DM threads — takeover, reply, flow status",
        group: "Navigate",
        keywords: "conversations messages threads instagram whatsapp tiktok dm g c",
        icon: <MessagesSquare className="size-4" />,
        action: () => onNavigate("/conversations"),
        module: "conversations",
      },
      {
        id: "nav-reports",
        label: "Reports",
        description: "Funnel, lead sources, flows, appointments",
        group: "Navigate",
        keywords: "reports funnel metrics appointments flows g r",
        icon: <BarChart3 className="size-4" />,
        action: () => onNavigate("/reports"),
        module: "reports",
      },
      {
        id: "nav-calls",
        label: "Calls",
        description: "Live voice agent — transcript, status, takeover",
        group: "Navigate",
        keywords: "calls voice phone receptionist telephony g v",
        icon: <Phone className="size-4" />,
        action: () => onNavigate("/calls"),
        module: "voice",
      },
      {
        id: "nav-setup",
        label: "Setup",
        description: "Setup checklist — channels, booking, flows, login",
        group: "Navigate",
        keywords: "setup checklist onboarding connect channels configuration",
        icon: <Settings className="size-4" />,
        action: () => onNavigate("/setup"),
        module: "setup",
      },
    ];
    const navigate = allNav.filter((cmd) => !cmd.module || isModuleEnabled(cmd.module, modules));

    const agentCommands: CommandItem[] = isModuleEnabled("agents", modules)
      ? agents.map((agent) => ({
          id: `agent-${agent.id}`,
          label: agent.name,
          description: agent.description,
          group: "Agents",
          keywords: `${agent.id} ${agent.runtime} chat`,
          icon: <span className="text-sm leading-none">{agent.icon}</span>,
          action: () => onNavigate(buildAgentRoute(agent.id, "chat")),
        }))
      : [];

    const actions: CommandItem[] = [
      {
        id: "action-theme",
        label: "Toggle theme",
        description: "Switch between light and dark mode",
        group: "Actions",
        keywords: "dark light appearance t",
        icon: <SunMoon className="size-4" />,
        action: onToggleTheme,
      },
      {
        id: "action-reconnect",
        label: "Reconnect event feed",
        description: "Re-open the /events WebSocket",
        group: "Actions",
        keywords: "events websocket reconnect ws live",
        icon: <RefreshCw className="size-4" />,
        action: onReconnect,
      },
    ];

    return [...navigate, ...agentCommands, ...actions];
  }, [agents, modules, onNavigate, onToggleTheme, onReconnect]);

  const filtered = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((cmd) =>
      [cmd.label, cmd.description ?? "", cmd.keywords ?? "", cmd.group]
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [commands, query]);

  const grouped = React.useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const cmd of filtered) {
      const list = map.get(cmd.group);
      if (list) list.push(cmd);
      else map.set(cmd.group, [cmd]);
    }
    return GROUP_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!] as const);
  }, [filtered]);

  // Reset + focus on open.
  React.useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIndex(0);
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Clamp selection when the filtered list shrinks.
  React.useEffect(() => {
    setSelectedIndex((prev) => (prev >= filtered.length ? 0 : prev));
  }, [filtered.length]);

  // Global key handling while open (the input may not hold focus).
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSelectedIndex((prev) => (filtered.length === 0 ? 0 : (prev + 1) % filtered.length));
          break;
        case "ArrowUp":
          e.preventDefault();
          setSelectedIndex((prev) =>
            filtered.length === 0 ? 0 : (prev - 1 + filtered.length) % filtered.length,
          );
          break;
        case "Enter": {
          e.preventDefault();
          const cmd = filtered[selectedIndex];
          if (!cmd) return;
          cmd.action();
          onClose();
          break;
        }
        case "Escape":
          e.preventDefault();
          onClose();
          break;
        default:
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, filtered, selectedIndex, onClose]);

  // Keep the highlighted row visible.
  React.useEffect(() => {
    const node = listRef.current?.querySelector(`[data-index="${selectedIndex}"]`);
    node?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (!open) return null;

  let flatIndex = -1;

  return (
    <div className="fixed inset-0 z-50" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]" onClick={onClose} />

      <div className="relative left-1/2 top-[18vh] flex max-h-[60vh] w-[min(560px,90vw)] -translate-x-1/2 flex-col overflow-hidden rounded-xl border border-border bg-surface-overlay shadow-float animate-fade-in">
        {/* Search */}
        <div className="flex items-center gap-3 border-b border-border px-4 py-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search screens, agents, actions…"
            aria-label="Command palette search"
            className="w-full bg-transparent text-sm text-foreground placeholder:text-faint focus:outline-none"
          />
          <kbd className="shrink-0 rounded-sm border border-border bg-surface-tag px-1.5 py-0.5 text-[0.625rem] font-semibold text-muted-foreground">
            ESC
          </kbd>
        </div>

        {/* Results */}
        <div ref={listRef} className="scrollbar-thin flex-1 overflow-y-auto p-2">
          {grouped.length === 0 && (
            <div className="px-3 py-10 text-center text-sm text-muted-foreground">
              No commands match “{query}”
            </div>
          )}

          {grouped.map(([group, items]) => (
            <div key={group} className="mb-1 last:mb-0">
              <div className="px-3 py-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
                {group}
              </div>
              {items.map((cmd) => {
                flatIndex += 1;
                const index = flatIndex;
                const selected = index === selectedIndex;
                return (
                  <button
                    key={cmd.id}
                    type="button"
                    data-index={index}
                    onClick={() => {
                      cmd.action();
                      onClose();
                    }}
                    onMouseMove={() => setSelectedIndex(index)}
                    className={cn(
                      "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left transition-colors",
                      selected ? "bg-secondary text-foreground" : "text-body hover:bg-surface-hover",
                    )}
                  >
                    <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                      {cmd.icon}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{cmd.label}</span>
                      {cmd.description && (
                        <span className="block truncate text-[0.6875rem] text-muted-foreground">
                          {cmd.description}
                        </span>
                      )}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* Footer hints */}
        <div className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-2 text-[0.6875rem] text-faint">
          <span>↑↓ navigate</span>
          <span>↵ select</span>
          <span className="ml-auto">{filtered.length} commands</span>
        </div>
      </div>
    </div>
  );
};

CommandPalette.displayName = "CommandPalette";
