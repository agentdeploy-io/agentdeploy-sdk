/**
 * Tabs Component
 * ──────────────
 * Horizontal tab navigation for switching between sub-views.
 *
 * Design spec: height:48, padding:[0,16], fontSize:14
 * Active tab: strokeWidth:{bottom:2} with primary color
 * Container: strokeWidth:{bottom:1} with border color
 *
 * Features:
 *   - Controlled and uncontrolled modes
 *   - Disabled tabs
 *   - Badge counts on tabs
 *   - Keyboard navigation (arrow keys)
 *   - Animated active indicator
 */

import React from "react";
import { COMPONENT_SPEC, COLORS } from "../../constants/theme";

// ─── Types ───────────────────────────────────────────────────────

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ReactNode;
  badge?: string | number;
  disabled?: boolean;
}

export interface TabsProps {
  tabs: TabItem[];
  activeTab: string;
  onChange: (tabId: string) => void;
  /** Variant of the tabs (underline or pills) */
  variant?: "underline" | "pills";
  style?: React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────────

export const Tabs: React.FC<TabsProps> = React.memo(
  ({ tabs, activeTab, onChange, variant = "underline", style }) => {
    const tabListRef = React.useRef<HTMLDivElement>(null);

    // Keyboard navigation
    const handleKeyDown = React.useCallback(
      (e: React.KeyboardEvent, currentIndex: number) => {
        const enabledTabs = tabs.filter((t) => !t.disabled);
        const enabledIndex = enabledTabs.findIndex((t) => t.id === tabs[currentIndex]?.id);
        if (enabledIndex === -1) return;

        let nextIndex: number | null = null;
        if (e.key === "ArrowRight") {
          nextIndex = (enabledIndex + 1) % enabledTabs.length;
        } else if (e.key === "ArrowLeft") {
          nextIndex = (enabledIndex - 1 + enabledTabs.length) % enabledTabs.length;
        } else if (e.key === "Home") {
          nextIndex = 0;
        } else if (e.key === "End") {
          nextIndex = enabledTabs.length - 1;
        }

        if (nextIndex !== null) {
          e.preventDefault();
          onChange(enabledTabs[nextIndex].id);
        }
      },
      [tabs, onChange],
    );

    if (variant === "pills") {
      return (
        <div
          ref={tabListRef}
          role="tablist"
          style={{
            display: "inline-flex",
            gap: "4px",
            padding: "4px",
            backgroundColor: COLORS.secondary,
            borderRadius: "8px",
            ...style,
          }}
        >
          {tabs.map((tab, index) => {
            const isActive = tab.id === activeTab;
            return (
              <button
                key={tab.id}
                role="tab"
                aria-selected={isActive}
                aria-disabled={tab.disabled}
                disabled={tab.disabled}
                onClick={() => !tab.disabled && onChange(tab.id)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  height: "32px",
                  padding: "0 12px",
                  borderRadius: "6px",
                  fontSize: "0.8125rem",
                  fontWeight: 500,
                  backgroundColor: isActive ? COLORS.card : "transparent",
                  color: isActive ? COLORS.foreground : COLORS.mutedForeground,
                  boxShadow: isActive ? "0 1px 2px rgba(0,0,0,0.06)" : "none",
                  cursor: tab.disabled ? "not-allowed" : "pointer",
                  opacity: tab.disabled ? 0.5 : 1,
                  transition: "background-color 150ms ease, color 150ms ease",
                  border: "none",
                }}
              >
                {tab.icon}
                {tab.label}
                {tab.badge !== undefined && (
                  <span
                    style={{
                      fontSize: "0.6875rem",
                      padding: "1px 6px",
                      borderRadius: "10px",
                      backgroundColor: isActive ? COLORS.primary : COLORS.border,
                      color: isActive ? COLORS.primaryForeground : COLORS.mutedForeground,
                      fontWeight: 600,
                    }}
                  >
                    {tab.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      );
    }

    // Underline variant (default — matches design spec)
    return (
      <div
        ref={tabListRef}
        role="tablist"
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0",
          borderBottom: `1px solid ${COLORS.border}`,
          ...style,
        }}
      >
        {tabs.map((tab, index) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              role="tab"
              aria-selected={isActive}
              aria-disabled={tab.disabled}
              disabled={tab.disabled}
              onClick={() => !tab.disabled && onChange(tab.id)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "8px",
                height: `${COMPONENT_SPEC.tab.height}`,
                padding: `0 ${COMPONENT_SPEC.tab.paddingX}`,
                fontSize: COMPONENT_SPEC.tab.fontSize,
                fontWeight: isActive ? 600 : 500,
                color: isActive ? COLORS.foreground : COLORS.mutedForeground,
                backgroundColor: "transparent",
                borderTop: "none",
                borderLeft: "none",
                borderRight: "none",
                borderBottom: `${COMPONENT_SPEC.tab.activeBorderWidth} solid ${
                  isActive ? COLORS.primary : "transparent"
                }`,
                marginBottom: "-1px", // overlap the container border
                cursor: tab.disabled ? "not-allowed" : "pointer",
                opacity: tab.disabled ? 0.5 : 1,
                transition: "color 150ms ease, border-color 150ms ease",
                position: "relative",
              }}
            >
              {tab.icon}
              {tab.label}
              {tab.badge !== undefined && (
                <span
                  style={{
                    fontSize: "0.6875rem",
                    padding: "1px 6px",
                    borderRadius: "10px",
                    backgroundColor: isActive ? COLORS.primary : COLORS.secondary,
                    color: isActive ? COLORS.primaryForeground : COLORS.mutedForeground,
                    fontWeight: 600,
                  }}
                >
                  {tab.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>
    );
  },
);

Tabs.displayName = "Tabs";
