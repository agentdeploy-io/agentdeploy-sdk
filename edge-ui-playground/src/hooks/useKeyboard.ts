/**
 * useKeyboardShortcuts Hook
 * ──────────────────────────
 * Registers global keyboard shortcuts for the console.
 *
 * Shortcuts:
 *   Cmd+K / Ctrl+K  — Open command palette
 *   G then O        — Go to Overview
 *   G then A        — Go to Agents
 *   G then C        — Go to Conversations
 *   G then W        — Go to Workers
 *   G then S        — Go to Settings
 *   T               — Toggle theme
 *   ?               — Show shortcuts help (future)
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
}

const KEY_COMBOS: Record<string, { path?: string; action?: keyof KeyboardShortcutHandlers }> = {
  // G-prefixed shortcuts (Vim-style navigation)
  "g>o": { path: "/", action: "onNavigate" },
  "g>a": { path: "/agents", action: "onNavigate" },
  "g>c": { path: "/conversations", action: "onNavigate" },
  "g>w": { path: "/workers", action: "onNavigate" },
  "g>s": { path: "/settings", action: "onNavigate" },
  "g>f": { path: "/config", action: "onNavigate" },
  "g>b": { path: "/observability", action: "onNavigate" },
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
          handlersRef.current.onNavigate(mapping.path);
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
