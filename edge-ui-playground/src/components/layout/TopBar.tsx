/**
 * TopBar Component
 * ─────────────────
 * Top header bar with page title, breadcrumbs, and actions.
 *
 * Design spec: height:64, borderBottom:1px solid border color
 *
 * Features:
 *   - Dynamic title based on current route
 *   - Breadcrumb trail (for nested views)
 *   - Action buttons slot (search button is in ConsoleLayout via ⌘K)
 *   - Responsive
 *
 * Note: The global search is handled by the CommandPalette (⌘K), not
 * an inline search input. This matches the UX pattern used by Linear,
 * Vercel, and Raycast — a dedicated search button + palette overlay.
 */

import React from "react";
import { COLORS, LAYOUT, RADIUS } from "../../constants/theme";
import { getNavItem, AGENT_TABS } from "../../constants/navigation";
import { getAgentById } from "../../constants/agents";
import { useAuth } from "../../hooks/useAuth";
import type { RouteParams } from "../../types/ui";

// ─── Props ───────────────────────────────────────────────────────

export interface TopBarProps {
  route: RouteParams;
  /** Slot for action buttons on the right */
  actions?: React.ReactNode;
}

// ─── Breadcrumb Builder ──────────────────────────────────────────

interface BreadcrumbItem {
  label: string;
}

function buildBreadcrumbs(route: RouteParams): BreadcrumbItem[] {
  switch (route.view) {
    case "overview":
      return [{ label: "Overview" }];
    case "agents":
      return [{ label: "Agents" }];
    case "agent-detail": {
      const agent = route.agentId ? getAgentById(route.agentId) : null;
      const tab = route.tab ? AGENT_TABS.find((t) => t.id === route.tab) : null;
      const crumbs: BreadcrumbItem[] = [{ label: "Agents" }];
      if (agent) {
        crumbs.push({ label: agent.name });
      }
      if (tab) {
        crumbs.push({ label: tab.label });
      }
      return crumbs;
    }
    case "conversations":
      return [{ label: "Conversations" }];
    case "workers":
      return [{ label: "Workers & Deployments" }];
    case "config":
      return [{ label: "Configuration" }];
    case "observability":
      return [{ label: "Observability" }];
    case "settings":
      return [{ label: "Settings" }];
    case "not-found":
      return [{ label: "Not Found" }];
    default:
      return [{ label: "Edge Console" }];
  }
}

// ─── Component ───────────────────────────────────────────────────

export const TopBar: React.FC<TopBarProps> = React.memo(({ route, actions }) => {
  const breadcrumbs = buildBreadcrumbs(route);

  return (
    <header
      style={{
        height: LAYOUT.topbarHeight,
        backgroundColor: COLORS.card,
        borderBottom: `1px solid ${COLORS.border}`,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "0 24px",
        gap: "16px",
        position: "sticky",
        top: 0,
        zIndex: 50,
      }}
    >
      {/* ─── Breadcrumbs ───────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "8px", minWidth: 0 }}>
        {breadcrumbs.map((crumb, i) => {
          const isLast = i === breadcrumbs.length - 1;
          return (
            <React.Fragment key={i}>
              {i > 0 && (
                <span style={{ color: COLORS.border, fontSize: "0.875rem" }}>/</span>
              )}
              <span
                style={{
                  fontSize: "0.9375rem",
                  fontWeight: isLast ? 600 : 400,
                  color: isLast ? COLORS.foreground : COLORS.mutedForeground,
                  whiteSpace: "nowrap",
                }}
              >
                {crumb.label}
              </span>
            </React.Fragment>
          );
        })}
      </div>

      {/* ─── Right Section ─────────────────────────────────── */}
      <div style={{ display: "flex", alignItems: "center", gap: "12px", flexShrink: 0 }}>
        {/* Actions */}
        {actions}
        {/* User menu */}
        <UserMenu />
      </div>
    </header>
  );
});

TopBar.displayName = "TopBar";

// ─── User Menu (shows authenticated user + logout) ───────────────

const UserMenu: React.FC = () => {
  const { user, authDisabled, logout } = useAuth();
  const [open, setOpen] = React.useState(false);
  const menuRef = React.useRef<HTMLDivElement>(null);

  // Close on outside click
  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [open]);

  // Don't render in local dev mode (auth disabled)
  if (authDisabled || !user) return null;

  const initials = user.name
    .split(" ")
    .map((w) => w[0])
    .slice(0, 2)
    .join("")
    .toUpperCase();

  return (
    <div ref={menuRef} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        aria-label="User menu"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          padding: "4px 8px 4px 4px",
          background: "none",
          border: "none",
          cursor: "pointer",
          borderRadius: RADIUS.md,
          transition: "background-color 100ms ease",
        }}
        onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.secondary)}
        onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
      >
        {/* Avatar */}
        <div
          style={{
            width: "28px",
            height: "28px",
            borderRadius: "50%",
            backgroundColor: COLORS.primary,
            color: COLORS.primaryForeground,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "0.6875rem",
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          {initials}
        </div>
        <span
          style={{
            fontSize: "0.8125rem",
            fontWeight: 500,
            color: COLORS.foreground,
            maxWidth: "120px",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {user.name}
        </span>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          style={{
            position: "absolute",
            top: "100%",
            right: 0,
            marginTop: "4px",
            minWidth: "220px",
            backgroundColor: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            boxShadow: "0 4px 16px rgba(0,0,0,0.12)",
            zIndex: 100,
            overflow: "hidden",
          }}
        >
          {/* User info */}
          <div style={{ padding: "12px 14px", borderBottom: `1px solid ${COLORS.border}` }}>
            <div
              style={{
                fontSize: "0.8125rem",
                fontWeight: 600,
                color: COLORS.foreground,
                marginBottom: "2px",
              }}
            >
              {user.name}
            </div>
            <div
              style={{
                fontSize: "0.75rem",
                color: COLORS.mutedForeground,
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {user.email}
            </div>
          </div>

          {/* Logout */}
          <button
            onClick={() => {
              setOpen(false);
              logout();
            }}
            style={{
              display: "block",
              width: "100%",
              padding: "10px 14px",
              fontSize: "0.8125rem",
              fontWeight: 500,
              color: COLORS.foreground,
              textAlign: "left",
              background: "none",
              border: "none",
              cursor: "pointer",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.secondary)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
};
