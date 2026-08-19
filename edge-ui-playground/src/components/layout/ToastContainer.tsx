/**
 * ToastContainer Component
 * ────────────────────────
 * Renders all active toast notifications in the bottom-right corner.
 * Reads from the useToast hook and displays them with animation.
 *
 * Features:
 *   - Stacked toasts (newest at bottom)
 *   - Auto-dismiss with progress bar
 *   - Manual dismiss via close button
 *   - Action buttons (retry, reload, etc.)
 *   - Variant-based colors and icons
 *
 * Toast Action Wiring:
 *   - "reload"   → window.location.reload()
 *   - "go-home"  → navigate to /
 *   - "retry"    → dispatches global "edge:toast-retry" event
 *   - "reconnect"→ dispatches global "edge:toast-reconnect" event
 *   Consumers (e.g., AgentDetailView) listen for these events via
 *   window.addEventListener("edge:toast-reconnect", handler).
 */

import React from "react";
import { COLORS, STATUS_COLORS, RADIUS, Z_INDEX, TRANSITIONS } from "../../constants/theme";
import { useToast } from "../../hooks/useToast";
import type { Toast as ToastType } from "../../types/ui";

// ─── Toast Action Events ─────────────────────────────────────────
// Global custom event names for toast actions that need to be handled
// by whatever component is currently mounted (e.g., AgentDetailView).
export const TOAST_RETRY_EVENT = "edge:toast-retry";
export const TOAST_RECONNECT_EVENT = "edge:toast-reconnect";

/**
 * Dispatch a toast action event globally.
 * Includes the agentId from the toast's context if available.
 */
function dispatchToastAction(eventName: string, toast: ToastType) {
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { toastId: toast.id },
    }),
  );
}

// ─── Component ───────────────────────────────────────────────────

export const ToastContainer: React.FC = () => {
  const { toasts, dismiss } = useToast();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      style={{
        position: "fixed",
        bottom: "24px",
        right: "24px",
        display: "flex",
        flexDirection: "column-reverse",
        gap: "8px",
        zIndex: Z_INDEX.toast,
        pointerEvents: "none",
      }}
    >
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
      ))}
    </div>
  );
};

// ─── Single Toast Item ───────────────────────────────────────────

const ToastItem: React.FC<{ toast: ToastType; onDismiss: () => void }> = ({
  toast,
  onDismiss,
}) => {
  const variantStyles = getVariantStyles(toast.variant);

  const handleAction = React.useCallback(() => {
    if (!toast.action) {
      onDismiss();
      return;
    }

    switch (toast.action.type) {
      case "reload":
        window.location.reload();
        break;
      case "go-home":
        window.history.pushState({}, "", "/");
        window.dispatchEvent(new PopStateEvent("popstate"));
        break;
      case "retry":
        dispatchToastAction(TOAST_RETRY_EVENT, toast);
        break;
      case "reconnect":
        dispatchToastAction(TOAST_RECONNECT_EVENT, toast);
        break;
      default:
        // Unknown action — just dismiss
        break;
    }

    onDismiss();
  }, [toast, onDismiss]);

  return (
    <div
      className="slide-in-right"
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: "12px",
        minWidth: "340px",
        maxWidth: "440px",
        padding: "14px 16px",
        backgroundColor: COLORS.card,
        border: `1px solid ${COLORS.border}`,
        borderLeft: `4px solid ${variantStyles.accent}`,
        borderRadius: RADIUS.md,
        boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
        pointerEvents: "auto",
        animation: "slideInRight 200ms ease-out",
      }}
      role={toast.variant === "error" || toast.variant === "fatal" ? "alert" : "status"}
    >
      {/* Icon */}
      <span style={{ fontSize: "1.125rem", lineHeight: 1.25, flexShrink: 0 }}>
        {variantStyles.icon}
      </span>

      {/* Content */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "2px" }}>
          {toast.title}
        </div>
        {toast.message && (
          <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, lineHeight: 1.4 }}>
            {toast.message}
          </div>
        )}

        {/* Action */}
        {toast.action && (
          <button
            onClick={handleAction}
            style={{
              marginTop: "8px",
              fontSize: "0.8125rem",
              fontWeight: 500,
              color: variantStyles.accent,
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {/* Close Button */}
      <button
        onClick={onDismiss}
        aria-label="Dismiss notification"
        style={{
          flexShrink: 0,
          width: "24px",
          height: "24px",
          borderRadius: RADIUS.sm,
          backgroundColor: "transparent",
          color: COLORS.mutedForeground,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          cursor: "pointer",
          border: "none",
          transition: `background-color ${TRANSITIONS.fast}`,
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.backgroundColor = COLORS.secondary;
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.backgroundColor = "transparent";
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
  );
};

// ─── Variant Styles ──────────────────────────────────────────────

function getVariantStyles(variant: string): { accent: string; icon: string } {
  switch (variant) {
    case "success":
      return { accent: STATUS_COLORS.success, icon: "✓" };
    case "warning":
      return { accent: STATUS_COLORS.warning, icon: "⚠" };
    case "error":
      return { accent: STATUS_COLORS.error, icon: "✕" };
    case "fatal":
      return { accent: STATUS_COLORS.error, icon: "✕" };
    case "info":
      return { accent: STATUS_COLORS.info, icon: "ℹ" };
    default:
      return { accent: COLORS.border, icon: "•" };
  }
}
