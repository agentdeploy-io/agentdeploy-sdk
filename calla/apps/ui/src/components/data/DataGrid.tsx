/**
 * DataGrid
 * ────────
 * Virtualized-ish tabular grid for data-plane rows (leads, replies, sites).
 * Faithful Tailwind rebuild of the playground DataGrid — same ColumnDef +
 * renderCell API, type-aware cells (expandable JSON, email domain chip,
 * relative-time dates, status → Badge), row selection, sortable headers,
 * highlight + keyboard-focus rings.
 *
 * STATUS_BADGE_VARIANT is preserved from the original; the "neutral" tone
 * maps to the Calla Badge "muted" variant.
 */

import React, { useCallback, useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { Badge } from "@/components/ui";
import { cn, relativeTime } from "@/lib/utils";

// ─── Types ───────────────────────────────────────────────────────

export type ColumnType =
  | "string"
  | "number"
  | "json"
  | "email"
  | "url"
  | "date"
  | "status";

export interface ColumnDef {
  key: string;
  label: string;
  type: ColumnType;
  width?: string;
  minWidth?: string;
  sortable?: boolean;
  visible?: boolean;
}

export type SortDir = "asc" | "desc";

export interface DataGridProps {
  columns: ColumnDef[];
  rows: Record<string, unknown>[];
  rowKey: string;
  selectedKeys: Set<string>;
  onSelectionChange: (keys: Set<string>) => void;
  onRowClick?: (row: Record<string, unknown>) => void;
  sortColumn?: string;
  sortDir?: SortDir;
  onSort?: (column: string) => void;
  highlightRow?: string | null;
  focusedRow?: number;
  className?: string;
}

// ─── Status → Badge variant ──────────────────────────────────────

type BadgeVariant = "success" | "warning" | "error" | "info" | "muted";

export const STATUS_BADGE_VARIANT: Record<string, BadgeVariant> = {
  approved: "success",
  active: "success",
  verified: "info",
  pending: "warning",
  pending_review: "warning",
  rejected: "error",
  failed: "error",
  erased: "muted",
  sent: "info",
  replied: "success",
  researched: "info",
  classified: "info",
  raw: "muted",
};

// ─── Helpers ─────────────────────────────────────────────────────

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isValidUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

// ─── Cells ───────────────────────────────────────────────────────

const JsonCell: React.FC<{ value: unknown }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground">-</span>;
  }
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const short = str.length > 40 ? `${str.slice(0, 40)}…` : str;
  return (
    <button
      type="button"
      title="Click to expand"
      onClick={(e) => {
        e.stopPropagation();
        setExpanded((v) => !v);
      }}
      className={cn(
        "cursor-pointer text-left font-mono text-xs text-body",
        expanded && "whitespace-pre-wrap",
      )}
    >
      {expanded ? str : short}
    </button>
  );
};

export function renderCell(
  type: ColumnType,
  value: unknown,
  _row: Record<string, unknown>,
): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span className="text-muted-foreground">-</span>;
  }

  switch (type) {
    case "json":
      return <JsonCell value={value} />;

    case "email": {
      const str = String(value);
      if (!isValidEmail(str)) return <span className="truncate">{str}</span>;
      const domain = str.split("@")[1];
      return (
        <span className="inline-flex min-w-0 items-center gap-1">
          <a
            href={`mailto:${str}`}
            onClick={(e) => e.stopPropagation()}
            className="truncate text-primary hover:underline"
          >
            {str}
          </a>
          {domain && (
            <span className="shrink-0 rounded-sm bg-surface-tag px-1 py-px text-[0.625rem] font-medium text-muted-foreground">
              {domain}
            </span>
          )}
        </span>
      );
    }

    case "url": {
      const str = String(value);
      if (!isValidUrl(str)) return <span className="truncate">{str}</span>;
      let display: string;
      try {
        display = new URL(str).hostname;
      } catch {
        display = str;
      }
      return (
        <a
          href={str}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          className="truncate text-primary hover:underline"
        >
          {display}
        </a>
      );
    }

    case "date": {
      const str = String(value);
      const d = new Date(str);
      if (isNaN(d.getTime())) return <span className="truncate">{str}</span>;
      return (
        <span title={d.toLocaleString()} className="truncate text-muted-foreground">
          {relativeTime(str)}
        </span>
      );
    }

    case "status": {
      const key = String(value).toLowerCase();
      const variant = STATUS_BADGE_VARIANT[key] ?? "muted";
      return <Badge variant={variant}>{String(value)}</Badge>;
    }

    case "number":
      return (
        <span className="font-mono text-[0.8125rem] tabular-nums">{String(value)}</span>
      );

    default:
      return <span className="truncate">{String(value)}</span>;
  }
}

// ─── Component ───────────────────────────────────────────────────

export const DataGrid: React.FC<DataGridProps> = React.memo(
  ({
    columns,
    rows,
    rowKey,
    selectedKeys,
    onSelectionChange,
    onRowClick,
    sortColumn,
    sortDir,
    onSort,
    highlightRow,
    focusedRow,
    className,
  }) => {
    const visibleColumns = useMemo(
      () => columns.filter((c) => c.visible !== false),
      [columns],
    );

    const allSelected =
      rows.length > 0 && rows.every((r) => selectedKeys.has(String(r[rowKey])));
    const someSelected = rows.some((r) => selectedKeys.has(String(r[rowKey])));

    const handleSelectAll = useCallback(() => {
      const next = new Set(selectedKeys);
      if (allSelected) {
        for (const r of rows) next.delete(String(r[rowKey]));
      } else {
        for (const r of rows) next.add(String(r[rowKey]));
      }
      onSelectionChange(next);
    }, [allSelected, rows, rowKey, selectedKeys, onSelectionChange]);

    const handleSelectRow = useCallback(
      (key: string) => {
        const next = new Set(selectedKeys);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onSelectionChange(next);
      },
      [selectedKeys, onSelectionChange],
    );

    // Checkbox column (40px) + one track per visible column.
    const gridTemplateColumns = `40px ${visibleColumns
      .map((c) => c.width ?? `minmax(${c.minWidth ?? "120px"}, 1fr)`)
      .join(" ")}`;

    return (
      <div
        className={cn(
          "overflow-hidden rounded-lg border border-border bg-card",
          className,
        )}
      >
        {/* Header */}
        <div
          className="sticky top-0 z-10 grid border-b border-border bg-card"
          style={{ gridTemplateColumns }}
        >
          <div className="flex h-9 items-center justify-center">
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => {
                if (el) el.indeterminate = someSelected && !allSelected;
              }}
              onChange={handleSelectAll}
              aria-label="Select all rows"
              className="size-3.5 cursor-pointer accent-[hsl(var(--primary))]"
            />
          </div>
          {visibleColumns.map((col) => {
            const sortable = col.sortable !== false && !!onSort;
            const active = sortColumn === col.key;
            return (
              <button
                key={col.key}
                type="button"
                disabled={!sortable}
                onClick={() => sortable && onSort?.(col.key)}
                className={cn(
                  "flex h-9 items-center gap-1 truncate px-3 text-left text-[0.6875rem] font-semibold uppercase tracking-wide text-muted-foreground select-none",
                  sortable && "cursor-pointer hover:text-foreground",
                )}
              >
                <span className="truncate">{col.label}</span>
                {active &&
                  (sortDir === "asc" ? (
                    <ArrowUp className="size-3 shrink-0" />
                  ) : (
                    <ArrowDown className="size-3 shrink-0" />
                  ))}
              </button>
            );
          })}
        </div>

        {/* Body */}
        <div className="scrollbar-thin max-h-[calc(100vh-340px)] overflow-auto">
          {rows.map((row, idx) => {
            const key = String(row[rowKey]);
            const isSelected = selectedKeys.has(key);
            const isHighlighted = highlightRow === key;
            const isFocused = focusedRow === idx;
            return (
              <div
                key={key}
                onClick={() => onRowClick?.(row)}
                className={cn(
                  "grid border-b border-border text-[0.8125rem] text-body transition-colors last:border-b-0",
                  isHighlighted
                    ? "bg-info/10"
                    : isSelected
                      ? "bg-success/10"
                      : "hover:bg-surface-hover",
                  onRowClick && "cursor-pointer",
                  isFocused && "outline outline-2 -outline-offset-2 outline-primary",
                )}
                style={{ gridTemplateColumns }}
              >
                <div className="flex h-10 items-center justify-center">
                  <input
                    type="checkbox"
                    checked={isSelected}
                    aria-label={`Select row ${key}`}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => handleSelectRow(key)}
                    className="size-3.5 cursor-pointer accent-[hsl(var(--primary))]"
                  />
                </div>
                {visibleColumns.map((col) => (
                  <div
                    key={col.key}
                    className="flex h-10 min-w-0 items-center overflow-hidden px-3"
                  >
                    {renderCell(col.type, row[col.key], row)}
                  </div>
                ))}
              </div>
            );
          })}

          {rows.length === 0 && (
            <div className="px-6 py-12 text-center text-sm text-muted-foreground">
              No data found
            </div>
          )}
        </div>
      </div>
    );
  },
);

DataGrid.displayName = "DataGrid";
