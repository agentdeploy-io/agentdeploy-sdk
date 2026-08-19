/**
 * Modal / Dialog Component
 * ────────────────────────
 * Accessible modal dialog with backdrop, focus trapping, and
 * keyboard dismissal (Escape key).
 *
 * Features:
 *   - Backdrop blur overlay
 *   - Click outside to close
 *   - Escape key to close
 *   - Sizes: sm (400px), md (500px), lg (640px)
 *   - Destructive variant (red header)
 *   - Footer slot for action buttons
 *   - Body scroll lock when open
 *
 * Usage:
 *   <Modal open={isOpen} onClose={handleClose} title="Delete Agent">
 *     Are you sure?
 *     <Modal.Footer>
 *       <Button onClick={handleClose}>Cancel</Button>
 *       <Button variant="destructive">Delete</Button>
 *     </Modal.Footer>
 *   </Modal>
 */

import React from "react";
import { COLORS, RADIUS, Z_INDEX, STATUS_COLORS } from "../../constants/theme";
import { Button } from "./Button";

// ─── Types ───────────────────────────────────────────────────────

export interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  size?: "sm" | "md" | "lg";
  destructive?: boolean;
  children: React.ReactNode;
  /** Show default footer with close button */
  showDefaultFooter?: boolean;
  closeLabel?: string;
}

// ─── Size Config ─────────────────────────────────────────────────

const SIZES: Record<string, number> = {
  sm: 400,
  md: 500,
  lg: 640,
};

// ─── Component ───────────────────────────────────────────────────

export const Modal: React.FC<ModalProps> = ({
  open,
  onClose,
  title,
  description,
  size = "md",
  destructive = false,
  children,
  showDefaultFooter = false,
  closeLabel = "Close",
}) => {
  const modalRef = React.useRef<HTMLDivElement>(null);

  // Lock body scroll when open
  React.useEffect(() => {
    if (open) {
      const original = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      return () => {
        document.body.style.overflow = original;
      };
    }
  }, [open]);

  // Escape to close + focus trap
  React.useEffect(() => {
    if (!open) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
      // Basic focus trap
      if (e.key === "Tab" && modalRef.current) {
        const focusable = modalRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open, onClose]);

  // Focus modal on open
  React.useEffect(() => {
    if (open && modalRef.current) {
      requestAnimationFrame(() => {
        const firstFocusable = modalRef.current?.querySelector<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        );
        firstFocusable?.focus();
      });
    }
  }, [open]);

  if (!open) return null;

  return (
    <div
      style={{
        position: "fixed",
        inset: 0,
        zIndex: Z_INDEX.overlay,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "16px",
      }}
    >
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: "absolute",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          backdropFilter: "blur(2px)",
          animation: "fadeIn 150ms ease-out",
        }}
      />

      {/* Modal */}
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        style={{
          position: "relative",
          width: "100%",
          maxWidth: `${SIZES[size]}px`,
          maxHeight: "85vh",
          backgroundColor: COLORS.card,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          boxShadow: "0 20px 45px -5px rgba(0,0,0,0.2), 0 8px 10px -6px rgba(0,0,0,0.1)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          animation: "slideIn 200ms ease-out",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            gap: "16px",
            padding: "20px 24px 16px",
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <div>
            <h2
              id="modal-title"
              style={{
                fontSize: "1.125rem",
                fontWeight: 600,
                color: destructive ? STATUS_COLORS.error : COLORS.foreground,
              }}
            >
              {title}
            </h2>
            {description && (
              <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, marginTop: "4px" }}>
                {description}
              </p>
            )}
          </div>

          {/* Close button */}
          <button
            onClick={onClose}
            aria-label="Close dialog"
            style={{
              flexShrink: 0,
              width: "32px",
              height: "32px",
              borderRadius: RADIUS.sm,
              backgroundColor: "transparent",
              border: "none",
              color: COLORS.mutedForeground,
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              transition: "background-color 150ms ease",
            }}
            onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.secondary)}
            onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px 24px" }}>
          {children}
        </div>

        {/* Default Footer */}
        {showDefaultFooter && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "flex-end",
              gap: "8px",
              padding: "16px 24px",
              borderTop: `1px solid ${COLORS.border}`,
            }}
          >
            <Button variant="outline" size="sm" onClick={onClose}>
              {closeLabel}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
};

// ─── Confirm Dialog (pre-built modal for confirmations) ──────────

export interface ConfirmDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
}

export const ConfirmDialog: React.FC<ConfirmDialogProps> = ({
  open,
  onClose,
  onConfirm,
  title,
  message,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
}) => (
  <Modal open={open} onClose={onClose} title={title} size="sm" destructive={destructive}>
    <p style={{ fontSize: "0.875rem", color: COLORS.foreground, lineHeight: 1.6 }}>{message}</p>
    <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "24px" }}>
      <Button variant="outline" size="sm" onClick={onClose}>
        {cancelLabel}
      </Button>
      <Button
        variant={destructive ? "destructive" : "primary"}
        size="sm"
        onClick={() => {
          onConfirm();
          onClose();
        }}
      >
        {confirmLabel}
      </Button>
    </div>
  </Modal>
);
