/**
 * Sidebar Component
 * ─────────────────
 * Left navigation panel with logo, grouped nav items, and
 * environment switcher at the bottom.
 *
 * Design spec:
 *   width:280, fill:$--card, borderRight:1px solid $--border
 *   Nav items: height:40, gap:12, padding:[0,12]
 *   Active item: fill:$--secondary
 *
 * Features:
 *   - Grouped navigation sections (Monitor / Manage / System)
 *   - Active route highlighting
 *   - Badge counts (for unread conversations, etc.)
 *   - Environment switcher at bottom
 *   - Collapsible (future enhancement)
 *   - Keyboard accessible
 */

import React from "react";
import { NAV_GROUPS, type NavItemConfig } from "../../constants/navigation";
import { COLORS, LAYOUT, RADIUS, COMPONENT_SPEC, TRANSITIONS } from "../../constants/theme";
import type { ViewId } from "../../types/ui";
import { EnvironmentSwitcher } from "../ui/EnvironmentSwitcher";
import { ThemeToggle } from "../ui/ThemeToggle";

// ─── Props ───────────────────────────────────────────────────────

export interface SidebarProps {
  activeView: ViewId;
  activeAgentId?: string;
  onNavigate: (path: string) => void;
  /** Badge counts by key (e.g., { conversations: 3 }) */
  badges?: Record<string, number>;
}

// ─── Component ───────────────────────────────────────────────────

export const Sidebar: React.FC<SidebarProps> = React.memo(
  ({ activeView, activeAgentId, onNavigate, badges }) => {
    const isActive = React.useCallback(
      (item: NavItemConfig): boolean => {
        if (item.id === "agent-detail") return false; // Handled via agents
        if (item.id === activeView) return true;
        // When viewing agent detail, highlight "Agents"
        if (activeView === "agent-detail" && item.id === "agents") return true;
        return false;
      },
      [activeView],
    );

    return (
      <aside
        style={{
          width: LAYOUT.sidebarWidth,
          height: "100vh",
          backgroundColor: COLORS.card,
          borderRight: `1px solid ${COLORS.border}`,
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          position: "sticky",
          top: 0,
        }}
      >
        {/* ─── Logo / Brand ──────────────────────────────────── */}
        <div
          style={{
            height: LAYOUT.topbarHeight,
            padding: "0 24px",
            display: "flex",
            alignItems: "center",
            gap: "10px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div
            style={{
              width: "32px",
              height: "32px",
              borderRadius: RADIUS.md,
              backgroundColor: COLORS.primary,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: COLORS.primaryForeground,
              fontSize: "1rem",
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            E
          </div>
          <div>
            <div style={{ fontSize: "0.9375rem", fontWeight: 700, color: COLORS.foreground, lineHeight: 1.2 }}>
              Edge Console
            </div>
            <div style={{ fontSize: "0.6875rem", color: COLORS.mutedForeground, lineHeight: 1 }}>
              AgentDeploy
            </div>
          </div>
        </div>

        {/* ─── Navigation ────────────────────────────────────── */}
        <nav
          style={{
            flex: 1,
            overflowY: "auto",
            padding: "16px 12px",
            display: "flex",
            flexDirection: "column",
            gap: "24px",
          }}
        >
          {NAV_GROUPS.map((group) => (
            <div key={group.id}>
              {/* Group Label */}
              <div
                style={{
                  fontSize: "0.6875rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.06em",
                  color: COLORS.mutedForeground,
                  padding: "0 12px",
                  marginBottom: "4px",
                }}
              >
                {group.label}
              </div>

              {/* Nav Items */}
              <div style={{ display: "flex", flexDirection: "column", gap: "2px" }}>
                {group.items.map((item) => {
                  if (!item.visible) return null;
                  const active = isActive(item);
                  const badgeCount = item.badgeKey ? badges?.[item.badgeKey] : undefined;

                  return (
                    <button
                      key={item.id}
                      onClick={() => onNavigate(item.path)}
                      title={item.label}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: COMPONENT_SPEC.navItem.gap,
                        height: COMPONENT_SPEC.navItem.height,
                        padding: `0 ${COMPONENT_SPEC.navItem.paddingX}`,
                        borderRadius: COMPONENT_SPEC.navItem.borderRadius,
                        fontSize: "0.875rem",
                        fontWeight: active ? 600 : 500,
                        color: active ? COLORS.foreground : COLORS.mutedForeground,
                        backgroundColor: active ? COLORS.secondary : "transparent",
                        border: "none",
                        cursor: "pointer",
                        transition: `background-color ${TRANSITIONS.fast}, color ${TRANSITIONS.fast}`,
                        textAlign: "left",
                        position: "relative",
                      }}
                      onMouseEnter={(e) => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = COLORS.cardHover;
                          e.currentTarget.style.color = COLORS.foreground;
                        }
                      }}
                      onMouseLeave={(e) => {
                        if (!active) {
                          e.currentTarget.style.backgroundColor = "transparent";
                          e.currentTarget.style.color = COLORS.mutedForeground;
                        }
                      }}
                    >
                      {/* Icon placeholder (lucide icon name available in item.icon) */}
                      <NavIcon name={item.icon} active={active} />
                      <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {item.label}
                      </span>

                      {/* Badge */}
                      {badgeCount !== undefined && badgeCount > 0 && (
                        <span
                          style={{
                            fontSize: "0.6875rem",
                            fontWeight: 600,
                            padding: "1px 6px",
                            borderRadius: "10px",
                            backgroundColor: COLORS.primary,
                            color: COLORS.primaryForeground,
                            minWidth: "18px",
                            textAlign: "center",
                          }}
                        >
                          {badgeCount > 99 ? "99+" : badgeCount}
                        </span>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* ─── Footer: Environment Switcher + Theme Toggle ─────── */}
        <div
          style={{
            padding: "12px 16px",
            borderTop: `1px solid ${COLORS.border}`,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: "8px",
          }}
        >
          <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, flexShrink: 0 }}>
            Environment
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: "4px" }}>
            <ThemeToggle />
            <EnvironmentSwitcher />
          </div>
        </div>
      </aside>
    );
  },
);

Sidebar.displayName = "Sidebar";

// ─── NavIcon (simple SVG-based icon renderer) ────────────────────

const NavIcon: React.FC<{ name: string; active: boolean }> = ({ name, active }) => {
  const color = active ? COLORS.primary : "currentColor";
  const size = 18;

  // Map icon names to SVG paths (subset of Lucide icons)
  const iconPaths: Record<string, React.ReactNode> = {
    "layout-dashboard": (
      <>
        <rect x="3" y="3" width="7" height="9" rx="1" />
        <rect x="14" y="3" width="7" height="5" rx="1" />
        <rect x="14" y="12" width="7" height="9" rx="1" />
        <rect x="3" y="16" width="7" height="5" rx="1" />
      </>
    ),
    bot: (
      <>
        <rect x="4" y="8" width="16" height="12" rx="2" />
        <path d="M12 2v6" />
        <circle cx="9" cy="14" r="1" fill={color} stroke="none" />
        <circle cx="15" cy="14" r="1" fill={color} stroke="none" />
        <path d="M2 14v2 M22 14v2" />
      </>
    ),
    "messages-square": (
      <>
        <path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2z" />
        <path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1" />
      </>
    ),
    cloud: (
      <path d="M17.5 19a4.5 4.5 0 1 0-1.5-8.75A6 6 0 0 0 4 12.5 4.5 4.5 0 0 0 5.5 21h12z" />
    ),
    "settings-2": (
      <>
        <path d="M20 7h-9" />
        <path d="M14 17H5" />
        <circle cx="17" cy="17" r="3" />
        <circle cx="7" cy="7" r="3" />
      </>
    ),
    activity: <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />,
    gear: (
      <>
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </>
    ),
  };

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{ flexShrink: 0 }}
    >
      {iconPaths[name] ?? <circle cx="12" cy="12" r="1" />}
    </svg>
  );
};
