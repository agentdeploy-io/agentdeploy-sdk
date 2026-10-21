/**
 * FilterBar
 * ─────────
 * Search + multi-select faceting + saved presets for a DataGrid.
 * Faithful Tailwind rebuild of the playground FilterBar with GENERIC filter
 * keys (driven by `filterOptions`), so it isn't hard-wired to the lead
 * schema. Search is debounced 300ms; presets persist to
 * useLocalStorage("calla-filter-presets").
 */

import React, { useCallback, useEffect, useRef, useState } from "react";
import { ChevronDown, Search, Trash2, X } from "lucide-react";
import { Badge, Button, Input } from "@/components/ui";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import { cn } from "@/lib/utils";
import type { DataFilters } from "@/hooks/useDataApi";

// ─── Types ───────────────────────────────────────────────────────

export interface FilterOption {
  /** Key into DataFilters (generic — any string[] facet). */
  key: string;
  label: string;
  values: string[];
}

export interface FilterPreset {
  id: string;
  name: string;
  filters: DataFilters;
  createdAt: number;
}

export interface FilterBarProps {
  filters: DataFilters;
  onChange: (filters: DataFilters) => void;
  filterOptions: FilterOption[];
  totalResults?: number;
  searchPlaceholder?: string;
  className?: string;
}

const PRESET_STORAGE_KEY = "calla-filter-presets";

type FiltersRecord = Record<string, unknown>;

function selectedFor(filters: DataFilters, key: string): string[] {
  const v = (filters as FiltersRecord)[key];
  return Array.isArray(v) ? (v as string[]) : [];
}

// ─── Multi-select dropdown ───────────────────────────────────────

const MultiSelect: React.FC<{
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}> = ({ label, options, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const toggle = useCallback(
    (value: string) => {
      onChange(
        selected.includes(value)
          ? selected.filter((s) => s !== value)
          : [...selected, value],
      );
    },
    [selected, onChange],
  );

  const active = selected.length > 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "inline-flex h-9 items-center gap-1.5 rounded-md border px-3 text-[0.8125rem] font-medium transition-colors",
          active
            ? "border-primary bg-info/10 text-primary"
            : "border-border-strong bg-transparent text-foreground hover:bg-surface-hover",
        )}
      >
        {label}
        {active && (
          <span className="rounded-full bg-primary px-1.5 text-[0.6875rem] font-semibold text-primary-foreground">
            {selected.length}
          </span>
        )}
        <ChevronDown className="size-3 opacity-70" />
      </button>

      {open && (
        <div className="scrollbar-thin absolute top-full left-0 z-50 mt-1 max-h-60 min-w-[180px] overflow-y-auto rounded-md border border-border bg-card p-1 shadow-elevated">
          {options.length === 0 && (
            <div className="px-3 py-2 text-center text-[0.8125rem] text-muted-foreground">
              No options
            </div>
          )}
          {options.map((opt) => (
            <label
              key={opt}
              className="flex cursor-pointer items-center gap-2 rounded-sm px-2.5 py-1.5 text-[0.8125rem] text-body transition-colors hover:bg-surface-hover"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt)}
                onChange={() => toggle(opt)}
                className="size-3.5 accent-[hsl(var(--primary))]"
              />
              <span className="truncate">{opt}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────

export const FilterBar: React.FC<FilterBarProps> = React.memo(
  ({
    filters,
    onChange,
    filterOptions,
    totalResults,
    searchPlaceholder = "Search…",
    className,
  }) => {
    const [search, setSearch] = useState(filters.search ?? "");
    const [presets, setPresets] = useLocalStorage<FilterPreset[]>(PRESET_STORAGE_KEY, []);
    const [showPresets, setShowPresets] = useState(false);
    const [newPresetName, setNewPresetName] = useState("");
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const presetsRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
      if (!showPresets) return;
      const handler = (e: MouseEvent) => {
        if (presetsRef.current && !presetsRef.current.contains(e.target as Node)) {
          setShowPresets(false);
        }
      };
      document.addEventListener("mousedown", handler);
      return () => document.removeEventListener("mousedown", handler);
    }, [showPresets]);

    useEffect(
      () => () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      },
      [],
    );

    const handleSearch = useCallback(
      (value: string) => {
        setSearch(value);
        if (debounceRef.current) clearTimeout(debounceRef.current);
        debounceRef.current = setTimeout(() => {
          onChange({ ...filters, search: value || undefined });
        }, 300);
      },
      [filters, onChange],
    );

    const handleFacetChange = useCallback(
      (key: string, values: string[]) => {
        onChange({
          ...filters,
          [key]: values.length > 0 ? values : undefined,
        });
      },
      [filters, onChange],
    );

    const hasActiveFilters =
      !!filters.search ||
      filterOptions.some((opt) => selectedFor(filters, opt.key).length > 0);

    const clearAll = useCallback(() => {
      setSearch("");
      if (debounceRef.current) clearTimeout(debounceRef.current);
      onChange({});
    }, [onChange]);

    const savePreset = useCallback(() => {
      const name = newPresetName.trim();
      if (!name) return;
      setPresets([
        ...presets,
        { id: Date.now().toString(36), name, filters: { ...filters }, createdAt: Date.now() },
      ]);
      setNewPresetName("");
      setShowPresets(false);
    }, [newPresetName, filters, presets, setPresets]);

    const loadPreset = useCallback(
      (preset: FilterPreset) => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
        setSearch(preset.filters.search ?? "");
        onChange(preset.filters);
        setShowPresets(false);
      },
      [onChange],
    );

    const deletePreset = useCallback(
      (id: string) => setPresets(presets.filter((p) => p.id !== id)),
      [presets, setPresets],
    );

    return (
      <div className={cn("flex flex-col gap-3", className)}>
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-60 shrink-0">
            <Input
              value={search}
              placeholder={searchPlaceholder}
              onChange={(e) => handleSearch(e.target.value)}
              leftIcon={<Search className="size-4" />}
              aria-label="Search"
            />
          </div>

          {filterOptions.map((opt) => (
            <MultiSelect
              key={opt.key}
              label={opt.label}
              options={opt.values}
              selected={selectedFor(filters, opt.key)}
              onChange={(vals) => handleFacetChange(opt.key, vals)}
            />
          ))}

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearAll}>
              Clear all
            </Button>
          )}

          <div className="flex-1" />

          {totalResults !== undefined && (
            <span className="whitespace-nowrap text-xs text-muted-foreground">
              {totalResults.toLocaleString()} results
            </span>
          )}

          <div ref={presetsRef} className="relative">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowPresets((v) => !v)}
            >
              Presets
              <ChevronDown className="size-3" />
            </Button>
            {showPresets && (
              <div className="absolute top-full right-0 z-50 mt-1 w-72 rounded-md border border-border bg-card p-3 shadow-elevated">
                <div className="mb-2 flex gap-1.5">
                  <input
                    value={newPresetName}
                    placeholder="Preset name"
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && savePreset()}
                    className="h-8 flex-1 rounded-sm border border-border-strong bg-input px-2 text-[0.8125rem] text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                  <Button size="sm" className="h-8" onClick={savePreset}>
                    Save
                  </Button>
                </div>
                {presets.length === 0 && (
                  <div className="py-2 text-center text-[0.8125rem] text-muted-foreground">
                    No saved presets
                  </div>
                )}
                <div className="scrollbar-thin max-h-56 overflow-y-auto">
                  {presets.map((preset) => (
                    <div
                      key={preset.id}
                      role="button"
                      tabIndex={0}
                      onClick={() => loadPreset(preset)}
                      onKeyDown={(e) => e.key === "Enter" && loadPreset(preset)}
                      className="flex cursor-pointer items-center justify-between rounded-sm px-2 py-1.5 transition-colors hover:bg-surface-hover"
                    >
                      <span className="truncate text-[0.8125rem] text-foreground">
                        {preset.name}
                      </span>
                      <button
                        type="button"
                        aria-label={`Delete preset ${preset.name}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          deletePreset(preset.id);
                        }}
                        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Active filter chips */}
        {hasActiveFilters && (
          <div className="flex flex-wrap gap-1.5">
            {filters.search && (
              <Chip
                label={`search: ${filters.search}`}
                onClear={() => onChange({ ...filters, search: undefined })}
              />
            )}
            {filterOptions.flatMap((opt) =>
              selectedFor(filters, opt.key).map((val) => (
                <Chip
                  key={`${opt.key}-${val}`}
                  label={`${opt.label}: ${val}`}
                  onClear={() =>
                    handleFacetChange(
                      opt.key,
                      selectedFor(filters, opt.key).filter((v) => v !== val),
                    )
                  }
                />
              )),
            )}
          </div>
        )}
      </div>
    );
  },
);

FilterBar.displayName = "FilterBar";

const Chip: React.FC<{ label: string; onClear: () => void }> = ({ label, onClear }) => (
  <Badge variant="info" className="gap-1 pr-1">
    <span className="max-w-[220px] truncate">{label}</span>
    <button
      type="button"
      onClick={onClear}
      aria-label={`Remove filter ${label}`}
      className="rounded-full p-0.5 hover:bg-primary/20"
    >
      <X className="size-3" />
    </button>
  </Badge>
);
