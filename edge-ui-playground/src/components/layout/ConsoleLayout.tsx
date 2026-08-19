/**
 * ConsoleLayout Component
 * ───────────────────────
 * Main application shell: Sidebar + TopBar + Content area + ToastContainer.
 *
 * Layout:
 *   ┌──────────────────────────────────────────┐
 *   │ Sidebar │ TopBar                          │
 *   │         ├─────────────────────────────────┤
 *   │         │                                 │
 *   │         │ Content (scrollable)            │
 *   │         │                                 │
 *   │         ├─────────────────────────────────┤
 *   │         │ (Footer - future)               │
 *   └─────────┴─────────────────────────────────┘
 *
 * Features:
 *   - ErrorBoundary wraps the entire content area
 *   - ToastContainer rendered at root
 *   - Route-based navigation via useRouter
 *   - View switching via render prop
 */

import React from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { ToastContainer } from "./ToastContainer";
import { CommandPalette } from "./CommandPalette";
import { ErrorBoundary } from "../shared/ErrorBoundary";
import { Button } from "../ui/Button";
import { COLORS, RADIUS } from "../../constants/theme";
import { useTheme, useKeyboardShortcuts, useIsMobile } from "../../hooks";
import type { RouteParams } from "../../types/ui";

// ─── Props ───────────────────────────────────────────────────────

export interface ConsoleLayoutProps {
  route: RouteParams;
  onNavigate: (path: string) => void;
  /** Render the current view content */
  children: React.ReactNode;
  /** Optional actions for the top bar */
  topBarActions?: React.ReactNode;
  /** Badge counts for sidebar */
  sidebarBadges?: Record<string, number>;
}

// ─── Component ───────────────────────────────────────────────────

export const ConsoleLayout: React.FC<ConsoleLayoutProps> = ({
  route,
  onNavigate,
  children,
  topBarActions,
  sidebarBadges,
}) => {
  const [paletteOpen, setPaletteOpen] = React.useState(false);
  const [sidebarOpen, setSidebarOpen] = React.useState(false);
  const { toggleTheme } = useTheme();
  const isMobile = useIsMobile();

  // Register keyboard shortcuts
  useKeyboardShortcuts({
    onOpenPalette: () => setPaletteOpen(true),
    onNavigate: (path) => {
      onNavigate(path);
      setSidebarOpen(false); // Close mobile sidebar on navigate
    },
    onToggleTheme: toggleTheme,
  });

  // Top bar actions: palette button + any custom actions
  const topBarActionsCombined = (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setPaletteOpen(true)}
        leftIcon={
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
        }
        style={{ gap: "8px" }}
      >
        <span style={{ fontSize: "0.8125rem" }}>Search</span>
        <kbd
          style={{
            fontSize: "0.6875rem",
            padding: "1px 5px",
            borderRadius: "3px",
            backgroundColor: COLORS.secondary,
            color: COLORS.mutedForeground,
            border: `1px solid ${COLORS.border}`,
            fontFamily: "inherit",
          }}
        >
          ⌘K
        </kbd>
      </Button>
      {topBarActions}
    </>
  );

  return (
    <div style={{ display: "flex", minHeight: "100vh", backgroundColor: COLORS.background }}>
      {/* ─── Skip to Content Link (a11y) ─────────────────────── */}
      <a
        href="#main-content"
        style={{
          position: "absolute",
          left: "-9999px",
          top: "8px",
          zIndex: 9999,
          padding: "8px 16px",
          backgroundColor: COLORS.primary,
          color: COLORS.primaryForeground,
          borderRadius: RADIUS.md,
          fontSize: "0.875rem",
          fontWeight: 500,
          textDecoration: "none",
          transition: "left 150ms ease",
        }}
        onFocus={(e) => {
          e.currentTarget.style.left = "8px";
        }}
        onBlur={(e) => {
          e.currentTarget.style.left = "-9999px";
        }}
      >
        Skip to content
      </a>

      {/* ─── Desktop Sidebar ─────────────────────────────────── */}
      {!isMobile && (
        <Sidebar
          activeView={route.view}
          activeAgentId={route.agentId}
          onNavigate={onNavigate}
          badges={sidebarBadges}
        />
      )}

      {/* ─── Mobile Sidebar Overlay ───────────────────────────── */}
      {isMobile && sidebarOpen && (
        <>
          <div
            onClick={() => setSidebarOpen(false)}
            style={{
              position: "fixed",
              inset: 0,
              backgroundColor: "rgba(0, 0, 0, 0.4)",
              zIndex: 200,
              animation: "fadeIn 150ms ease-out",
            }}
          />
          <div
            style={{
              position: "fixed",
              left: 0,
              top: 0,
              bottom: 0,
              zIndex: 201,
              animation: "slideIn 200ms ease-out",
            }}
          >
            <Sidebar
              activeView={route.view}
              activeAgentId={route.agentId}
              onNavigate={(path) => {
                onNavigate(path);
                setSidebarOpen(false);
              }}
              badges={sidebarBadges}
            />
          </div>
        </>
      )}

      {/* Main Content Area */}
      <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
        <TopBar
          route={route}
          actions={
            <>
              {/* Mobile hamburger */}
              {isMobile && (
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setSidebarOpen(true)}
                  aria-label="Open menu"
                >
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="3" y1="6" x2="21" y2="6" />
                    <line x1="3" y1="12" x2="21" y2="12" />
                    <line x1="3" y1="18" x2="21" y2="18" />
                  </svg>
                </Button>
              )}
              {topBarActionsCombined}
            </>
          }
        />

        <main
          id="main-content"
          tabIndex={-1}
          style={{
            flex: 1,
            padding: isMobile ? "16px" : "32px",
            maxWidth: "1440px",
            width: "100%",
            overflowX: "hidden",
            outline: "none",
          }}
        >
          <ErrorBoundary>{children}</ErrorBoundary>
        </main>
      </div>

      {/* Command Palette */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={onNavigate}
        onToggleTheme={toggleTheme}
      />

      {/* Toast Notifications */}
      <ToastContainer />
    </div>
  );
};
