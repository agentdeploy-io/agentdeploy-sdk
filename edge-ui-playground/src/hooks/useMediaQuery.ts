/**
 * useMediaQuery Hook
 * ───────────────────
 * Reactive media query hook for responsive design.
 *
 * Usage:
 *   const isMobile = useMediaQuery("(max-width: 768px)")
 *   const isTablet = useMediaQuery("(min-width: 769px) and (max-width: 1024px)")
 */

import { useState, useEffect } from "react";

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    const mediaQuery = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    // Initial sync
    setMatches(mediaQuery.matches);

    // Modern API
    mediaQuery.addEventListener("change", handler);
    return () => mediaQuery.removeEventListener("change", handler);
  }, [query]);

  return matches;
}

// ─── Convenience Breakpoints ─────────────────────────────────────

export const useIsMobile = () => useMediaQuery("(max-width: 768px)");
export const useIsTablet = () => useMediaQuery("(min-width: 769px) and (max-width: 1024px)");
export const useIsDesktop = () => useMediaQuery("(min-width: 1025px)");
