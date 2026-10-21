/**
 * TopBar — breadcrumbs + live feed status + command palette trigger
 * ─────────────────────────────────────────────────────────────────
 * Sticky, translucent panel. The /events connection state is owned by
 * ConsoleLayout (one socket for the whole shell) and handed down as props.
 */

import * as React from "react";
import { ChevronRight, Menu, Moon, RefreshCw, Search, Sun } from "lucide-react";
import type { AgentStatus } from "@calla/shared";
import { Button, StatusDot } from "@/components/ui";
import { useAgentRegistry, useTheme, type CallaEventsStatus } from "@/hooks";
import { cn } from "@/lib/utils";
import type { Route } from "@/types/ui";

export interface TopBarProps {
  route: Route;
  /** Mobile only — opens the sidebar drawer. */
  onOpenMenu?: () => void;
  onOpenPalette: () => void;
  eventsStatus: CallaEventsStatus;
  onReconnect: () => void;
}

const FEED_STATUS: Record<CallaEventsStatus, { dot: AgentStatus; label: string }> = {
  connected: { dot: "running", label: "Live" },
  connecting: { dot: "idle", label: "Connecting…" },
  disconnected: { dot: "offline", label: "Offline" },
  error: { dot: "error", label: "Feed error" },
};

function useBreadcrumbs(route: Route): Array<{ label: string; path?: string }> {
  const { getAgentById } = useAgentRegistry();

  return React.useMemo(() => {
    switch (route.view) {
      case "fleet":
        return [{ label: "Fleet" }];
      case "data":
        return [{ label: "Data" }];
      case "inbox":
        return [{ label: "Approvals" }];
      case "conversations":
        return [{ label: "Conversations" }];
      case "reports":
        return [{ label: "Reports" }];
      case "setup":
        return [{ label: "Setup" }];
      case "agent-detail": {
        const agent = route.agentId ? getAgentById(route.agentId) : undefined;
        const crumbs: Array<{ label: string; path?: string }> = [{ label: "Agents", path: "/" }];
        crumbs.push({
          label: agent?.name ?? route.agentId ?? "Agent",
          ...(route.agentId ? { path: `/agents/${route.agentId}/chat` } : {}),
        });
        if (route.tab && route.tab !== "chat") {
          crumbs.push({ label: route.tab });
        }
        return crumbs;
      }
      default:
        return [{ label: "Not found" }];
    }
  }, [route.view, route.agentId, route.tab, getAgentById]);
}

export const TopBar = React.memo<TopBarProps>(
  ({ route, onOpenMenu, onOpenPalette, eventsStatus, onReconnect }) => {
    const crumbs = useBreadcrumbs(route);
    const feed = FEED_STATUS[eventsStatus] ?? FEED_STATUS.disconnected;
    const { resolvedTheme, toggleTheme } = useTheme();

    return (
      <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-2 border-b border-border bg-surface-panel/80 px-3 backdrop-blur sm:px-5">
        {onOpenMenu && (
          <Button variant="ghost" size="icon" onClick={onOpenMenu} aria-label="Open menu">
            <Menu className="size-5" />
          </Button>
        )}

        {/* Breadcrumbs */}
        <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-1.5">
          {crumbs.map((crumb, i) => {
            const last = i === crumbs.length - 1;
            return (
              <React.Fragment key={`${crumb.label}-${i}`}>
                {i > 0 && <ChevronRight className="size-3.5 shrink-0 text-faint" />}
                {crumb.path && !last ? (
                  <span className="truncate text-sm text-muted-foreground">{crumb.label}</span>
                ) : (
                  <span
                    className={cn(
                      "truncate text-sm",
                      last ? "font-semibold text-foreground" : "text-muted-foreground",
                    )}
                  >
                    {crumb.label}
                  </span>
                )}
              </React.Fragment>
            );
          })}
        </nav>

        <div className="ml-auto flex shrink-0 items-center gap-2">
          {/* /events feed health */}
          <div
            className="hidden items-center gap-2 rounded-md border border-border bg-surface-panel px-2.5 py-1 shadow-control sm:flex"
            title={`Event feed: ${feed.label}`}
          >
            <StatusDot status={feed.dot} />
            <span className="text-xs font-medium text-muted-foreground">{feed.label}</span>
            <span className="font-mono text-[0.625rem] text-faint">/events</span>
            {eventsStatus !== "connected" && (
              <button
                type="button"
                onClick={onReconnect}
                aria-label="Reconnect event feed"
                title="Reconnect"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <RefreshCw className="size-3.5" />
              </button>
            )}
          </div>

          {/* Theme toggle (light default — commercial look) */}
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            aria-label={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
            title={`Switch to ${resolvedTheme === "dark" ? "light" : "dark"} theme`}
            className="text-muted-foreground"
          >
            {resolvedTheme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </Button>

          <Button
            variant="outline"
            size="sm"
            onClick={onOpenPalette}
            className="gap-2 text-muted-foreground"
            aria-label="Open command palette"
          >
            <Search className="size-3.5" />
            <span className="hidden text-[0.8125rem] md:inline">Search</span>
            <kbd className="rounded-sm border border-border bg-surface-tag px-1.5 py-0.5 font-sans text-[0.625rem] font-semibold text-muted-foreground">
              ⌘K
            </kbd>
          </Button>
        </div>
      </header>
    );
  },
);

TopBar.displayName = "TopBar";
