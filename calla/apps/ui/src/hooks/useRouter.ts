/**
 * useRouter Hook
 * ───────────────
 * Lightweight client-side router using the History API.
 * No external dependencies. Supports:
 *   - Path-based routing (/, /inbox, /agents/supervisor/chat)
 *   - Browser back/forward
 *   - Programmatic navigation
 *   - Route params parsing
 *
 * Calla route grammar:
 *   "/"                        → fleet
 *   "/data"                    → data (leads table, bulk outreach approval)
 *   "/inbox"                   → inbox
 *   "/conversations"           → conversations (customer DM threads, takeover)
 *   "/reports"                 → reports (funnel, sources, flows, bookings)
 *   "/setup"                   → setup (implementation checklist)
 *   "/agents/:agentId/:tab?"   → agent-detail (tab defaults to "chat")
 *   anything else              → not-found
 *
 * This is intentionally simple — no query strings or nested routes.
 */

import { useState, useEffect, useCallback } from "react";
import type { Route, ViewId } from "@/types/ui";

// ─── Route Parsing ───────────────────────────────────────────────

/**
 * Views addressable by a single path segment. Every entry is a valid
 * ViewId (the playground had a VALID_VIEWS/ViewId mismatch — fixed here).
 */
export const VALID_VIEWS: ViewId[] = [
  "fleet",
  "data",
  "inbox",
  "conversations",
  "reports",
  "calls",
  "setup",
  "agent-detail",
];

export const DEFAULT_AGENT_TAB = "chat";

function parsePath(pathname: string): Route {
  const segments = pathname.split("/").filter(Boolean);

  // "/" → fleet dashboard
  if (segments.length === 0) {
    return { view: "fleet" };
  }

  const firstSegment = segments[0];

  // /agents/:agentId/:tab → agent detail
  if (firstSegment === "agents" && segments.length >= 2) {
    return {
      view: "agent-detail",
      agentId: segments[1],
      tab: segments[2] ?? DEFAULT_AGENT_TAB,
    };
  }

  // Map known single-segment routes ("fleet", "inbox")
  if (VALID_VIEWS.includes(firstSegment as ViewId)) {
    return { view: firstSegment as ViewId };
  }

  // Unknown route — show 404
  return { view: "not-found" };
}

// ─── Hook ────────────────────────────────────────────────────────

export interface UseRouterResult {
  route: Route;
  navigate: (path: string) => void;
  goBack: () => void;
}

export function useRouter(): UseRouterResult {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    const handlePopState = () => {
      setRoute(parsePath(window.location.pathname));
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigate = useCallback((path: string) => {
    // Normalize: ensure leading slash, no trailing slash (except root)
    let normalized = path.startsWith("/") ? path : `/${path}`;
    if (normalized.length > 1 && normalized.endsWith("/")) {
      normalized = normalized.slice(0, -1);
    }

    window.history.pushState({}, "", normalized);
    // Notify every useRouter instance (App shell, pages) — pushState alone
    // does not fire popstate, so dispatch it synthetically.
    window.dispatchEvent(new PopStateEvent("popstate", { state: {} }));
  }, []);

  const goBack = useCallback(() => {
    window.history.back();
  }, []);

  return { route, navigate, goBack };
}

// ─── Helper: Build routes ────────────────────────────────────────

/** Build an agent detail route: /agents/:agentId[/:tab] */
export function buildAgentRoute(agentId: string, tab?: string): string {
  const base = `/agents/${agentId}`;
  return tab ? `${base}/${tab}` : base;
}

/** Build the inbox route. */
export function buildInboxRoute(): string {
  return "/inbox";
}

/** Build the fleet (home) route. */
export function buildFleetRoute(): string {
  return "/";
}
