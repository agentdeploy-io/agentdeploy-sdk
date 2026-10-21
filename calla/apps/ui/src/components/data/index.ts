/**
 * Data Components Barrel Export
 * ─────────────────────────────
 * Single import point for the data-plane surface: @/components/data
 */

export {
  DataGrid,
  renderCell,
  STATUS_BADGE_VARIANT,
  type ColumnDef,
  type ColumnType,
  type DataGridProps,
  type SortDir,
} from "./DataGrid";
export {
  FilterBar,
  type FilterBarProps,
  type FilterOption,
  type FilterPreset,
} from "./FilterBar";
export {
  DetailPanel,
  type DetailPanelProps,
  type DetailSection,
  type DetailField,
} from "./DetailPanel";
