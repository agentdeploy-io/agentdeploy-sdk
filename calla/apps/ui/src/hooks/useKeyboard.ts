/**
 * useKeyboardShortcuts Hook
 * ──────────────────────────
 * Registers global keyboard shortcuts for the Calla UI.
 *
 * Shortcuts (Calla route grammar):
 *   Cmd+K / Ctrl+K  — Open command palette
 *   G then O        — Go to Fleet (/)
 *   G then D        — Go to Data (/data)
 *   G then I        — Go to Inbox (/inbox)
 *   G then C        — Go to Conversations (/conversations)
 *   G then R        — Go to Reports (/reports)
 *   G then V        — Go to Calls (/calls, voice module)
 *   T               — Toggle theme
 *   Escape          — Close overlays (handled by components)
 *
 * Usage:
 *   useKeyboardShortcuts({ onOpenPalette: () => ..., onNavigate: (path) => ... })
 */

import { useEffect, useCallback, useRef } from "react";

export interface KeyboardShortcutHandlers {
  onOpenPalette?: () => void;
  onNavigate?: (path: string) => void;
  onToggleTheme?: () => void;
  /**
   * Paths whose module is disabled for this deployment — the matching
   * g> shortcuts become no-ops (the nav gate would 404 them anyway).
   */
  disabledPaths?: ReadonlySet<string>;
}

type ComboAction = "onNavigate" | "onToggleTheme" | "onOpenPalette";

const KEY_COMBOS: Record<string, { path?: string; action?: ComboAction }> = {
  // G-prefixed shortcuts (Vim-style navigation)
  "g>o": { path: "/", action: "onNavigate" },
  "g>d": { path: "/data", action: "onNavigate" },
  "g>i": { path: "/inbox", action: "onNavigate" },
  "g>c": { path: "/conversations", action: "onNavigate" },
  "g>r": { path: "/reports", action: "onNavigate" },
  "g>v": { path: "/calls", action: "onNavigate" },
  // Single-key shortcuts
  t: { action: "onToggleTheme" },
};

export function useKeyboardShortcuts(handlers: KeyboardShortcutHandlers): void {
  const gPressedRef = useRef(false);
  const gTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    // Don't intercept if user is typing in an input/textarea
    const target = e.target as HTMLElement;
    const isTyping =
      target.tagName === "INPUT" ||
      target.tagName === "TEXTAREA" ||
      target.tagName === "SELECT" ||
      target.isContentEditable;

    // ─── Cmd+K / Ctrl+K (works even in inputs) ─────────────────
    if ((e.metaKey || e.ctrlKey) && e.key === "k") {
      e.preventDefault();
      handlersRef.current.onOpenPalette?.();
      return;
    }

    if (isTyping) return;

    // ─── G-prefixed shortcuts ──────────────────────────────────
    if (e.key === "g" && !e.metaKey && !e.ctrlKey && !e.altKey) {
      gPressedRef.current = true;
      // Reset G state after 800ms if no second key
      if (gTimerRef.current) clearTimeout(gTimerRef.current);
      gTimerRef.current = setTimeout(() => {
        gPressedRef.current = false;
      }, 800);
      return;
    }

    if (gPressedRef.current) {
      const combo = `g>${e.key.toLowerCase()}`;
      const mapping = KEY_COMBOS[combo];
      if (mapping) {
        e.preventDefault();
        gPressedRef.current = false;
        if (gTimerRef.current) {
          clearTimeout(gTimerRef.current);
          gTimerRef.current = null;
        }
        if (mapping.path && handlersRef.current.onNavigate) {
          if (!handlersRef.current.disabledPaths?.has(mapping.path)) {
            handlersRef.current.onNavigate(mapping.path);
          }
        }
        if (mapping.action && mapping.action !== "onNavigate") {
          handlersRef.current[mapping.action]?.();
        }
      }
      gPressedRef.current = false;
      return;
    }

    // ─── Single-key shortcuts ──────────────────────────────────
    const singleMapping = KEY_COMBOS[e.key.toLowerCase()];
    if (singleMapping && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      // Only call actions that don't need arguments (skip onNavigate which needs a path)
      if (singleMapping.action && singleMapping.action !== "onNavigate") {
        const handler = handlersRef.current[singleMapping.action];
        if (handler) (handler as () => void)();
      }
    }
  }, []);

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
