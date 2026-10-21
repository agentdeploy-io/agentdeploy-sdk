/**
 * DetailPanel
 * ───────────
 * Right-side detail drawer — a Tailwind port of the playground RowDrawer's
 * section/field structure, generalized so any record can be shown.
 *
 *   - fixed right drawer, w-[480px] max-w-full, border-l, bg-card, slide-in
 *   - backdrop on mobile (md:hidden) so desktop keeps a persistent side panel
 *   - header (title + subtitle + close), scrollable body, action slot footer
 *   - `sections` render as titled field grids or arbitrary content
 *   - Escape closes
 */

import React, { useEffect } from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────

export interface DetailField {
  label: string;
  value: React.ReactNode;
  /** Render the value in mono (ids, keys, numbers). */
  mono?: boolean;
}

export interface DetailSection {
  title?: string;
  /** Label/value grid (ignored when `content` is provided). */
  fields?: DetailField[];
  /** Arbitrary content — takes precedence over `fields`. */
  content?: React.ReactNode;
}

export interface DetailPanelProps {
  open: boolean;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  sections?: DetailSection[];
  /** Extra custom body content rendered after `sections`. */
  children?: React.ReactNode;
  /** Footer action-button slot. */
  actions?: React.ReactNode;
  onClose: () => void;
  className?: string;
}

// ─── Field value renderer ────────────────────────────────────────

function FieldValue({ field }: { field: DetailField }) {
  const { value, mono } = field;

  if (value === null || value === undefined || value === "") {
    return <span className="text-sm text-muted-foreground">-</span>;
  }

  // Plain React nodes (elements) render as-is.
  if (typeof value === "object" && React.isValidElement(value)) {
    return <div className="text-sm text-body">{value}</div>;
  }

  // Objects/arrays → pretty JSON block.
  if (typeof value === "object") {
    return (
      <pre className="scrollbar-thin max-h-52 overflow-auto rounded-sm bg-surface-canvas p-2 font-mono text-xs text-body">
        {JSON.stringify(value, null, 2)}
      </pre>
    );
  }

  return (
    <div className={cn("text-sm break-words text-body", mono && "font-mono")}>
      {String(value)}
    </div>
  );
}

// ─── Component ───────────────────────────────────────────────────

export const DetailPanel: React.FC<DetailPanelProps> = ({
  open,
  title,
  subtitle,
  sections,
  children,
  actions,
  onClose,
  className,
}) => {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      {/* Backdrop (mobile) */}
      <div
        onClick={onClose}
        aria-hidden
        className="fixed inset-0 z-40 bg-black/30 backdrop-blur-[2px] md:hidden"
      />

      {/* Drawer */}
      <aside
        role="dialog"
        aria-modal="true"
        className={cn(
          "fixed top-0 right-0 z-50 flex h-full w-[480px] max-w-full animate-fade-in flex-col border-l border-border bg-card shadow-float",
          className,
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="min-w-0">
            <h2 className="truncate text-base font-semibold text-foreground">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close panel"
            className="shrink-0 rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-surface-hover hover:text-foreground"
          >
            <X className="size-4" />
          </button>
        </div>

        {/* Body */}
        <div className="scrollbar-thin flex-1 overflow-y-auto px-5 py-4">
          {sections?.map((section, i) => (
            <section key={section.title ?? i} className="mb-5 last:mb-0">
              {section.title && (
                <h3 className="mb-2 text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground">
                  {section.title}
                </h3>
              )}
              {section.content ? (
                section.content
              ) : (
                <div className="flex flex-col gap-3">
                  {section.fields?.map((field) => (
                    <div key={field.label} className="flex flex-col gap-1">
                      <span className="text-[0.6875rem] font-medium uppercase tracking-wide text-muted-foreground">
                        {field.label.replace(/_/g, " ")}
                      </span>
                      <FieldValue field={field} />
                    </div>
                  ))}
                </div>
              )}
            </section>
          ))}
          {children}
        </div>

        {/* Actions */}
        {actions && (
          <div className="flex shrink-0 flex-wrap gap-2 border-t border-border px-5 py-4">
            {actions}
          </div>
        )}
      </aside>
    </>
  );
};

DetailPanel.displayName = "DetailPanel";
