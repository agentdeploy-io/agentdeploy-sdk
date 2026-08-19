/**
 * useTheme Hook
 * ──────────────
 * Manages light/dark/system theme preference.
 * Persists choice to localStorage and applies data-theme attribute to <html>.
 *
 * Features:
 *   - Three modes: "light", "dark", "system"
 *   - Listens to prefers-color-scheme media query when in "system" mode
 *   - Applies data-theme attribute to document root for CSS variable overrides
 *   - Persists preference across sessions
 *
 * Usage:
 *   const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
 */

import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "edge-theme";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "system";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  return "system";
}

function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.setAttribute("data-theme", theme);
  root.style.colorScheme = theme;
}

export function useTheme(): {
  theme: ThemeMode;
  resolvedTheme: ResolvedTheme;
  setTheme: (mode: ThemeMode) => void;
  toggleTheme: () => void;
} {
  const [themeMode, setThemeMode] = useState<ThemeMode>(getStoredTheme);
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() =>
    themeMode === "system" ? getSystemTheme() : themeMode,
  );

  // Apply theme to document
  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // Resolve theme from mode
  useEffect(() => {
    if (themeMode === "system") {
      const resolve = () => setResolvedTheme(getSystemTheme());
      resolve(); // Initial resolve

      const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
      mediaQuery.addEventListener("change", resolve);
      return () => mediaQuery.removeEventListener("change", resolve);
    } else {
      setResolvedTheme(themeMode);
    }
  }, [themeMode]);

  const setTheme = useCallback((mode: ThemeMode) => {
    localStorage.setItem(STORAGE_KEY, mode);
    setThemeMode(mode);
  }, []);

  const toggleTheme = useCallback(() => {
    const next: ThemeMode = resolvedTheme === "dark" ? "light" : "dark";
    setTheme(next);
  }, [resolvedTheme, setTheme]);

  return {
    theme: themeMode,
    resolvedTheme,
    setTheme,
    toggleTheme,
  };
}
