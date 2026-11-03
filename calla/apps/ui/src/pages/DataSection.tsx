/**
 * DataSection — Screen D (/data)
 * ──────────────────────────────
 * The leads workspace: one broad engine fetch, then ALL search / faceting /
 * sorting / pagination happens CLIENT-SIDE. This is deliberate — bi-edge's
 * GET /cmd/data only supports single-value exact filters (stage, country,
 * tier, status) and silently ignores `search` / `website_status`, so any
 * server-side filtering here would lie to the operator.
 *
 * Bulk approval of outreach lives here (not in the Approval Inbox, which is
 * reserved for automation gates + low-volume per-item decisions):
 *   select rows → Approve for outreach / Reject → POST /cmd/data/batch
 * Row click opens the detail drawer with single-lead approve/reject.
 */

import * as React from "react";
import { Check, Database, Download, RefreshCw, Trash2, Upload, X } from "lucide-react";
import {
  DataGrid,
  DetailPanel,
  FilterBar,
  STATUS_BADGE_VARIANT,
  type ColumnDef,
  type DetailSection,
  type FilterOption,
  type SortDir,
} from "@/components/data";
import { EmptyState } from "@/components/shared";
import { Badge, Button, Card, Dialog, Skeleton } from "@/components/ui";
import {
  toast,
  useBulkAction,
  useDeleteRows,
  useDeploymentSelector,
  useExportCsv,
  useImportCsv,
  useLeads,
  useUpdateLead,
  type DataFilters,
  type ImportDryRun,
} from "@/hooks";
import { cn, relativeTime } from "@/lib/utils";

// ─── Constants ───────────────────────────────────────────────────

/** Engine pageSize cap — one broad fetch, everything else is local. */
const FETCH_PAGE_SIZE = 500;
const LOCAL_PAGE_SIZE = 25;
/** Bulk approve above this many rows asks for confirmation first. */
const BULK_CONFIRM_THRESHOLD = 20;
/** Import dialog: how many rejected rows / preview rows to render. */
const MAX_IMPORT_ERRORS = 5;
const MAX_IMPORT_PREVIEW_ROWS = 5;
const MAX_IMPORT_PREVIEW_COLS = 6;
/** Import preview shows the identity columns first when the file has them. */
const IMPORT_PREVIEW_COLUMNS = [
  "key",
  "name",
  "country",
  "city",
  "website",
  "stage",
  "status",
  "email",
];

const COLUMNS: ColumnDef[] = [
  { key: "name", label: "Company", type: "string" },
  { key: "country", label: "Country", type: "string", width: "80px" },
  { key: "city", label: "City", type: "string" },
  { key: "stage", label: "Stage", type: "status", width: "110px" },
  { key: "status", label: "Status", type: "status", width: "110px" },
  { key: "tier", label: "Tier", type: "string", width: "72px" },
  { key: "email", label: "Email", type: "email" },
  { key: "website", label: "Website", type: "url" },
  { key: "updated_at", label: "Updated", type: "date", width: "96px" },
];

// ─── Row parsing helpers ─────────────────────────────────────────

type Row = Record<string, unknown>;

function parseJson<T>(value: unknown): T | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "object") return value as T;
  if (typeof value !== "string") return null;
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

interface Classification {
  tier?: string;
  fit?: number;
  headcount?: number;
}

interface EmailEntry {
  addr?: string;
  mx_ok?: boolean;
}

function classificationOf(row: Row): Classification {
  return parseJson<Classification>(row.classification) ?? {};
}

function emailsOf(row: Row): EmailEntry[] {
  const parsed = parseJson<EmailEntry[] | string[]>(row.emails);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map((e) => (typeof e === "string" ? { addr: e } : e))
    .filter((e): e is EmailEntry => !!e && typeof e === "object");
}

function firstEmail(row: Row): string {
  return emailsOf(row).map((e) => e.addr ?? "").find((a) => a.length > 0) ?? "";
}

function phonesOf(row: Row): string[] {
  const parsed = parseJson<unknown>(row.phones);
  if (Array.isArray(parsed)) return parsed.map((p) => String(p)).filter(Boolean);
  if (typeof row.phones === "string" && row.phones.trim()) return [row.phones.trim()];
  return [];
}

/** Row + derived display fields the grid columns read (tier, email). */
interface ViewRow extends Row {
  key: string;
  tier: string;
  email: string;
}

function toViewRow(row: Row): ViewRow {
  return {
    ...row,
    key: String(row.key ?? row.id ?? ""),
    tier: classificationOf(row).tier ?? "",
    email: firstEmail(row),
  };
}

function statusBadge(value: unknown): React.ReactNode {
  const raw = String(value ?? "");
  if (!raw) return "-";
  const variant = STATUS_BADGE_VARIANT[raw.toLowerCase()] ?? "muted";
  return <Badge variant={variant}>{raw}</Badge>;
}

function prettyJson(value: unknown): string | null {
  const parsed = parseJson<unknown>(value);
  if (parsed === null) return typeof value === "string" && value.trim() ? value : null;
  return JSON.stringify(parsed, null, 2);
}

function MonoBlock({ children }: { children: React.ReactNode }) {
  return (
    <pre className="scrollbar-thin max-h-52 overflow-auto rounded-md bg-surface-canvas p-2.5 font-mono text-xs text-body">
      {children}
    </pre>
  );
}

// ─── CSV import preview ──────────────────────────────────────────

export interface ImportPreview {
  totalRows: number;
  newRows: number;
  updatedRows: number;
  /** False when the engine didn't split new vs updated — don't invent a split. */
  split: boolean;
  errors: string[];
  preview: Row[];
  columns: string[];
}

function previewCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function previewColumns(rows: Row[]): string[] {
  const keys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) keys.add(key);
  }
  const preferred = IMPORT_PREVIEW_COLUMNS.filter((k) => keys.has(k));
  const rest = Array.from(keys)
    .filter((k) => !preferred.includes(k))
    .sort();
  return [...preferred, ...rest].slice(0, MAX_IMPORT_PREVIEW_COLS);
}

/**
 * Normalize the engine's dry-run payload. The documented shape is
 * {totalRows,newRows,updatedRows,errors[],preview[]}; bi-edge currently
 * answers {dryRun,imported,preview,total_rows,errors}. Read both so the
 * dialog never shows invented numbers — anything missing stays 0 and the
 * missing split is called out instead of guessed.
 */
export function normalizeImportPreview(raw: ImportDryRun | null): ImportPreview | null {
  if (!raw) return null;
  const rec = raw as unknown as Record<string, unknown>;

  const num = (...values: unknown[]): number => {
    for (const value of values) {
      if (typeof value === "number" && Number.isFinite(value)) return value;
    }
    return 0;
  };

  const errors = Array.isArray(rec.errors)
    ? rec.errors.map((e) => previewCell(e)).filter((e) => e.length > 0)
    : [];
  const preview = (Array.isArray(rec.preview) ? rec.preview : [])
    .map((r) => (r && typeof r === "object" ? (r as Row) : {}))
    .slice(0, MAX_IMPORT_PREVIEW_ROWS);

  const newRows = num(rec.newRows, rec.new_rows);
  const updatedRows = num(rec.updatedRows, rec.updated_rows);
  const totalRows =
    num(rec.totalRows, rec.total_rows) || newRows + updatedRows || preview.length;

  return {
    totalRows,
    newRows,
    updatedRows,
    split: newRows + updatedRows > 0,
    errors,
    preview,
    columns: previewColumns(preview),
  };
}

const ImportStat: React.FC<{ label: string; value: number; muted?: boolean }> = ({
  label,
  value,
  muted,
}) => (
  <div className="rounded-md border border-border bg-surface-canvas px-3 py-2">
    <div
      className={cn(
        "text-lg font-semibold leading-tight tabular-nums",
        muted ? "text-faint" : "text-foreground",
      )}
    >
      {value.toLocaleString()}
    </div>
    <div className="truncate text-[0.625rem] uppercase tracking-[0.05em] text-faint">{label}</div>
  </div>
);

// ─── Screen ──────────────────────────────────────────────────────

export interface DataSectionProps {
  onNavigate?: (path: string) => void;
}

export const DataSection: React.FC<DataSectionProps> = () => {
  const { deploymentId } = useDeploymentSelector();

  // ONE broad fetch — filtering/search/sort/pagination are all client-side
  // (the engine only supports single-value exact filters; see file header).
  const fetchFilters = React.useMemo<DataFilters>(() => ({}), []);
  const { data, loading, error, refetch } = useLeads(fetchFilters, 1, FETCH_PAGE_SIZE, deploymentId);

  const { execute: executeBulk, loading: bulkLoading, error: bulkError } = useBulkAction(deploymentId);
  const { update: updateRow, loading: singleLoading } = useUpdateLead(deploymentId);
  const { execute: deleteRows, loading: deleteLoading } = useDeleteRows(deploymentId);
  const [deleteConfirmKeys, setDeleteConfirmKeys] = React.useState<string[] | null>(null);
  const { download: downloadCsv, loading: exportLoading } = useExportCsv(deploymentId);
  const { dryRunImport, confirmImport, reset: resetImport, loading: importLoading } =
    useImportCsv(deploymentId);

  const [filters, setFilters] = React.useState<DataFilters>({});
  const [filterBarKey, setFilterBarKey] = React.useState(0);
  const [sortColumn, setSortColumn] = React.useState<string | undefined>(undefined);
  const [sortDir, setSortDir] = React.useState<SortDir>("asc");
  const [page, setPage] = React.useState(1);
  const [selectedKeys, setSelectedKeys] = React.useState<Set<string>>(() => new Set());
  const [activeKey, setActiveKey] = React.useState<string | null>(null);
  const [confirmOpen, setConfirmOpen] = React.useState(false);

  // CSV import: file → dry-run preview → confirm (nothing is written before
  // the operator sees the counts).
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const [importFile, setImportFile] = React.useState<File | null>(null);
  const [importPreview, setImportPreview] = React.useState<ImportPreview | null>(null);
  const [importOpen, setImportOpen] = React.useState(false);

  const rows = React.useMemo(() => data.rows.map(toViewRow), [data.rows]);

  // ─── Client-side filter ────────────────────────────────────────

  const filtered = React.useMemo(() => {
    const q = (filters.search ?? "").trim().toLowerCase();
    const facets: Array<[keyof DataFilters, (r: ViewRow) => string]> = [
      ["stage", (r) => String(r.stage ?? "")],
      ["status", (r) => String(r.status ?? "")],
      ["country", (r) => String(r.country ?? "")],
      ["tier", (r) => r.tier],
    ];

    return rows.filter((row) => {
      if (q) {
        const haystack = [row.name, row.emails, row.website, row.city, row.email]
          .map((v) => (typeof v === "string" ? v : ""))
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      for (const [facet, get] of facets) {
        const selected = filters[facet];
        if (Array.isArray(selected) && selected.length > 0 && !selected.includes(get(row))) {
          return false;
        }
      }
      return true;
    });
  }, [rows, filters]);

  // ─── Client-side sort ──────────────────────────────────────────

  const sorted = React.useMemo(() => {
    if (!sortColumn) return filtered;
    const dir = sortDir === "asc" ? 1 : -1;
    const isDate = sortColumn === "updated_at" || sortColumn === "created_at";
    return [...filtered].sort((a, b) => {
      const av = a[sortColumn];
      const bv = b[sortColumn];
      if (av == null && bv == null) return 0;
      if (av == null) return -1 * dir;
      if (bv == null) return 1 * dir;
      if (isDate) {
        const at = Date.parse(String(av));
        const bt = Date.parse(String(bv));
        if (!isNaN(at) && !isNaN(bt)) return (at - bt) * dir;
      }
      if (typeof av === "number" && typeof bv === "number") return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [filtered, sortColumn, sortDir]);

  // ─── Client-side pagination ────────────────────────────────────

  const totalPages = Math.max(1, Math.ceil(sorted.length / LOCAL_PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageRows = React.useMemo(
    () => sorted.slice((currentPage - 1) * LOCAL_PAGE_SIZE, currentPage * LOCAL_PAGE_SIZE),
    [sorted, currentPage],
  );
  const rangeStart = sorted.length === 0 ? 0 : (currentPage - 1) * LOCAL_PAGE_SIZE + 1;
  const rangeEnd = Math.min(currentPage * LOCAL_PAGE_SIZE, sorted.length);

  // Any filter/sort change rewinds to page 1.
  React.useEffect(() => {
    setPage(1);
  }, [filters, sortColumn, sortDir]);

  // ─── Facet options (distinct values across ALL rows) ──────────

  const filterOptions = React.useMemo<FilterOption[]>(() => {
    const distinct = (get: (r: ViewRow) => string): string[] =>
      Array.from(new Set(rows.map(get).filter((v) => v.length > 0))).sort();
    return [
      { key: "stage", label: "Stage", values: distinct((r) => String(r.stage ?? "")) },
      { key: "status", label: "Status", values: distinct((r) => String(r.status ?? "")) },
      { key: "country", label: "Country", values: distinct((r) => String(r.country ?? "")) },
      { key: "tier", label: "Tier", values: distinct((r) => r.tier) },
    ];
  }, [rows]);

  // ─── Sorting handler ───────────────────────────────────────────

  const handleSort = React.useCallback(
    (column: string) => {
      if (sortColumn === column) {
        setSortDir((d) => (d === "asc" ? "desc" : "asc"));
      } else {
        setSortColumn(column);
        setSortDir("asc");
      }
    },
    [sortColumn],
  );

  // ─── Row drawer ────────────────────────────────────────────────

  const activeRow = React.useMemo(
    () => (activeKey ? rows.find((r) => r.key === activeKey) ?? null : null),
    [activeKey, rows],
  );

  const closeDrawer = React.useCallback(() => setActiveKey(null), []);

  // ─── Actions ───────────────────────────────────────────────────

  const runBulk = React.useCallback(
    async (status: "approved" | "rejected") => {
      const keys = Array.from(selectedKeys);
      if (keys.length === 0) return;
      const updated = await executeBulk(keys, { status });
      if (updated === null) {
        toast.error("Bulk update failed", bulkError ?? "The engine rejected the batch.");
        return;
      }
      if (status === "approved") {
        toast.success(`Approved ${updated} leads for outreach`);
      } else {
        toast.info(`Rejected ${updated} leads`);
      }
      setSelectedKeys(new Set());
      setConfirmOpen(false);
      refetch();
    },
    [selectedKeys, executeBulk, bulkError, refetch],
  );

  const handleBulkApprove = React.useCallback(() => {
    if (selectedKeys.size > BULK_CONFIRM_THRESHOLD) {
      setConfirmOpen(true);
      return;
    }
    void runBulk("approved");
  }, [selectedKeys.size, runBulk]);

  const handleSingle = React.useCallback(
    async (status: "approved" | "rejected") => {
      if (!activeKey) return;
      const ok = await updateRow(activeKey, { status });
      if (!ok) {
        toast.error("Update failed", "The lead row could not be patched.");
        return;
      }
      if (status === "approved") {
        toast.success("Lead approved for outreach");
      } else {
        toast.info("Lead rejected");
      }
      refetch();
    },
    [activeKey, updateRow, refetch],
  );

  const runDelete = React.useCallback(
    async (keys: string[]) => {
      const n = await deleteRows(keys);
      setDeleteConfirmKeys(null);
      if (n > 0) {
        toast.success(`Deleted ${n} lead${n === 1 ? "" : "s"}`, "Removed permanently from the engine.");
        setSelectedKeys(new Set());
        setActiveKey(null);
        refetch();
      }
    },
    [deleteRows, refetch],
  );

  const clearFilters = React.useCallback(() => {
    setFilters({});
    // FilterBar keeps its own search-box state — remount it so the input clears too.
    setFilterBarKey((k) => k + 1);
  }, []);

  // ─── CSV export / import ───────────────────────────────────────

  /**
   * Export the whole lead table for this deployment. Client-side facets are
   * NOT forwarded — the engine only understands single-value exact filters,
   * so a multi-select facet would silently export an empty (lying) file.
   */
  const handleExport = React.useCallback(() => {
    if (!deploymentId) return;
    const filename = `leads-${deploymentId}-${new Date().toISOString().slice(0, 10)}.csv`;
    void downloadCsv(fetchFilters, filename);
  }, [deploymentId, downloadCsv, fetchFilters]);

  const closeImport = React.useCallback(() => {
    setImportOpen(false);
    setImportFile(null);
    setImportPreview(null);
    resetImport();
    if (fileInputRef.current) fileInputRef.current.value = "";
  }, [resetImport]);

  const handleFilePicked = React.useCallback(
    async (event: React.ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      if (!file) return;
      if (!/\.csv$/i.test(file.name) && file.type !== "text/csv") {
        toast.error("Not a CSV file", `“${file.name}” isn't a .csv export.`);
        event.target.value = "";
        return;
      }

      setImportFile(file);
      setImportPreview(null);
      setImportOpen(true);

      // Dry run FIRST — the operator confirms against real counts.
      const result = await dryRunImport(file);
      if (!result) {
        toast.error(
          "Import preview failed",
          "The engine rejected the file — it needs key, name and country columns.",
        );
        closeImport();
        return;
      }
      setImportPreview(normalizeImportPreview(result));
    },
    [dryRunImport, closeImport],
  );

  const handleConfirmImport = React.useCallback(async () => {
    if (!importFile) return;
    const ok = await confirmImport(importFile);
    if (!ok) {
      toast.error(
        "Import failed",
        "The engine rejected the file — it needs key, name and country columns.",
      );
      return;
    }
    const changed = (importPreview?.newRows ?? 0) + (importPreview?.updatedRows ?? 0);
    const count = changed > 0 ? changed : (importPreview?.totalRows ?? 0);
    toast.success(`Imported ${count} leads`);
    closeImport();
    refetch();
  }, [importFile, confirmImport, importPreview, closeImport, refetch]);

  const hasActiveFilters =
    !!filters.search ||
    ["stage", "status", "country", "tier"].some((k) => {
      const v = (filters as Record<string, unknown>)[k];
      return Array.isArray(v) && v.length > 0;
    });

  // ─── Drawer sections ───────────────────────────────────────────

  const drawerSections = React.useMemo<DetailSection[]>(() => {
    if (!activeRow) return [];
    const cls = classificationOf(activeRow);
    const emails = emailsOf(activeRow);
    const phones = phonesOf(activeRow);
    const updated = String(activeRow.updated_at ?? "");
    const research = prettyJson(activeRow.research);

    return [
      {
        title: "Overview",
        fields: [
          { label: "Stage", value: statusBadge(activeRow.stage) },
          { label: "Status", value: statusBadge(activeRow.status) },
          {
            label: "Tier",
            value: cls.tier ? (
              <Badge variant={cls.tier.toUpperCase() === "HOT" ? "success" : cls.tier.toUpperCase() === "WARM" ? "warning" : "muted"}>
                {cls.tier}
              </Badge>
            ) : (
              "-"
            ),
          },
          { label: "Fit", value: typeof cls.fit === "number" ? cls.fit.toFixed(2) : "-" },
          { label: "Headcount", value: cls.headcount ?? "-" },
          { label: "City", value: String(activeRow.city ?? "") || "-" },
          { label: "Country", value: String(activeRow.country ?? "") || "-" },
          {
            label: "Website",
            value: activeRow.website ? (
              <a
                href={String(activeRow.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:underline"
              >
                {String(activeRow.website)}
              </a>
            ) : (
              "-"
            ),
          },
          {
            label: "Updated",
            value: updated ? `${relativeTime(updated)} · ${updated}` : "-",
          },
        ],
      },
      {
        title: "Contact",
        content: (
          <div className="flex flex-col gap-2">
            {emails.length === 0 && phones.length === 0 && (
              <span className="text-sm text-muted-foreground">No contact details captured.</span>
            )}
            {emails.map((e, i) => (
              <div key={`${e.addr ?? i}`} className="flex items-center gap-2">
                {e.addr ? (
                  <a
                    href={`mailto:${e.addr}`}
                    className="truncate text-sm text-primary hover:underline"
                  >
                    {e.addr}
                  </a>
                ) : (
                  <span className="text-sm text-muted-foreground">-</span>
                )}
                <Badge variant={e.mx_ok ? "success" : "muted"}>
                  mx {e.mx_ok ? "ok" : "fail"}
                </Badge>
              </div>
            ))}
            {phones.map((p, i) => (
              <div key={`${p}-${i}`} className="font-mono text-sm text-body">
                {p}
              </div>
            ))}
          </div>
        ),
      },
      {
        title: "Pitch",
        content:
          activeRow.pitch_subject || activeRow.pitch_body ? (
            <div className="rounded-md border border-border bg-surface-canvas p-3">
              {activeRow.pitch_subject ? (
                <div className="text-sm font-semibold text-foreground">
                  {String(activeRow.pitch_subject)}
                </div>
              ) : null}
              {activeRow.pitch_body ? (
                <div className="mt-2 whitespace-pre-wrap text-[0.8125rem] leading-relaxed text-body">
                  {String(activeRow.pitch_body)}
                </div>
              ) : null}
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">No pitch drafted yet.</span>
          ),
      },
      ...(research
        ? [{ title: "Research", content: <MonoBlock>{research}</MonoBlock> } as DetailSection]
        : []),
      ...(activeRow.classification
        ? [
            {
              title: "Classification (raw)",
              content: <MonoBlock>{String(activeRow.classification)}</MonoBlock>,
            } as DetailSection,
          ]
        : []),
    ];
  }, [activeRow]);

  // ─── Render ────────────────────────────────────────────────────

  const selectionCount = selectedKeys.size;

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight text-foreground">Data</h1>
          <p className="text-[0.8125rem] text-muted-foreground">
            Scraped leads — review in bulk, approve outreach
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" className="font-mono">
            {deploymentId ?? "no deployment"}
          </Badge>
          <span className="whitespace-nowrap text-xs text-muted-foreground">
            {data.total.toLocaleString()} leads
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={handleExport}
            disabled={exportLoading || !deploymentId}
            title="Download every lead row for this deployment as CSV"
          >
            <Download className="size-3.5" />
            {exportLoading ? "Exporting…" : "Export CSV"}
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={importLoading || !deploymentId}
            title="Import leads from a CSV file (dry-run preview first)"
          >
            <Upload className="size-3.5" />
            {importLoading ? "Working…" : "Import CSV"}
          </Button>
          <input
            ref={fileInputRef}
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            onChange={(e) => void handleFilePicked(e)}
          />
          <Button variant="outline" size="sm" onClick={refetch} disabled={loading}>
            <RefreshCw className={cn("size-3.5", loading && "animate-spin")} />
            Refresh
          </Button>
        </div>
      </header>

      {/* ─── Error banner ───────────────────────────────────── */}
      {error && (
        <div className="flex flex-wrap items-center gap-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-[0.8125rem] text-destructive">
          <span className="min-w-0 flex-1">{error}</span>
          <Button variant="outline" size="sm" onClick={refetch}>
            <RefreshCw className="size-3.5" />
            Retry
          </Button>
        </div>
      )}

      {loading && rows.length === 0 ? (
        <Card className="space-y-2 p-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full" />
          ))}
        </Card>
      ) : rows.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Database className="size-7 text-muted-foreground" />}
            title="No leads yet — the engine's crawler seeds this table"
            message={
              deploymentId
                ? "Once discovery runs against this deployment, scraped companies land here for bulk outreach approval."
                : "Select a deployment to load its data plane."
            }
          />
        </Card>
      ) : (
        <>
          {/* ─── Filters ──────────────────────────────────────── */}
          <FilterBar
            key={filterBarKey}
            filters={filters}
            onChange={setFilters}
            filterOptions={filterOptions}
            totalResults={filtered.length}
            searchPlaceholder="Search name, email, website, city…"
          />

          {/* ─── Bulk action bar ──────────────────────────────── */}
          {selectionCount > 0 && (
            <div className="sticky top-14 z-20 flex flex-wrap items-center gap-2 rounded-md border border-border bg-surface-panel px-3 py-2 shadow-elevated">
              <span className="text-sm font-semibold text-foreground">
                {selectionCount} selected
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-2">
                <Button
                  variant="success"
                  size="sm"
                  onClick={handleBulkApprove}
                  disabled={bulkLoading}
                >
                  <Check className="size-3.5" />
                  {bulkLoading ? "Working…" : "Approve for outreach"}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                  onClick={() => void runBulk("rejected")}
                  disabled={bulkLoading}
                >
                  <X className="size-3.5" />
                  Reject
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setDeleteConfirmKeys(Array.from(selectedKeys))}
                  disabled={bulkLoading || deleteLoading}
                >
                  <Trash2 className="size-3.5" />
                  Delete
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedKeys(new Set())}
                  disabled={bulkLoading}
                >
                  Clear selection
                </Button>
              </div>
            </div>
          )}

          {/* ─── Grid ─────────────────────────────────────────── */}
          {filtered.length === 0 ? (
            <Card>
              <EmptyState
                icon={<Database className="size-7 text-muted-foreground" />}
                title="No leads match filters"
                message="Loosen the facets or clear the search to see the rest of the table."
                action={{ label: "Clear filters", onClick: clearFilters }}
                actionVariant="outline"
              />
            </Card>
          ) : (
            <>
              <DataGrid
                columns={COLUMNS}
                rows={pageRows}
                rowKey="key"
                selectedKeys={selectedKeys}
                onSelectionChange={setSelectedKeys}
                onRowClick={(row) => setActiveKey(String(row.key))}
                sortColumn={sortColumn}
                sortDir={sortDir}
                onSort={handleSort}
                highlightRow={activeKey}
              />

              {/* ─── Pagination ───────────────────────────────── */}
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {rangeStart.toLocaleString()}–{rangeEnd.toLocaleString()} of{" "}
                  {sorted.length.toLocaleString()}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.max(1, p - 1))}
                    disabled={currentPage <= 1}
                  >
                    Prev
                  </Button>
                  <span className="text-xs tabular-nums text-muted-foreground">
                    {currentPage} / {totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                    disabled={currentPage >= totalPages}
                  >
                    Next
                  </Button>
                </div>
              </div>
            </>
          )}
        </>
      )}

      {/* ─── Row drawer ───────────────────────────────────────── */}
      <DetailPanel
        open={!!activeRow}
        title={
          activeRow ? (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate">{String(activeRow.name ?? activeRow.key)}</span>
              {activeRow.country ? (
                <Badge variant="muted" className="shrink-0">
                  {String(activeRow.country)}
                </Badge>
              ) : null}
            </span>
          ) : (
            ""
          )
        }
        subtitle={activeRow ? activeRow.key : undefined}
        sections={drawerSections}
        onClose={closeDrawer}
        actions={
          activeRow ? (
            <>
              <Button
                variant="success"
                size="sm"
                onClick={() => void handleSingle("approved")}
                disabled={singleLoading}
              >
                <Check className="size-3.5" />
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                onClick={() => void handleSingle("rejected")}
                disabled={singleLoading}
              >
                <X className="size-3.5" />
                Reject
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={() => setDeleteConfirmKeys(activeKey ? [activeKey] : null)}
                disabled={deleteLoading}
              >
                <Trash2 className="size-3.5" />
                Delete
              </Button>
              <Button variant="ghost" size="sm" className="ml-auto" onClick={closeDrawer}>
                Close
              </Button>
            </>
          ) : undefined
        }
      />

      {/* ─── Bulk approve confirmation (> threshold only) ─────── */}
      <Dialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title={`Approve ${selectionCount} leads for outreach?`}
        description="They become sendable."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="success"
              size="sm"
              onClick={() => void runBulk("approved")}
              disabled={bulkLoading}
            >
              <Check className="size-3.5" />
              {bulkLoading ? "Working…" : "Approve"}
            </Button>
          </>
        }
      />

      {/* ─── Delete confirmation (hard delete) ────────────────── */}
      <Dialog
        open={deleteConfirmKeys !== null}
        onClose={() => setDeleteConfirmKeys(null)}
        title={`Delete ${deleteConfirmKeys?.length ?? 0} lead${(deleteConfirmKeys?.length ?? 0) === 1 ? "" : "s"}?`}
        description="This permanently removes them from the engine — outreach, reply history and approvals for these leads stop showing. This cannot be undone."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setDeleteConfirmKeys(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void runDelete(deleteConfirmKeys ?? [])}
              disabled={deleteLoading}
            >
              <Trash2 className="size-3.5" />
              {deleteLoading ? "Deleting…" : "Delete permanently"}
            </Button>
          </>
        }
      />

      {/* ─── CSV import: dry-run preview → confirm ─────────────── */}
      <Dialog
        open={importOpen}
        onClose={closeImport}
        className="max-w-2xl"
        title={`Import leads — ${importFile?.name ?? "CSV"}`}
        description="Give us the leads you already paid for."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={closeImport}>
              Cancel
            </Button>
            <Button
              variant="default"
              size="sm"
              onClick={() => void handleConfirmImport()}
              disabled={importLoading || !importPreview || importPreview.totalRows === 0}
            >
              <Upload className="size-3.5" />
              {importLoading ? "Working…" : "Confirm import"}
            </Button>
          </>
        }
      >
        {!importPreview ? (
          <div className="space-y-2 py-1">
            <Skeleton className="h-12 w-full" />
            <Skeleton className="h-28 w-full" />
            <p className="text-[0.6875rem] text-muted-foreground">
              Reading the file — nothing is written until you confirm.
            </p>
          </div>
        ) : (
          <div className="space-y-3">
            {importFile && (
              <p className="truncate text-[0.6875rem] text-faint">
                {importFile.name} · {(importFile.size / 1024).toFixed(0)} KB · dry run, no rows
                written yet
              </p>
            )}

            <div className="grid grid-cols-3 gap-2">
              <ImportStat label="Rows in file" value={importPreview.totalRows} />
              <ImportStat
                label="New leads"
                value={importPreview.newRows}
                muted={!importPreview.split}
              />
              <ImportStat
                label="Updated"
                value={importPreview.updatedRows}
                muted={!importPreview.split}
              />
            </div>

            {!importPreview.split && importPreview.totalRows > 0 && (
              <p className="text-[0.6875rem] text-muted-foreground">
                The engine didn't split new vs updated rows for this file — all{" "}
                {importPreview.totalRows.toLocaleString()} will be upserted.
              </p>
            )}

            {importPreview.totalRows === 0 && (
              <div className="rounded-md border border-border bg-surface-canvas px-3 py-2 text-[0.8125rem] text-muted-foreground">
                No importable rows. The file needs a header plus at least one row with key, name
                and country.
              </div>
            )}

            {importPreview.errors.length > 0 && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2">
                <div className="text-xs font-semibold text-destructive">
                  {importPreview.errors.length.toLocaleString()} row
                  {importPreview.errors.length === 1 ? "" : "s"} rejected
                </div>
                <ul className="mt-1 space-y-0.5">
                  {importPreview.errors.slice(0, MAX_IMPORT_ERRORS).map((message, i) => (
                    <li key={`${message}-${i}`} className="truncate text-[0.6875rem] text-destructive/90">
                      {message}
                    </li>
                  ))}
                </ul>
                {importPreview.errors.length > MAX_IMPORT_ERRORS && (
                  <p className="mt-1 text-[0.625rem] text-destructive/80">
                    +{importPreview.errors.length - MAX_IMPORT_ERRORS} more…
                  </p>
                )}
              </div>
            )}

            {importPreview.preview.length > 0 && importPreview.columns.length > 0 && (
              <div>
                <div className="mb-1.5 text-[0.625rem] font-semibold uppercase tracking-[0.05em] text-faint">
                  Preview — first {importPreview.preview.length} rows
                </div>
                <div className="scrollbar-thin overflow-x-auto rounded-md border border-border">
                  <table className="w-full border-collapse text-left text-[0.6875rem]">
                    <thead>
                      <tr className="border-b border-border bg-surface-canvas text-faint">
                        {importPreview.columns.map((col) => (
                          <th key={col} className="whitespace-nowrap px-2 py-1.5 font-semibold">
                            {col}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {importPreview.preview.map((row, i) => (
                        <tr key={i} className="border-b border-border/60 last:border-0">
                          {importPreview.columns.map((col) => (
                            <td
                              key={col}
                              className="max-w-[12rem] truncate px-2 py-1.5 text-body"
                              title={previewCell(row[col])}
                            >
                              {previewCell(row[col]) || "-"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {importPreview.totalRows > importPreview.preview.length && (
                  <p className="mt-1 text-[0.625rem] text-faint">
                    +
                    {(importPreview.totalRows - importPreview.preview.length).toLocaleString()} more
                    row{importPreview.totalRows - importPreview.preview.length === 1 ? "" : "s"} in
                    the file.
                  </p>
                )}
              </div>
            )}
          </div>
        )}
      </Dialog>
    </div>
  );
};

DataSection.displayName = "DataSection";
