/**
 * Module enable/disable — UI-side resolution of the per-deployment enabled
 * module set (see @calla/shared modules.ts for the registry).
 *
 * Resolution order (first wins):
 *   1. brain `GET /config/modules` (runtime; the Setup panel's PUT lands here)
 *   2. runtime-config `ENABLED_MODULES` (baked at deploy time per vertical)
 *   3. null = all modules enabled (local dev default)
 *
 * A module-level store (not per-component state): every consumer
 * (App gate, Sidebar, CommandPalette, keyboard shortcuts, Setup panel)
 * subscribes to the same snapshot via useSyncExternalStore, so the brain
 * fetch happens exactly once per page load and a Setup-panel PUT updates
 * the whole UI instantly (applyModuleConfig).
 *
 * `modules: null` ALWAYS means "all enabled" — the only shape the brain
 * returns for "no restriction", and the only shape that keeps the dev
 * default (no brain, no config) fully open.
 */
import { useSyncExternalStore } from "react";
import {
  isKnownModuleId,
  resolveModuleSet,
  type ModuleId,
} from "@calla/shared";
import { getBrainUrl } from "@/config";
import { authFetch } from "@/hooks/useAuthFetch";
import { getConfigEnabledModules } from "@/config";

export type ModuleSource = "brain" | "config" | "default";

// ─── Module-level store ──────────────────────────────────────────

let effective: ModuleId[] | null = null;
let source: ModuleSource = "default";
let seeded = false;
let inFlight: Promise<void> | null = null;
const listeners = new Set<() => void>();

function commit(mods: ModuleId[] | null, src: ModuleSource): void {
  effective = mods;
  source = src;
  for (const l of listeners) l();
}

function getSnapshot(): ModuleId[] | null {
  return effective;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Runtime-config fallback (empty list = all enabled → null). */
function seedFromRuntimeConfig(): ModuleId[] | null {
  const raw = getConfigEnabledModules();
  if (raw.length === 0) return null;
  const ids = raw.filter(isKnownModuleId);
  return ids.length > 0 ? resolveModuleSet(ids) : null;
}

async function fetchFromBrain(): Promise<ModuleId[] | null> {
  const base = getBrainUrl().trim().replace(/\/+$/, "");
  if (!base || base.toLowerCase() === "none") return null;
  const res = await authFetch(`${base}/config/modules`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { modules?: ModuleId[] | null };
  if (!data || !Array.isArray(data.modules)) return null;
  const ids = data.modules.filter(isKnownModuleId);
  return resolveModuleSet(ids);
}

/**
 * One-time init: seed from runtime config synchronously, then (when the
 * brain is configured) fetch the runtime row. Safe to call from several
 * effects — the fetch is deduped via `inFlight`.
 */
export function initModuleConfig(): void {
  if (!seeded) {
    seeded = true;
    const fromConfig = seedFromRuntimeConfig();
    if (fromConfig !== null) commit(fromConfig, "config");
  }
  if (!inFlight) {
    inFlight = (async () => {
      try {
        const fromBrain = await fetchFromBrain();
        if (fromBrain !== null) commit(fromBrain, "brain");
      } catch {
        // brain unreachable — keep the runtime-config/default state
      }
    })();
  }
}

/**
 * Optimistic local apply — the Setup panel calls this after a successful
 * PUT /config/modules so the nav/router/palette update without a reload.
 */
export function applyModuleConfig(mods: ModuleId[] | null, src: ModuleSource = "brain"): void {
  commit(mods === null ? null : resolveModuleSet(mods), src);
}

// ─── React hook ──────────────────────────────────────────────────

export interface UseModuleConfigResult {
  /** The resolved enabled set; null = all enabled. */
  modules: ModuleId[] | null;
  /** Where the current set came from. */
  source: ModuleSource;
  /** True when the brain (or a PUT) is authoritative over runtime-config. */
  isRuntime: boolean;
}

/**
 * Subscribe to the shared enabled-module set. `null` = all enabled.
 * Combine with @calla/shared isModuleEnabled(id, modules) for checks.
 */
export function useModuleConfig(): UseModuleConfigResult {
  const modules = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return { modules, source, isRuntime: source !== "config" };
}
