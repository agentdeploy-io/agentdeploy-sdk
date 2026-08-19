/**
 * useToast Hook + ToastProvider
 * ──────────────────────────────
 * Centralized toast notification system.
 *
 * Features:
 *   - Auto-dismiss with configurable duration per variant
 *   - Max visible toasts (older ones are removed)
 *   - Action buttons (retry, reload, etc.)
 *   - Manually dismissible
 *   - Integrates with errorHandler via subscription
 *
 * Usage:
 *   const { toasts, dismiss, push } = useToast();
 *   push({ variant: "success", title: "Saved!", message: "Config updated." })
 *
 * Or use the toast helper directly:
 *   import { toast } from "./useToast";
 *   toast.success("Saved!");
 */

import React, { createContext, useContext, useCallback, useRef, useEffect } from "react";
import { errorHandler } from "../errors/errorHandler";
import { TOAST_CONFIG } from "../constants/errors";
import type { Toast, ToastVariant } from "../types/ui";

// ─── Context ─────────────────────────────────────────────────────

interface ToastContextValue {
  toasts: Toast[];
  push: (toast: Omit<Toast, "id" | "createdAt">) => string;
  dismiss: (id: string) => void;
  clear: () => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

// ─── Provider ────────────────────────────────────────────────────

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [toasts, setToasts] = React.useState<Toast[]>([]);
  const timersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  // ─── Dismiss ──────────────────────────────────────────────────

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));

    // Clean up timer
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  // ─── Push ─────────────────────────────────────────────────────

  const push = useCallback(
    (toastData: Omit<Toast, "id" | "createdAt">): string => {
      const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const toast: Toast = {
        ...toastData,
        id,
        createdAt: Date.now(),
      };

      setToasts((prev) => {
        // Enforce max visible — remove oldest
        const trimmed = prev.length >= TOAST_CONFIG.maxVisible ? prev.slice(1) : prev;
        return [...trimmed, toast];
      });

      // Auto-dismiss timer (if duration > 0)
      if (toast.duration > 0) {
        const timer = setTimeout(() => dismiss(id), toast.duration);
        timersRef.current.set(id, timer);
      }

      return id;
    },
    [dismiss],
  );

  // ─── Clear All ────────────────────────────────────────────────

  const clear = useCallback(() => {
    setToasts([]);
    timersRef.current.forEach((timer) => clearTimeout(timer));
    timersRef.current.clear();
  }, []);

  // ─── Subscribe to errorHandler ────────────────────────────────

  useEffect(() => {
    const unsubscribe = errorHandler.subscribe((error, toast) => {
      if (toast) {
        push({
          variant: toast.variant,
          title: toast.title,
          message: toast.message,
          duration: toast.duration,
          action: toast.action,
        });
      }
    });
    return unsubscribe;
  }, [push]);

  // ─── Cleanup timers on unmount ────────────────────────────────

  useEffect(() => {
    const timers = timersRef.current;
    return () => {
      timers.forEach((timer) => clearTimeout(timer));
      timers.clear();
    };
  }, []);

  const value: ToastContextValue = { toasts, push, dismiss, clear };

  return <ToastContext.Provider value={value}>{children}</ToastContext.Provider>;
};

// ─── useToast Hook ───────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast must be used within a <ToastProvider>");
  }
  return ctx;
}

// ─── Imperative Toast Helper ─────────────────────────────────────
// Allows calling toast.success() from anywhere without hooks.
// Must be called after ToastProvider has mounted.

let externalPush: ((toast: Omit<Toast, "id" | "createdAt">) => string) | null = null;

export function registerToastPusher(fn: (toast: Omit<Toast, "id" | "createdAt">) => string) {
  externalPush = fn;
}

export const toast = {
  success: (title: string, message?: string) =>
    externalPush?.({ variant: "success" as ToastVariant, title, message: message ?? "", duration: 3000 }),

  error: (title: string, message?: string) =>
    externalPush?.({ variant: "error" as ToastVariant, title, message: message ?? "", duration: 8000 }),

  warning: (title: string, message?: string) =>
    externalPush?.({ variant: "warning" as ToastVariant, title, message: message ?? "", duration: 6000 }),

  info: (title: string, message?: string) =>
    externalPush?.({ variant: "info" as ToastVariant, title, message: message ?? "", duration: 4000 }),

  push: (data: Omit<Toast, "id" | "createdAt">) => externalPush?.(data),
};
