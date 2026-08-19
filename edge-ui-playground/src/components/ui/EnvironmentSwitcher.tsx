/**
 * EnvironmentSwitcher Component
 * ──────────────────────────────
 * Dropdown for switching between local/staging/production environments.
 *
 * Design spec: cornerRadius:8, padding:[6,12], with chevron-down icon
 *
 * Features:
 *   - Lists all enabled environments from constants
 *   - Shows current selection with a status dot
 *   - Persists selection to localStorage
 *   - Dispatches change event
 */

import React from "react";
import { ENVIRONMENTS, DEFAULT_ENVIRONMENT } from "../../constants/navigation";
import { COLORS, RADIUS, STATUS_COLORS } from "../../constants/theme";

export interface EnvironmentSwitcherProps {
  value?: string;
  onChange?: (envId: string) => void;
}

export const EnvironmentSwitcher: React.FC<EnvironmentSwitcherProps> = ({
  value,
  onChange,
}) => {
  const [internalValue, setInternalValue] = React.useState(
    value ?? localStorage.getItem("edge-env") ?? DEFAULT_ENVIRONMENT,
  );
  const [open, setOpen] = React.useState(false);
  const dropdownRef = React.useRef<HTMLDivElement>(null);

  const currentValue = value ?? internalValue;
  const enabledEnvs = ENVIRONMENTS.filter((e) => e.enabled);
  const currentEnv = enabledEnvs.find((e) => e.id === currentValue) ?? enabledEnvs[0];

  React.useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleChange = (envId: string) => {
    setOpen(false);
    localStorage.setItem("edge-env", envId);
    setInternalValue(envId);
    onChange?.(envId);
  };

  return (
    <div ref={dropdownRef} style={{ position: "relative" }}>
      {/* Trigger */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        aria-haspopup="listbox"
        aria-expanded={open}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "8px",
          padding: "6px 12px",
          borderRadius: RADIUS.md,
          backgroundColor: COLORS.secondary,
          color: COLORS.foreground,
          fontSize: "0.8125rem",
          fontWeight: 500,
          border: "none",
          cursor: "pointer",
          transition: "background-color 150ms ease",
        }}
      >
        <span
          style={{
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            backgroundColor:
              currentEnv?.id === "production"
                ? STATUS_COLORS.success
                : currentEnv?.id === "staging"
                  ? STATUS_COLORS.warning
                  : STATUS_COLORS.info,
          }}
        />
        {currentEnv?.label ?? "Unknown"}
        {/* Chevron */}
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {/* Dropdown */}
      {open && (
        <div
          role="listbox"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: "160px",
            backgroundColor: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
            zIndex: 100,
            overflow: "hidden",
            animation: "slideIn 150ms ease-out",
          }}
        >
          {enabledEnvs.map((env) => (
            <button
              key={env.id}
              role="option"
              aria-selected={env.id === currentValue}
              onClick={() => handleChange(env.id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "8px",
                width: "100%",
                padding: "8px 12px",
                fontSize: "0.8125rem",
                color: COLORS.foreground,
                backgroundColor: env.id === currentValue ? COLORS.secondary : "transparent",
                border: "none",
                cursor: "pointer",
                textAlign: "left",
                transition: "background-color 100ms ease",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.backgroundColor = COLORS.cardHover;
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.backgroundColor =
                  env.id === currentValue ? COLORS.secondary : "transparent";
              }}
            >
              <span
                style={{
                  width: "8px",
                  height: "8px",
                  borderRadius: "50%",
                  backgroundColor:
                    env.id === "production" ? STATUS_COLORS.success : env.id === "staging" ? STATUS_COLORS.warning : STATUS_COLORS.info,
                }}
              />
              {env.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
