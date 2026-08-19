/**
 * useRouter Hook
 * ───────────────
 * Lightweight client-side router using the History API.
 * No external dependencies. Supports:
 *   - Path-based routing (/agents, /agents/support-agent/chat)
 *   - Browser back/forward
 *   - Programmatic navigation
 *   - Route params parsing
 *
 * This is intentionally simple — no query strings or nested routes.
 * The app has a flat structure: /<view>/<optional-id>/<optional-tab>
 */

import { useState, useEffect, useCallback } from "react";
import type { RouteParams, ViewId } from "../types/ui";
import { AppErrors } from "../errors/AppError";

// ─── Route Parsing ───────────────────────────────────────────────

const VALID_VIEWS: ViewId[] = [
  "overview",
  "agents",
  "agent-detail",
  "conversations",
  "workers",
  "config",
  "observability",
  "settings",
];

function parsePath(pathname: string): RouteParams {
  const segments = pathname.split("/").filter(Boolean);

  // Default to overview
  if (segments.length === 0) {
    return { view: "overview" };
  }

  const firstSegment = segments[0];

  // /agents/:agentId/:tab
  if (firstSegment === "agents" && segments.length >= 2) {
    return {
      view: "agent-detail",
      agentId: segments[1],
      tab: segments[2] ?? "chat",
    };
  }

  // /agents → agents list
  if (firstSegment === "agents") {
    return { view: "agents" };
  }

  // /conversations/:conversationId
  if (firstSegment === "conversations" && segments.length >= 2) {
    return {
      view: "conversations",
      subId: segments[1],
    };
  }

  // Map known single-segment routes
  if (VALID_VIEWS.includes(firstSegment as ViewId)) {
    return { view: firstSegment as ViewId };
  }

  // Unknown route — show 404
  return { view: "not-found" };
}

// ─── Hook ────────────────────────────────────────────────────────

export interface UseRouterResult {
  route: RouteParams;
  navigate: (path: string) => void;
  goBack: () => void;
}

export function useRouter(): UseRouterResult {
  const [route, setRoute] = useState<RouteParams>(() => parsePath(window.location.pathname));

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
    setRoute(parsePath(normalized));
  }, []);

  const goBack = useCallback(() => {
    window.history.back();
  }, []);

  return { route, navigate, goBack };
}

// ─── Helper: Build agent detail route ────────────────────────────

export function buildAgentRoute(agentId: string, tab?: string): string {
  const base = `/agents/${agentId}`;
  return tab ? `${base}/${tab}` : base;
}
