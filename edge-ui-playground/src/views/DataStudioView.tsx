import React, { useState, useCallback, useMemo } from "react";
import { Card, Button, Badge, Tabs, type TabItem } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";
import { ConfirmDialog } from "../components/ui/Modal";
import { DataGrid, type ColumnDef, type SortDir } from "../components/DataGrid";
import { FilterBar, type FilterOption } from "../components/FilterBar";
import { RowDrawer } from "../components/RowDrawer";
import { DeploymentSelector } from "../components/DeploymentSelector";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";
import {
  useLeads,
  useBulkAction,
  useExportCsv,
  useImportCsv,
  useUpdateLead,
  type DataFilters,
} from "../hooks/useDataApi";

// ─── Props ───────────────────────────────────────────────────────

export interface DataStudioViewProps {
  // no props needed for now
}

// ─── Constants ───────────────────────────────────────────────────

const ALL_COLUMNS: ColumnDef[] = [
  { key: "email", label: "Email", type: "email", minWidth: "200px" },
  { key: "name", label: "Name", type: "string", minWidth: "160px" },
  { key: "company", label: "Company", type: "string", minWidth: "140px" },
  { key: "stage", label: "Stage", type: "status", minWidth: "110px" },
  { key: "status", label: "Status", type: "status", minWidth: "100px" },
  { key: "country", label: "Country", type: "string", minWidth: "100px" },
  { key: "website", label: "Website", type: "url", minWidth: "140px" },
  { key: "website_status", label: "Web Status", type: "status", minWidth: "110px" },
  { key: "tier", label: "Tier", type: "string", minWidth: "80px" },
  { key: "source", label: "Source", type: "string", minWidth: "100px" },
  { key: "created_at", label: "Created", type: "date", minWidth: "110px" },
  { key: "updated_at", label: "Updated", type: "date", minWidth: "110px" },
  { key: "classification", label: "Classification", type: "json", minWidth: "120px" },
  { key: "website_evidence", label: "Evidence", type: "json", minWidth: "100px" },
  { key: "note", label: "Note", type: "string", minWidth: "160px" },
];

const FILTER_OPTIONS: FilterOption[] = [
  { key: "stage", label: "Stage", values: ["raw", "verified", "classified", "researched", "approved", "sent", "replied"] },
  { key: "country", label: "Country", values: ["US", "UK", "DE", "FR", "CA", "AU", "NL", "SE", "JP", "BR", "IN", "Other"] },
  { key: "tier", label: "Tier", values: ["A", "B", "C", "D"] },
  { key: "status", label: "Status", values: ["pending", "pending_review", "approved", "rejected", "active"] },
  { key: "website_status", label: "Web Status", values: ["reachable", "unreachable", "timeout", "pending"] },
];

const VIEW_TABS: TabItem[] = [
  { id: "table", label: "Table" },
  { id: "raw", label: "Raw CSV" },
];

// ─── Component ───────────────────────────────────────────────────

export const DataStudioView: React.FC<DataStudioViewProps> = () => {
  const { deploymentId } = useDeploymentSelector();
  const [filters, setFilters] = useState<DataFilters>({});
  const [page, setPage] = useState(1);
  const [pageSize] = useState(100);
  const [sortCol, setSortCol] = useState<string>("created_at");
  const [sortDir, setSortDir] = useState<SortDir>("desc");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [drawerKey, setDrawerKey] = useState<string | null>(null);
  const [visibleTab, setVisibleTab] = useState("table");
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>(
    () => Object.fromEntries(ALL_COLUMNS.map((c) => [c.key, true])),
  );
  const [showColumnToggle, setShowColumnToggle] = useState(false);
  const [confirmAction, setConfirmAction] = useState<{ action: string; count: number } | null>(null);
  const [importFile, setImportFile] = useState<File | null>(null);

  const { data, loading, error, refetch } = useLeads(filters, page, pageSize, deploymentId);
  const { execute: bulkExec, loading: bulkLoading } = useBulkAction(deploymentId);
  const { download, loading: exporting } = useExportCsv(deploymentId);
  const { dryRunImport, confirmImport, dryRun, loading: importing, error: importError, reset: resetImport } = useImportCsv(deploymentId);
  const { update: updateLead } = useUpdateLead(deploymentId);

  const columns = useMemo(
    () => ALL_COLUMNS.map((c) => ({ ...c, visible: columnVisibility[c.key] !== false })),
    [columnVisibility],
  );

  const sortedRows = useMemo(() => {
    const rows = [...data.rows];
    if (sortCol) {
      rows.sort((a, b) => {
        const va = a[sortCol] ?? "";
        const vb = b[sortCol] ?? "";
        const cmp = String(va).localeCompare(String(vb));
        return sortDir === "asc" ? cmp : -cmp;
      });
    }
    return rows;
  }, [data.rows, sortCol, sortDir]);

  const handleSort = useCallback(
    (col: string) => {
      if (sortCol === col) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortCol(col);
        setSortDir("asc");
      }
    },
    [sortCol],
  );

  const handleRowClick = useCallback((row: Record<string, unknown>) => {
    setDrawerKey(String(row.email ?? row.id ?? row.key));
  }, []);

  const handleDrawerAction = useCallback(
    async (key: string, action: string) => {
      const patchMap: Record<string, Record<string, unknown>> = {
        approve: { status: "approved", stage: "approved" },
        reject: { status: "rejected" },
        erase: { status: "erased", _delete: true },
        "research-now": { status: "pending_review", _research: true },
      };
      const patch = patchMap[action];
      if (patch) {
        await updateLead(key, patch);
        refetch();
      }
      setDrawerKey(null);
    },
    [updateLead, refetch],
  );

  const handleBulkAction = useCallback(
    async (action: string) => {
      const keys = Array.from(selectedKeys);
      if (keys.length === 0) return;

      const patchMap: Record<string, Record<string, unknown>> = {
        approve: { status: "approved", stage: "approved" },
        reject: { status: "rejected" },
        delete: { _delete: true },
      };
      const patch = patchMap[action];
      if (patch) {
        await bulkExec(keys, patch);
        setSelectedKeys(new Set());
        refetch();
      }
      setConfirmAction(null);
    },
    [selectedKeys, bulkExec, refetch],
  );

  const handleExport = useCallback(() => {
    download(filters);
  }, [download, filters]);

  const handleImportUpload = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) {
        setImportFile(file);
        dryRunImport(file);
      }
    },
    [dryRunImport],
  );

  const handleImportConfirm = useCallback(async () => {
    if (!importFile) return;
    const success = await confirmImport(importFile);
    if (success) {
      setImportFile(null);
      resetImport();
      refetch();
    }
  }, [importFile, confirmImport, resetImport, refetch]);

  const totalPages = Math.ceil(data.total / pageSize);

  if (!deploymentId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>Data Studio</h1>
            <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>First-class data surface for your agent pipeline</p>
          </div>
          <DeploymentSelector />
        </div>
        <EmptyState icon="📊" title="No deployment selected" message="Select a deployment above to view and manage its data." />
      </div>
    );
  }

  // ─── Raw CSV Tab ───────────────────────────────────────────────

  const rawCsvContent = useMemo(() => {
    if (data.rows.length === 0) return "";
    const headers = ALL_COLUMNS.filter((c) => columnVisibility[c.key] !== false).map((c) => c.key);
    const lines = [headers.join(",")];
    for (const row of data.rows) {
      const line = headers.map((h) => {
        const val = row[h];
        if (val === null || val === undefined) return "";
        const str = typeof val === "object" ? JSON.stringify(val) : String(val);
        return str.includes(",") || str.includes('"') || str.includes("\n") ? `"${str.replace(/"/g, '""')}"` : str;
      });
      lines.push(line.join(","));
    }
    return lines.join("\n");
  }, [data.rows, columnVisibility]);

  // ─── Render ────────────────────────────────────────────────────

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", height: "100%" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
            Data Studio
          </h1>
          <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
            First-class data surface for your agent pipeline
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <DeploymentSelector />
          <Button variant="outline" size="sm" onClick={handleExport} loading={exporting}>
            Export CSV
          </Button>
          <label style={{ display: "inline-block" }}>
            <Button variant="outline" size="sm" onClick={() => document.getElementById("csv-upload")?.click()} loading={importing}>
              Import CSV
            </Button>
            <input id="csv-upload" type="file" accept=".csv" hidden onChange={handleImportUpload} />
          </label>
          <Button variant="outline" size="sm" onClick={refetch}>
            Refresh
          </Button>
        </div>
      </div>

      {/* View Tabs */}
      <Tabs tabs={VIEW_TABS} activeTab={visibleTab} onChange={setVisibleTab} />

      {visibleTab === "table" && (
        <>
          {/* Filters */}
          <FilterBar
            filters={filters}
            onChange={(f) => { setFilters(f); setPage(1); }}
            filterOptions={FILTER_OPTIONS}
            totalResults={data.total}
          />

          {/* Column visibility toggle */}
          <div style={{ display: "flex", justifyContent: "flex-end", position: "relative" }}>
            <Button variant="ghost" size="sm" onClick={() => setShowColumnToggle(!showColumnToggle)} style={{ fontSize: "0.8125rem" }}>
              Columns
            </Button>
            {showColumnToggle && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  width: "220px",
                  maxHeight: "320px",
                  overflowY: "auto",
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.md,
                  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.08)",
                  zIndex: 100,
                  padding: "8px",
                }}
              >
                {ALL_COLUMNS.map((col) => (
                  <label
                    key={col.key}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "8px",
                      padding: "6px 8px",
                      borderRadius: "4px",
                      cursor: "pointer",
                      fontSize: "0.8125rem",
                      color: COLORS.foreground,
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={columnVisibility[col.key] !== false}
                      onChange={() =>
                        setColumnVisibility((prev) => ({ ...prev, [col.key]: !prev[col.key] }))
                      }
                      style={{ accentColor: COLORS.primary }}
                    />
                    {col.label}
                  </label>
                ))}
              </div>
            )}
          </div>

          {/* Bulk action bar */}
          {selectedKeys.size > 0 && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "12px",
                padding: "10px 16px",
                borderRadius: RADIUS.md,
                backgroundColor: "var(--color-info-bg)",
                border: `1px solid ${STATUS_COLORS.infoBorder}`,
              }}
            >
              <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: COLORS.foreground }}>
                {selectedKeys.size} selected
              </span>
              <Button variant="primary" size="sm" onClick={() => setConfirmAction({ action: "approve", count: selectedKeys.size })}>
                Approve
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirmAction({ action: "reject", count: selectedKeys.size })}>
                Reject
              </Button>
              <Button variant="destructive" size="sm" onClick={() => setConfirmAction({ action: "delete", count: selectedKeys.size })}>
                Delete
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setSelectedKeys(new Set())}>
                Clear
              </Button>
              {bulkLoading && <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>Processing...</span>}
            </div>
          )}

          {/* Data Grid */}
          {loading ? (
            <LoadingState variant="spinner" message="Loading data..." height="300px" />
          ) : error ? (
            <Card>
              <div style={{ padding: "32px", textAlign: "center" }}>
                <p style={{ color: STATUS_COLORS.error, fontSize: "0.875rem", marginBottom: "12px" }}>{error}</p>
                <Button variant="outline" size="sm" onClick={refetch}>
                  Try Again
                </Button>
              </div>
            </Card>
          ) : data.rows.length === 0 ? (
            <EmptyState
              icon="📊"
              title="No data yet"
              message="Your agent hasn't collected any leads yet. Run a pipeline to start collecting data."
            />
          ) : (
            <>
              <div data-tour="data-studio">
                <DataGrid
                  columns={columns}
                  rows={sortedRows}
                  rowKey="email"
                  selectedKeys={selectedKeys}
                  onSelectionChange={setSelectedKeys}
                  onRowClick={handleRowClick}
                  sortColumn={sortCol}
                  sortDir={sortDir}
                  onSort={handleSort}
                />
              </div>

              {/* Pagination */}
              {totalPages > 1 && (
                <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "8px" }}>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page <= 1}
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                  >
                    Previous
                  </Button>
                  <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
                    Page {page} of {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={page >= totalPages}
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  >
                    Next
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* Raw CSV Tab */}
      {visibleTab === "raw" && (
        <Card>
          <pre
            style={{
              fontSize: "0.75rem",
              fontFamily: "var(--font-mono)",
              color: COLORS.foreground,
              backgroundColor: COLORS.secondary,
              padding: "16px",
              borderRadius: RADIUS.md,
              overflow: "auto",
              maxHeight: "calc(100vh - 340px)",
              margin: 0,
              whiteSpace: "pre",
              lineHeight: 1.6,
            }}
          >
            {loading ? "Loading..." : rawCsvContent || "No data"}
          </pre>
        </Card>
      )}

      {/* Row Drawer */}
      <RowDrawer
        rowKey={drawerKey}
        onClose={() => setDrawerKey(null)}
        onAction={handleDrawerAction}
      />

      {/* Bulk Confirm Dialog */}
      <ConfirmDialog
        open={confirmAction !== null}
        onClose={() => setConfirmAction(null)}
        onConfirm={() => confirmAction && handleBulkAction(confirmAction.action)}
        title={`Confirm ${confirmAction?.action ?? ""}`}
        message={`Are you sure you want to ${confirmAction?.action ?? ""} ${confirmAction?.count ?? 0} lead(s)?`}
        confirmLabel={confirmAction?.action === "delete" ? "Delete" : "Confirm"}
        destructive={confirmAction?.action === "delete"}
      />

      {/* Import Dry-Run Modal */}
      {importFile && dryRun && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: "rgba(0,0,0,0.5)",
            backdropFilter: "blur(2px)",
            zIndex: 1000,
            padding: "16px",
          }}
        >
          <div
            style={{
              width: "100%",
              maxWidth: "560px",
              backgroundColor: COLORS.card,
              borderRadius: RADIUS.lg,
              border: `1px solid ${COLORS.border}`,
              boxShadow: "0 20px 45px -5px rgba(0,0,0,0.2)",
              overflow: "hidden",
            }}
          >
            <div style={{ padding: "20px 24px", borderBottom: `1px solid ${COLORS.border}` }}>
              <h2 style={{ fontSize: "1.125rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
                Import Preview
              </h2>
              <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
                Review the dry-run results before confirming
              </p>
            </div>
            <div style={{ padding: "20px 24px" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "12px", marginBottom: "16px" }}>
                <div style={{ textAlign: "center", padding: "12px", backgroundColor: COLORS.secondary, borderRadius: RADIUS.md }}>
                  <div style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground }}>{dryRun.totalRows}</div>
                  <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>Total Rows</div>
                </div>
                <div style={{ textAlign: "center", padding: "12px", backgroundColor: STATUS_COLORS.successBg, borderRadius: RADIUS.md }}>
                  <div style={{ fontSize: "1.25rem", fontWeight: 700, color: STATUS_COLORS.success }}>{dryRun.newRows}</div>
                  <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>New</div>
                </div>
                <div style={{ textAlign: "center", padding: "12px", backgroundColor: STATUS_COLORS.warningBg, borderRadius: RADIUS.md }}>
                  <div style={{ fontSize: "1.25rem", fontWeight: 700, color: STATUS_COLORS.warning }}>{dryRun.updatedRows}</div>
                  <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>Updated</div>
                </div>
              </div>
              {dryRun.errors.length > 0 && (
                <div style={{ marginBottom: "12px" }}>
                  <div style={{ fontSize: "0.8125rem", fontWeight: 500, color: STATUS_COLORS.error, marginBottom: "6px" }}>
                    Errors ({dryRun.errors.length})
                  </div>
                  <div style={{ maxHeight: "120px", overflowY: "auto" }}>
                    {dryRun.errors.map((err, i) => (
                      <div key={i} style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, padding: "4px 0" }}>
                        {err}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {importError && (
                <p style={{ fontSize: "0.8125rem", color: STATUS_COLORS.error }}>{importError}</p>
              )}
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", padding: "16px 24px", borderTop: `1px solid ${COLORS.border}` }}>
              <Button variant="outline" size="sm" onClick={() => { setImportFile(null); resetImport(); }}>
                Cancel
              </Button>
              <Button variant="primary" size="sm" onClick={handleImportConfirm} loading={importing}>
                Confirm Import
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
