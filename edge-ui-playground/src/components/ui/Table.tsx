/**
 * Table Component
 * ───────────────
 * Data table with sorting, empty states, and loading states.
 *
 * Design spec:
 *   Header: height:44, borderBottom:1px solid #E4E4E7
 *   Row: height:48, borderBottom:1px solid #E4E4E7
 *
 * Features:
 *   - Column sorting (clickable headers)
 *   - Row click navigation
 *   - Loading skeleton rows
 *   - Empty state with icon + message
 *   - Error state with retry
 *   - Custom cell rendering
 *   - Responsive (horizontal scroll on overflow)
 */

import React from "react";
import { COMPONENT_SPEC, COLORS } from "../../constants/theme";
import type { TableColumn, SortState, SortDirection, LoadingState, EmptyStateConfig } from "../../types/ui";
import { Button } from "./Button";

// ─── Props ───────────────────────────────────────────────────────

export interface TableProps<T = unknown> {
  columns: TableColumn<T>[];
  data: T[];
  rowKey: (row: T, index: number) => string;
  onRowClick?: (row: T) => void;
  sortable?: boolean;
  sort?: SortState;
  onSortChange?: (sort: SortState) => void;
  loading?: boolean;
  loadingRowCount?: number;
  emptyState?: EmptyStateConfig;
  errorState?: {
    message: string;
    onRetry?: () => void;
  };
  style?: React.CSSProperties;
}

// ─── Component ───────────────────────────────────────────────────

export function Table<T>({
  columns,
  data,
  rowKey,
  onRowClick,
  sortable = false,
  sort,
  onSortChange,
  loading = false,
  loadingRowCount = 5,
  emptyState,
  errorState,
  style,
}: TableProps<T>) {
  // ─── Sort Handler ──────────────────────────────────────────────

  const handleSort = React.useCallback(
    (columnKey: string) => {
      if (!sortable || !onSortChange) return;

      const newDirection: SortDirection =
        sort?.column === columnKey && sort.direction === "asc" ? "desc" : "asc";

      onSortChange({ column: columnKey, direction: newDirection });
    },
    [sortable, sort, onSortChange],
  );

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div style={{ width: "100%", overflowX: "auto", ...style }}>
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        {/* ─── Header ──────────────────────────────────────────── */}
        <thead>
          <tr>
            {columns.map((col) => {
              const isSortable = sortable && col.sortable !== false;
              const isSorted = sort?.column === (col.key as string);

              return (
                <th
                  key={col.key as string}
                  onClick={() => isSortable && handleSort(col.key as string)}
                  style={{
                    height: COMPONENT_SPEC.tableHeader.height,
                    padding: "0 16px",
                    fontSize: "0.75rem",
                    fontWeight: 600,
                    textTransform: "uppercase",
                    letterSpacing: "0.04em",
                    color: COLORS.mutedForeground,
                    textAlign: col.align ?? "left",
                    borderBottom: `1px solid ${COLORS.border}`,
                    whiteSpace: "nowrap",
                    cursor: isSortable ? "pointer" : "default",
                    userSelect: "none",
                  }}
                >
                  <span style={{ display: "inline-flex", alignItems: "center", gap: "4px" }}>
                    {col.label}
                    {isSortable && (
                      <span style={{ fontSize: "0.625rem", color: isSorted ? COLORS.primary : COLORS.mutedForeground }}>
                        {isSorted ? (sort?.direction === "asc" ? "▲" : "▼") : "↕"}
                      </span>
                    )}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>

        {/* ─── Body ────────────────────────────────────────────── */}
        <tbody>
          {/* Loading State */}
          {loading &&
            Array.from({ length: loadingRowCount }).map((_, rowIndex) => (
              <tr key={`skeleton-${rowIndex}`}>
                {columns.map((col, colIndex) => (
                  <td
                    key={colIndex}
                    style={{
                      height: COMPONENT_SPEC.tableRow.height,
                      padding: "0 16px",
                      borderBottom: `1px solid ${COLORS.border}`,
                    }}
                  >
                    <div
                      className="skeleton"
                      style={{ height: "16px", width: "60%", maxWidth: "120px" }}
                    />
                  </td>
                ))}
              </tr>
            ))}

          {/* Error State */}
          {!loading && errorState && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  height: "120px",
                  textAlign: "center",
                  padding: "24px",
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                <div style={{ display: "inline-flex", flexDirection: "column", gap: "12px", alignItems: "center" }}>
                  <span style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
                    {errorState.message}
                  </span>
                  {errorState.onRetry && (
                    <Button variant="secondary" size="sm" onClick={errorState.onRetry}>
                      Retry
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          )}

          {/* Empty State */}
          {!loading && !errorState && data.length === 0 && emptyState && (
            <tr>
              <td
                colSpan={columns.length}
                style={{
                  height: "200px",
                  textAlign: "center",
                  padding: "32px",
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                <div style={{ display: "inline-flex", flexDirection: "column", gap: "8px", alignItems: "center" }}>
                  <span style={{ fontSize: "2rem" }}>{emptyState.icon}</span>
                  <span style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
                    {emptyState.title}
                  </span>
                  <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, maxWidth: "320px" }}>
                    {emptyState.message}
                  </span>
                  {emptyState.action && (
                    <Button variant="primary" size="sm" onClick={emptyState.action.onClick} style={{ marginTop: "8px" }}>
                      {emptyState.action.label}
                    </Button>
                  )}
                </div>
              </td>
            </tr>
          )}

          {/* Data Rows */}
          {!loading &&
            !errorState &&
            data.map((row, rowIndex) => (
              <tr
                key={rowKey(row, rowIndex)}
                onClick={() => onRowClick?.(row)}
                style={{
                  height: COMPONENT_SPEC.tableRow.height,
                  cursor: onRowClick ? "pointer" : "default",
                  transition: "background-color 100ms ease",
                }}
                onMouseEnter={(e) => {
                  if (onRowClick) e.currentTarget.style.backgroundColor = COLORS.cardHover;
                }}
                onMouseLeave={(e) => {
                  if (onRowClick) e.currentTarget.style.backgroundColor = "transparent";
                }}
              >
                {columns.map((col) => {
                  const value = (row as Record<string, unknown>)[col.key as string];
                  return (
                    <td
                      key={col.key as string}
                      style={{
                        padding: "0 16px",
                        fontSize: "0.875rem",
                        color: COLORS.foreground,
                        textAlign: col.align ?? "left",
                        borderBottom: `1px solid ${COLORS.border}`,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        maxWidth: col.width,
                      }}
                    >
                      {col.render ? col.render(value, row) : (value as React.ReactNode) ?? "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
        </tbody>
      </table>
    </div>
  );
}
