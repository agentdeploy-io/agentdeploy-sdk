/**
 * ConsoleLayout — Calla application shell
 * ───────────────────────────────────────
 * Sidebar + TopBar + routed content, plus the single-instance /events socket
 * and approval aggregator every screen reads from (see console-context.tsx).
 *
 *   ┌──────────┬──────────────────────────────┐
 *   │ Sidebar  │ TopBar (breadcrumbs, feed)   │
 *   │ w-64     ├──────────────────────────────┤
 *   │          │ main (screen)                │
 *   └──────────┴──────────────────────────────┘
 *
 * Mobile (<769px): the sidebar collapses into a drawer opened from the TopBar.
 * Global shortcuts: ⌘K palette, G then O → Fleet, G then I → Approvals,
 * T → toggle theme (registered via useKeyboardShortcuts).
 */

import * as React from "react";
import { X } from "lucide-react";
import { CALLA_MODULES, isModuleEnabled } from "@calla/shared";
import { CommandPalette } from "@/components/layout/CommandPalette";
import { Sidebar } from "@/components/layout/Sidebar";
import { TopBar } from "@/components/layout/TopBar";
import {
  ConsoleApprovalsProvider,
  ConsoleEventsProvider,
  useConsoleEvents,
} from "@/components/layout/console-context";
import { ErrorBoundary } from "@/components/shared";
import { useIsMobile, useKeyboardShortcuts, useTheme } from "@/hooks";
import { useModuleConfig } from "@/lib/modules";
import { cn } from "@/lib/utils";
import type { Route } from "@/types/ui";

export interface ConsoleLayoutProps {
  route: Route;
  onNavigate: (path: string) => void;
  children: React.ReactNode;
}

export function ConsoleLayout({ route, onNavigate, children }: ConsoleLayoutProps) {
  return (
    <ConsoleEventsProvider>
      <ConsoleApprovalsProvider>
        <ConsoleShell route={route} onNavigate={onNavigate}>
          {children}
        </ConsoleShell>
      </ConsoleApprovalsProvider>
    </ConsoleEventsProvider>
  );
}

// ─── Shell (inside the data providers) ───────────────────────────

const ConsoleShell: React.FC<ConsoleLayoutProps> = ({ route, onNavigate, children }) => {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [drawerOpen, setDrawerOpen] = React.useState(false);
  const isMobile = useIsMobile();
  const { toggleTheme } = useTheme();
  const { status: eventsStatus, reconnect } = useConsoleEvents();
  const { modules } = useModuleConfig();

  // Routes owned by modules disabled for this deployment — their g>
  // shortcuts become no-ops instead of navigating into a 404 gate.
  const disabledPaths = React.useMemo(() => {
    const set = new Set<string>();
    for (const m of CALLA_MODULES) {
      if (m.path !== null && !m.always && !isModuleEnabled(m.id, modules)) {
        set.add(m.path === "/" ? "/" : `/${m.path}`);
      }
    }
    return set;
  }, [modules]);

  const navigate = React.useCallback(
    (path: string) => {
      onNavigate(path);
      setDrawerOpen(false);
      setPaletteOpen(false);
    },
    [onNavigate],
  );

  useKeyboardShortcuts({
    onOpenPalette: () => setPaletteOpen(true),
    onNavigate: navigate,
    onToggleTheme: toggleTheme,
    disabledPaths,
  });

  // useKeyboardShortcuts binds G→O (fleet) and G→I (inbox). The Calla spec
  // also documents G→F for the fleet — mirrored here without disturbing the
  // hook's own G-sequence handling.
  React.useEffect(() => {
    let armed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable);
      if (isTyping) return;

      const key = e.key.toLowerCase();
      if (key === "g") {
        armed = true;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          armed = false;
        }, 800);
        return;
      }
      if (armed && key === "f") {
        e.preventDefault();
        armed = false;
        navigate("/");
      }
    };

    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (timer) clearTimeout(timer);
    };
  }, [navigate]);

  // Route changes dismiss the mobile drawer.
  React.useEffect(() => {
    setDrawerOpen(false);
  }, [route.view, route.agentId, route.tab]);

  // Escape closes the drawer (the palette handles its own Escape).
  React.useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  // Full-height, edge-to-edge surfaces: the agent console and the
  // two-pane Conversations inbox both manage their own internal scrolling.
  const isDetail = route.view === "agent-detail" || route.view === "conversations";

  return (
    <div className="flex min-h-screen bg-background">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[60] focus:rounded-md focus:bg-primary focus:px-3 focus:py-2 focus:text-sm focus:text-primary-foreground"
      >
        Skip to content
      </a>

      {/* Desktop sidebar */}
      {!isMobile && <Sidebar route={route} onNavigate={navigate} className="sticky top-0 h-screen" />}

      {/* Mobile drawer */}
      {isMobile && drawerOpen && (
        <div className="fixed inset-0 z-40">
          <div
            className="absolute inset-0 animate-fade-in bg-black/50 backdrop-blur-[2px]"
            onClick={() => setDrawerOpen(false)}
          />
          <div className="absolute inset-y-0 left-0 z-50 flex w-64 max-w-[85vw] animate-fade-in shadow-float">
            <Sidebar route={route} onNavigate={navigate} className="h-full" />
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close menu"
              className="absolute right-2 top-3 flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-surface-hover hover:text-foreground"
            >
              <X className="size-4" />
            </button>
          </div>
        </div>
      )}

      {/* Content column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          route={route}
          onOpenPalette={() => setPaletteOpen(true)}
          eventsStatus={eventsStatus}
          onReconnect={reconnect}
          {...(isMobile ? { onOpenMenu: () => setDrawerOpen(true) } : {})}
        />

        <main
          id="main-content"
          tabIndex={-1}
          className={cn(
            "min-w-0 flex-1 outline-none",
            isDetail
              ? "flex h-[calc(100vh-3.5rem)] min-h-0 flex-col overflow-hidden"
              : "px-4 py-6 sm:px-6 lg:px-8",
          )}
        >
          <ErrorBoundary resetKeys={[route.view, route.agentId, route.tab]}>
            {children}
          </ErrorBoundary>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={navigate}
        onToggleTheme={toggleTheme}
        onReconnect={reconnect}
      />
    </div>
  );
};

ConsoleShell.displayName = "ConsoleShell";
