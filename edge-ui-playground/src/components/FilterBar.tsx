import React, { useState, useCallback, useRef, useEffect } from "react";
import { COLORS, RADIUS, TRANSITIONS } from "../constants/theme";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Badge } from "./ui/Badge";
import { useLocalStorage } from "../hooks/useLocalStorage";
import type { DataFilters } from "../hooks/useDataApi";

// ─── Types ───────────────────────────────────────────────────────

export interface FilterOption {
  key: keyof DataFilters;
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
}

// ─── Multi-Select Dropdown ──────────────────────────────────────

const MultiSelect: React.FC<{
  label: string;
  options: string[];
  selected: string[];
  onChange: (selected: string[]) => void;
}> = ({ label, options, selected, onChange }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const toggle = useCallback(
    (value: string) => {
      if (selected.includes(value)) {
        onChange(selected.filter((s) => s !== value));
      } else {
        onChange([...selected, value]);
      }
    },
    [selected, onChange],
  );

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: "6px",
          height: "34px",
          padding: "0 12px",
          borderRadius: RADIUS.md,
          border: `1px solid ${selected.length > 0 ? COLORS.primary : COLORS.border}`,
          backgroundColor: selected.length > 0 ? "var(--color-info-bg)" : "transparent",
          color: selected.length > 0 ? COLORS.primary : COLORS.foreground,
          fontSize: "0.8125rem",
          fontWeight: 500,
          cursor: "pointer",
          transition: `all ${TRANSITIONS.fast}`,
        }}
      >
        {label}
        {selected.length > 0 && (
          <span
            style={{
              fontSize: "0.6875rem",
              padding: "1px 6px",
              borderRadius: "10px",
              backgroundColor: COLORS.primary,
              color: COLORS.primaryForeground,
              fontWeight: 600,
            }}
          >
            {selected.length}
          </span>
        )}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: "180px",
            maxHeight: "240px",
            overflowY: "auto",
            backgroundColor: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            boxShadow: "0 10px 15px -3px rgba(0,0,0,0.08), 0 4px 6px -4px rgba(0,0,0,0.05)",
            zIndex: 100,
            padding: "4px",
          }}
        >
          {options.map((opt) => {
            const checked = selected.includes(opt);
            return (
              <label
                key={opt}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "8px 10px",
                  borderRadius: "4px",
                  cursor: "pointer",
                  fontSize: "0.8125rem",
                  color: COLORS.foreground,
                  transition: `background-color ${TRANSITIONS.fast}`,
                }}
                onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.cardHover)}
                onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => toggle(opt)}
                  style={{ accentColor: COLORS.primary }}
                />
                {opt}
              </label>
            );
          })}
          {options.length === 0 && (
            <div style={{ padding: "12px", fontSize: "0.8125rem", color: COLORS.mutedForeground, textAlign: "center" }}>
              No options
            </div>
          )}
        </div>
      )}
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────

export const FilterBar: React.FC<FilterBarProps> = React.memo(
  ({ filters, onChange, filterOptions, totalResults }) => {
    const [search, setSearch] = useState(filters.search ?? "");
    const [presets, setPresets] = useLocalStorage<FilterPreset[]>("data-studio-presets", []);
    const [showPresets, setShowPresets] = useState(false);
    const [newPresetName, setNewPresetName] = useState("");
    const debounceRef = useRef<ReturnType<typeof setTimeout>>();

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

    const handleFilterChange = useCallback(
      (key: keyof DataFilters, values: string[]) => {
        onChange({
          ...filters,
          [key]: values.length > 0 ? values : undefined,
        });
      },
      [filters, onChange],
    );

    const clearAll = useCallback(() => {
      setSearch("");
      onChange({});
    }, [onChange]);

    const savePreset = useCallback(() => {
      if (!newPresetName.trim()) return;
      const preset: FilterPreset = {
        id: Date.now().toString(36),
        name: newPresetName.trim(),
        filters: { ...filters },
        createdAt: Date.now(),
      };
      setPresets([...presets, preset]);
      setNewPresetName("");
      setShowPresets(false);
    }, [newPresetName, filters, presets, setPresets]);

    const loadPreset = useCallback(
      (preset: FilterPreset) => {
        setSearch(preset.filters.search ?? "");
        onChange(preset.filters);
        setShowPresets(false);
      },
      [onChange],
    );

    const deletePreset = useCallback(
      (id: string) => {
        setPresets(presets.filter((p) => p.id !== id));
      },
      [presets, setPresets],
    );

    const hasActiveFilters =
      filters.search ||
      filters.stage?.length ||
      filters.country?.length ||
      filters.tier?.length ||
      filters.status?.length ||
      filters.website_status?.length;

    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" }}>
          <Input
            placeholder="Search leads..."
            value={search}
            onChange={(e) => handleSearch((e.target as HTMLInputElement).value)}
            leftIcon={
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            }
            containerStyle={{ width: "240px", flexShrink: 0 }}
            style={{ height: "34px" }}
          />

          {filterOptions.map((opt) => (
            <MultiSelect
              key={opt.key}
              label={opt.label}
              options={opt.values}
              selected={(filters[opt.key] as string[]) ?? []}
              onChange={(vals) => handleFilterChange(opt.key, vals)}
            />
          ))}

          {hasActiveFilters && (
            <Button variant="ghost" size="sm" onClick={clearAll} style={{ fontSize: "0.8125rem" }}>
              Clear all
            </Button>
          )}

          <div style={{ flex: 1 }} />

          {totalResults !== undefined && (
            <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, whiteSpace: "nowrap" }}>
              {totalResults.toLocaleString()} results
            </span>
          )}

          <div style={{ position: "relative" }}>
            <Button variant="outline" size="sm" onClick={() => setShowPresets(!showPresets)} style={{ fontSize: "0.8125rem" }}>
              Presets
            </Button>
            {showPresets && (
              <div
                style={{
                  position: "absolute",
                  top: "calc(100% + 4px)",
                  right: 0,
                  width: "280px",
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  borderRadius: RADIUS.md,
                  boxShadow: "0 10px 15px -3px rgba(0,0,0,0.08)",
                  zIndex: 100,
                  padding: "12px",
                }}
              >
                <div style={{ display: "flex", gap: "6px", marginBottom: "8px" }}>
                  <input
                    placeholder="Preset name"
                    value={newPresetName}
                    onChange={(e) => setNewPresetName(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && savePreset()}
                    style={{
                      flex: 1,
                      height: "30px",
                      padding: "0 8px",
                      borderRadius: RADIUS.sm,
                      border: `1px solid ${COLORS.border}`,
                      fontSize: "0.8125rem",
                      backgroundColor: COLORS.background,
                      color: COLORS.foreground,
                    }}
                  />
                  <Button variant="primary" size="sm" onClick={savePreset} style={{ height: "30px", fontSize: "0.75rem" }}>
                    Save
                  </Button>
                </div>
                {presets.length === 0 && (
                  <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, textAlign: "center", padding: "8px 0" }}>
                    No saved presets
                  </div>
                )}
                {presets.map((preset) => (
                  <div
                    key={preset.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "6px 8px",
                      borderRadius: "4px",
                      cursor: "pointer",
                      transition: `background-color ${TRANSITIONS.fast}`,
                    }}
                    onClick={() => loadPreset(preset)}
                    onMouseEnter={(e) => (e.currentTarget.style.backgroundColor = COLORS.cardHover)}
                    onMouseLeave={(e) => (e.currentTarget.style.backgroundColor = "transparent")}
                  >
                    <span style={{ fontSize: "0.8125rem", color: COLORS.foreground }}>{preset.name}</span>
                    <button
                      onClick={(e) => { e.stopPropagation(); deletePreset(preset.id); }}
                      style={{
                        background: "none",
                        border: "none",
                        color: COLORS.mutedForeground,
                        cursor: "pointer",
                        fontSize: "0.75rem",
                        padding: "2px 4px",
                      }}
                    >
                      &times;
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Active filter chips */}
        {hasActiveFilters && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {filters.search && (
              <Badge variant="info">
                search: {filters.search}
                <button
                  onClick={() => onChange({ ...filters, search: undefined })}
                  style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", marginLeft: "4px", fontWeight: 700 }}
                >
                  &times;
                </button>
              </Badge>
            )}
            {filterOptions.map((opt) =>
              ((filters[opt.key] as string[]) ?? []).map((val) => (
                <Badge key={`${opt.key}-${val}`} variant="info">
                  {opt.label}: {val}
                  <button
                    onClick={() =>
                      handleFilterChange(
                        opt.key,
                        ((filters[opt.key] as string[]) ?? []).filter((v) => v !== val),
                      )
                    }
                    style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", marginLeft: "4px", fontWeight: 700 }}
                  >
                    &times;
                  </button>
                </Badge>
              )),
            )}
          </div>
        )}
      </div>
    );
  },
);

FilterBar.displayName = "FilterBar";
