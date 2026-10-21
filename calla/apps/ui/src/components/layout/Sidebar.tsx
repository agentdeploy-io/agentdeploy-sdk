/**
 * Sidebar — Calla primary navigation
 * ──────────────────────────────────
 * Brand (whitelabelable via BRAND_NAME/BRAND_TAGLINE), top-level screens
 * (Fleet, Data, Approvals, Conversations, Reports), then the live agent
 * registry. Footer carries the Setup link, the theme toggle and the
 * signed-in identity.
 *
 * Tailwind rebuild of the playground Sidebar (no inline styles, no
 * hand-rolled SVGs — lucide-react + design tokens).
 */

import * as React from "react";
import {
  BarChart3,
  Database,
  Flower2,
  Inbox,
  LayoutDashboard,
  LogOut,
  MessagesSquare,
  Moon,
  Phone,
  Settings,
  Sun,
} from "lucide-react";
import { isModuleEnabled, type AgentStatus, type ModuleId } from "@calla/shared";
import { Badge } from "@/components/ui";
import { useConsoleApprovals, useConsoleEvents } from "@/components/layout/console-context";
import { deriveAgentStatus, lastEventForAgent } from "@/components/AgentCard";
import { getCallaConfig } from "@/config";
import { buildAgentRoute, useAgentRegistry, useAuth, useTheme } from "@/hooks";
import { useModuleConfig } from "@/lib/modules";
import { cn } from "@/lib/utils";
import type { Route } from "@/types/ui";

export interface SidebarProps {
  route: Route;
  onNavigate: (path: string) => void;
  className?: string;
}

interface NavEntry {
  /** Module id this nav item belongs to (gated by the deployment config). */
  id: ModuleId;
  label: string;
  path: string;
  Icon: React.ComponentType<{ className?: string }>;
}

const NAV_ITEMS: NavEntry[] = [
  { id: "fleet", label: "Fleet", path: "/", Icon: LayoutDashboard },
  { id: "data", label: "Data", path: "/data", Icon: Database },
  { id: "inbox", label: "Approvals", path: "/inbox", Icon: Inbox },
  { id: "conversations", label: "Conversations", path: "/conversations", Icon: MessagesSquare },
  { id: "reports", label: "Reports", path: "/reports", Icon: BarChart3 },
  { id: "voice", label: "Calls", path: "/calls", Icon: Phone },
];

export const Sidebar = React.memo<SidebarProps>(({ route, onNavigate, className }) => {
  const brand = React.useMemo(() => getCallaConfig(), []);
  const { modules } = useModuleConfig();
  const navItems = NAV_ITEMS.filter((item) => isModuleEnabled(item.id, modules));
  const showAgents = isModuleEnabled("agents", modules);
  const { agents, loading } = useAgentRegistry();
  const { counts, approvals } = useConsoleApprovals();
  const { events } = useConsoleEvents();
  const { user, authDisabled, logout } = useAuth();
  const { resolvedTheme, toggleTheme } = useTheme();

  const pendingByAgent = React.useMemo(() => {
    const map = new Map<string, number>();
    for (const a of approvals) {
      if (a.status !== "pending") continue;
      map.set(a.agentId, (map.get(a.agentId) ?? 0) + 1);
    }
    return map;
  }, [approvals]);

  const statusByAgent = React.useMemo(() => {
    const map = new Map<string, AgentStatus>();
    for (const agent of agents) {
      map.set(
        agent.id,
        deriveAgentStatus(agent, {
          pendingCount: pendingByAgent.get(agent.id) ?? 0,
          events: events.filter((e) => e.agentId === agent.id),
        }),
      );
    }
    return map;
  }, [agents, pendingByAgent, events]);

  const isAgentRoute = route.view === "agent-detail";

  return (
    <aside
      className={cn(
        "flex h-full w-64 shrink-0 flex-col border-r border-border bg-surface-sidebar",
        className,
      )}
    >
      {/* ─── Brand ─────────────────────────────────────────── */}
      <div className="flex h-14 shrink-0 items-center gap-2.5 border-b border-border px-4">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground shadow-control">
          <Flower2 className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="truncate text-[0.9375rem] font-bold leading-tight text-foreground">
            {brand.BRAND_NAME}
          </div>
          <div className="truncate text-[0.6875rem] leading-tight text-muted-foreground">
            {brand.BRAND_TAGLINE}
          </div>
        </div>
      </div>

      {/* ─── Navigation ────────────────────────────────────── */}
      <nav className="scrollbar-thin flex-1 overflow-y-auto px-3 py-4">
        <div className="flex flex-col gap-0.5">
          {navItems.map(({ id, label, path, Icon }) => {
            const active = route.view === id;
            return (
              <button
                key={id}
                type="button"
                onClick={() => onNavigate(path)}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "flex h-9 items-center gap-3 rounded-md px-3 text-sm transition-colors",
                  active
                    ? "bg-secondary font-semibold text-foreground"
                    : "font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                )}
              >
                <Icon className={cn("size-4 shrink-0", active && "text-primary")} />
                <span className="flex-1 truncate text-left">{label}</span>
                {id === "inbox" && counts.pending > 0 && (
                  <Badge variant="warning" className="px-1.5 py-0 text-[0.625rem]">
                    {counts.pending > 99 ? "99+" : counts.pending}
                  </Badge>
                )}
              </button>
            );
          })}
        </div>

        {/* ─── Agents (gated by the "agents" module) ─────────── */}
        {showAgents && (
          <>
        <div className="my-4 border-t border-border" />
        <div className="px-3 pb-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
          Agents
        </div>

        {loading ? (
          <div className="flex flex-col gap-1 px-1">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-8 animate-pulse rounded-md bg-surface-hover" />
            ))}
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            {agents.map((agent) => {
              const active = isAgentRoute && route.agentId === agent.id;
              const status = statusByAgent.get(agent.id) ?? "unknown";
              const pending = pendingByAgent.get(agent.id) ?? 0;
              const last = lastEventForAgent(events, agent.id);
              return (
                <button
                  key={agent.id}
                  type="button"
                  onClick={() => onNavigate(buildAgentRoute(agent.id, "chat"))}
                  title={last ? `${agent.name} — ${last.type}` : agent.name}
                  className={cn(
                    "flex h-9 items-center gap-2.5 rounded-md px-3 text-sm transition-colors",
                    active
                      ? "bg-secondary font-semibold text-foreground"
                      : "font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground",
                  )}
                >
                  <span aria-hidden className="shrink-0 text-base leading-none">
                    {agent.icon}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-left">{agent.name}</span>
                  {pending > 0 ? (
                    <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[0.625rem] font-semibold text-warning">
                      {pending}
                    </span>
                  ) : (
                    <span
                      className={cn(
                        "inline-block size-2 shrink-0 rounded-full",
                        status === "running" && "bg-success",
                        status === "idle" && "bg-info",
                        status === "awaiting_approval" && "bg-warning animate-pulse-dot",
                        status === "error" && "bg-destructive",
                        (status === "offline" || status === "unknown") && "bg-muted-foreground/40",
                      )}
                      aria-label={status}
                    />
                  )}
                </button>
              );
            })}
          </div>
        )}
          </>
        )}
      </nav>

      {/* ─── Footer: setup + theme + identity ──────────────── */}
      <div className="shrink-0 space-y-1 border-t border-border p-3">
        <button
          type="button"
          onClick={() => onNavigate("/setup")}
          aria-current={route.view === "setup" ? "page" : undefined}
          className={cn(
            "flex h-9 w-full items-center gap-3 rounded-md px-3 text-sm transition-colors",
            route.view === "setup"
              ? "bg-secondary font-semibold text-foreground"
              : "font-medium text-muted-foreground hover:bg-surface-hover hover:text-foreground",
          )}
        >
          <Settings
            className={cn("size-4 shrink-0", route.view === "setup" && "text-primary")}
          />
          <span className="flex-1 truncate text-left">Setup</span>
        </button>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={toggleTheme}
            aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} mode`}
            title="Toggle theme (T)"
            className="flex size-8 shrink-0 items-center justify-center rounded-md border border-border text-muted-foreground shadow-control transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>

          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-medium text-foreground">
              {user?.name ?? (authDisabled ? "Local dev" : "Signed out")}
            </div>
            <div className="truncate text-[0.6875rem] text-faint">
              {user?.email ?? "no session"}
            </div>
          </div>

          {!authDisabled && (
            <button
              type="button"
              onClick={logout}
              aria-label="Sign out"
              title="Sign out"
              className="flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
            >
              <LogOut className="size-4" />
            </button>
          )}
        </div>
      </div>
    </aside>
  );
});

Sidebar.displayName = "Sidebar";
