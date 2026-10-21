/**
 * useTheme Hook
 * ──────────────
 * Manages light/dark/system theme preference.
 * Persists choice to localStorage and toggles the "dark" class on
 * document.documentElement (Tailwind darkMode: ["class"] convention).
 *
 * Features:
 *   - Three modes: "light", "dark", "system"
 *   - Listens to prefers-color-scheme media query when in "system" mode
 *   - Applies/removes the `dark` class on <html> for Tailwind
 *   - Persists preference across sessions under "calla-theme"
 *
 * Usage:
 *   const { theme, resolvedTheme, setTheme, toggleTheme } = useTheme();
 */

import { useState, useEffect, useCallback } from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const STORAGE_KEY = "calla-theme";

function getSystemTheme(): ResolvedTheme {
  if (typeof window === "undefined") return "light";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function getStoredTheme(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "light" || stored === "dark" || stored === "system") {
    return stored;
  }
  // Light is Calla's default — the commercial look. Dark/system opt-in via toggle.
  return "light";
}

/** Tailwind convention: dark mode = `.dark` class on <html>. */
function applyTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
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
    try {
      localStorage.setItem(STORAGE_KEY, mode);
    } catch {
      // storage blocked — theme still applies for this session
    }
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
