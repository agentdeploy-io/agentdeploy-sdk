import React, { useCallback, useRef, useMemo, useState } from "react";
import { COLORS, RADIUS, COMPONENT_SPEC, TRANSITIONS, STATUS_COLORS } from "../constants/theme";
import { Badge } from "./ui/Badge";

// ─── Types ───────────────────────────────────────────────────────

export type ColumnType = "string" | "number" | "json" | "email" | "url" | "date" | "status";

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
}

// ─── Cell Renderers ──────────────────────────────────────────────

const STATUS_BADGE_VARIANT: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  approved: "success",
  active: "success",
  verified: "info",
  pending: "warning",
  pending_review: "warning",
  rejected: "error",
  failed: "error",
  erased: "neutral",
  sent: "info",
  replied: "success",
  researched: "info",
  classified: "info",
  raw: "neutral",
};

function relativeTime(dateStr: string): string {
  const d = new Date(dateStr);
  const now = Date.now();
  const diff = now - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  return `${months}mo ago`;
}

function isValidEmail(v: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);
}

function isValidUrl(v: string): boolean {
  try { new URL(v); return true; } catch { return false; }
}

const JsonCell: React.FC<{ value: unknown }> = ({ value }) => {
  const [expanded, setExpanded] = useState(false);
  if (value === null || value === undefined) return <span style={{ color: COLORS.mutedForeground }}>-</span>;
  const str = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  const short = str.length > 40 ? str.slice(0, 40) + "..." : str;
  return (
    <span
      onClick={(e) => { e.stopPropagation(); setExpanded(!expanded); }}
      style={{ cursor: "pointer", fontFamily: "var(--font-mono)", fontSize: "0.75rem" }}
      title="Click to expand"
    >
      {expanded ? str : short}
    </span>
  );
};

function renderCell(type: ColumnType, value: unknown, _row: Record<string, unknown>): React.ReactNode {
  if (value === null || value === undefined || value === "") {
    return <span style={{ color: COLORS.mutedForeground }}>-</span>;
  }

  switch (type) {
    case "json":
      return <JsonCell value={value} />;

    case "email": {
      const str = String(value);
      if (!isValidEmail(str)) return <span>{str}</span>;
      const domain = str.split("@")[1];
      return (
        <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
          <a
            href={`mailto:${str}`}
            onClick={(e) => e.stopPropagation()}
            style={{ color: COLORS.primary, textDecoration: "none" }}
          >
            {str}
          </a>
          <span style={{
            fontSize: "0.625rem",
            padding: "1px 4px",
            borderRadius: "3px",
            backgroundColor: COLORS.secondary,
            color: COLORS.mutedForeground,
            fontWeight: 500,
          }}>
            {domain}
          </span>
        </span>
      );
    }

    case "url": {
      const str = String(value);
      if (!isValidUrl(str)) return <span>{str}</span>;
      let display: string;
      try { display = new URL(str).hostname; } catch { display = str; }
      return (
        <a
          href={str}
          target="_blank"
          rel="noopener noreferrer"
          onClick={(e) => e.stopPropagation()}
          style={{ color: COLORS.primary, textDecoration: "none" }}
        >
          {display}
        </a>
      );
    }

    case "date": {
      const str = String(value);
      const d = new Date(str);
      if (isNaN(d.getTime())) return <span>{str}</span>;
      return (
        <span title={d.toLocaleString()} style={{ color: COLORS.mutedForeground }}>
          {relativeTime(str)}
        </span>
      );
    }

    case "status": {
      const str = String(value).toLowerCase();
      const variant = STATUS_BADGE_VARIANT[str] ?? "neutral";
      return <Badge variant={variant}>{String(value)}</Badge>;
    }

    case "number":
      return <span style={{ fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>{String(value)}</span>;

    default:
      return <span>{String(value)}</span>;
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
  }) => {
    const bodyRef = useRef<HTMLDivElement>(null);
    const visibleColumns = useMemo(() => columns.filter((c) => c.visible !== false), [columns]);

    const allSelected = rows.length > 0 && rows.every((r) => selectedKeys.has(String(r[rowKey])));
    const someSelected = rows.some((r) => selectedKeys.has(String(r[rowKey])));

    const handleSelectAll = useCallback(() => {
      if (allSelected) {
        const next = new Set(selectedKeys);
        for (const r of rows) next.delete(String(r[rowKey]));
        onSelectionChange(next);
      } else {
        const next = new Set(selectedKeys);
        for (const r of rows) next.add(String(r[rowKey]));
        onSelectionChange(next);
      }
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

    const gridTemplateColumns = `40px ${visibleColumns
      .map((c) => c.width ?? `minmax(${c.minWidth ?? "120px"}, 1fr)`)
      .join(" ")}`;

    const headerStyle: React.CSSProperties = {
      display: "grid",
      gridTemplateColumns,
      position: "sticky",
      top: 0,
      zIndex: 10,
      backgroundColor: COLORS.card,
      borderBottom: `1px solid ${COLORS.border}`,
    };

    const thStyle: React.CSSProperties = {
      padding: "0 12px",
      height: COMPONENT_SPEC.tableHeader.height,
      display: "flex",
      alignItems: "center",
      fontSize: "0.75rem",
      fontWeight: 600,
      color: COLORS.mutedForeground,
      textTransform: "uppercase",
      letterSpacing: "0.04em",
      userSelect: "none",
      gap: "4px",
    };

    return (
      <div
        style={{
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          backgroundColor: COLORS.card,
          overflow: "hidden",
        }}
      >
        {/* Header */}
        <div style={headerStyle}>
          <div style={{ ...thStyle, justifyContent: "center" }}>
            <input
              type="checkbox"
              checked={allSelected}
              ref={(el) => { if (el) el.indeterminate = someSelected && !allSelected; }}
              onChange={handleSelectAll}
              style={{ accentColor: COLORS.primary, cursor: "pointer" }}
            />
          </div>
          {visibleColumns.map((col) => (
            <div
              key={col.key}
              style={{
                ...thStyle,
                cursor: col.sortable !== false ? "pointer" : "default",
              }}
              onClick={() => col.sortable !== false && onSort?.(col.key)}
            >
              {col.label}
              {sortColumn === col.key && (
                <span style={{ fontSize: "0.625rem" }}>
                  {sortDir === "asc" ? "\u25B2" : "\u25BC"}
                </span>
              )}
            </div>
          ))}
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          style={{
            maxHeight: "calc(100vh - 340px)",
            overflowY: "auto",
            overflowX: "auto",
          }}
        >
          {rows.map((row, idx) => {
            const key = String(row[rowKey]);
            const isSelected = selectedKeys.has(key);
            const isHighlighted = highlightRow === key;
            const isFocused = focusedRow === idx;
            return (
              <div
                key={key}
                onClick={() => onRowClick?.(row)}
                style={{
                  display: "grid",
                  gridTemplateColumns,
                  borderBottom: `1px solid ${COLORS.border}`,
                  backgroundColor: isHighlighted
                    ? STATUS_COLORS.infoBg
                    : isSelected
                      ? "var(--color-success-bg)"
                      : "transparent",
                  cursor: onRowClick ? "pointer" : "default",
                  transition: `background-color ${TRANSITIONS.fast}`,
                  outline: isFocused ? `2px solid ${COLORS.primary}` : "none",
                  outlineOffset: "-2px",
                }}
                onMouseEnter={(e) => {
                  if (!isHighlighted && !isSelected) e.currentTarget.style.backgroundColor = COLORS.cardHover;
                }}
                onMouseLeave={(e) => {
                  if (!isHighlighted && !isSelected) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    height: COMPONENT_SPEC.tableRow.height,
                  }}
                >
                  <input
                    type="checkbox"
                    checked={isSelected}
                    onChange={(e) => { e.stopPropagation(); handleSelectRow(key); }}
                    onClick={(e) => e.stopPropagation()}
                    style={{ accentColor: COLORS.primary, cursor: "pointer" }}
                  />
                </div>
                {visibleColumns.map((col) => (
                  <div
                    key={col.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      height: COMPONENT_SPEC.tableRow.height,
                      padding: "0 12px",
                      fontSize: "0.8125rem",
                      color: COLORS.foreground,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {renderCell(col.type, row[col.key], row)}
                  </div>
                ))}
              </div>
            );
          })}
          {rows.length === 0 && (
            <div
              style={{
                padding: "48px 24px",
                textAlign: "center",
                color: COLORS.mutedForeground,
                fontSize: "0.875rem",
              }}
            >
              No data found
            </div>
          )}
        </div>
      </div>
    );
  },
);

DataGrid.displayName = "DataGrid";
