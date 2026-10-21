/**
 * ToastContainer Component
 * ────────────────────────
 * Renders all active toast notifications in the bottom-right corner.
 * Consumes the useToast context (context lives in hooks/useToast.tsx —
 * the container is pure presentation, Tailwind + design tokens).
 *
 * Features (parity with the playground layout container):
 *   - Stacked toasts (newest at bottom)
 *   - Manual dismiss via close button
 *   - Action buttons (retry, reload, reconnect, go-home)
 *   - Variant-based colors (text-success / text-destructive /
 *     text-warning / text-info) and icons
 *
 * Toast Action Wiring:
 *   - "reload"    → window.location.reload()
 *   - "go-home"   → navigate to / (pushState + popstate)
 *   - "retry"     → dispatches global "calla:toast-retry" event
 *   - "reconnect" → dispatches global "calla:toast-reconnect" event
 *   Consumers listen via window.addEventListener(TOAST_RECONNECT_EVENT, ...).
 */

import React from "react";
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from "lucide-react";
import { useToast } from "@/hooks/useToast";
import type { Toast as ToastType, ToastVariant } from "@/types/ui";
import { cn } from "@/lib/utils";

// ─── Toast Action Events ─────────────────────────────────────────
// Global custom event names for toast actions that need to be handled
// by whatever component is currently mounted (e.g. the agent detail page).
export const TOAST_RETRY_EVENT = "calla:toast-retry";
export const TOAST_RECONNECT_EVENT = "calla:toast-reconnect";

/**
 * Dispatch a toast action event globally.
 */
function dispatchToastAction(eventName: string, toast: ToastType) {
  window.dispatchEvent(
    new CustomEvent(eventName, {
      detail: { toastId: toast.id },
    }),
  );
}

// ─── Variant Styles (design tokens — no inline theme colors) ─────

const VARIANT_STYLE: Record<
  ToastVariant,
  { accent: string; border: string; Icon: React.ComponentType<{ className?: string }> }
> = {
  success: { accent: "text-success", border: "border-l-success", Icon: CheckCircle2 },
  warning: { accent: "text-warning", border: "border-l-warning", Icon: AlertTriangle },
  error: { accent: "text-destructive", border: "border-l-destructive", Icon: XCircle },
  fatal: { accent: "text-destructive", border: "border-l-destructive", Icon: XCircle },
  info: { accent: "text-info", border: "border-l-info", Icon: Info },
};

// ─── Component ───────────────────────────────────────────────────

export const ToastContainer: React.FC = () => {
  const { toasts, dismiss } = useToast();

  return (
    <div
      aria-live="polite"
      aria-atomic="false"
      className="pointer-events-none fixed bottom-6 right-6 z-50 flex flex-col-reverse gap-2"
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
  const variant = VARIANT_STYLE[toast.variant] ?? VARIANT_STYLE.info;
  const { Icon } = variant;

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
      className={cn(
        "pointer-events-auto flex w-[340px] max-w-[calc(100vw-3rem)] items-start gap-3 rounded-md border border-l-4 bg-card p-3.5 shadow-elevated animate-fade-in",
        variant.border,
      )}
      role={toast.variant === "error" || toast.variant === "fatal" ? "alert" : "status"}
    >
      {/* Icon */}
      <Icon className={cn("mt-0.5 size-[18px] shrink-0", variant.accent)} />

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold text-foreground">{toast.title}</div>
        {toast.message && (
          <div className="mt-0.5 text-[0.8125rem] leading-snug text-muted-foreground">
            {toast.message}
          </div>
        )}

        {/* Action */}
        {toast.action && (
          <button
            type="button"
            onClick={handleAction}
            className={cn(
              "mt-2 p-0 text-[0.8125rem] font-medium hover:underline",
              variant.accent,
            )}
          >
            {toast.action.label}
          </button>
        )}
      </div>

      {/* Close Button */}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="Dismiss notification"
        className="flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
};
