/**
 * Deployment config HTTP surface — per-deployment module feature flags.
 *
 * createConfigApp({ store }) builds a Hono sub-app mounted at /config
 * (behind the brain's bearer auth). The singleton `calla_deployment_config`
 * row is the runtime source of truth for which modules (Data, Approvals,
 * Voice, …) this deployment exposes; the UI resolves brain → runtime-config
 * → all-enabled. Registry + presets + dependency closure live in
 * @calla/shared (modules.ts) so brain and UI can never drift.
 *
 * Contract (frozen — the UI codes against this):
 *   GET /config/modules
 *          → { modules: ModuleId[] | null, preset?: string,
 *              updatedBy?: string, updatedAt?: string,
 *              source: "store" | "default" }
 *          `modules: null` = all modules enabled (no row / no modules key).
 *   PUT /config/modules   { modules?: string[] } XOR { preset?: string }
 *          (+ optional `updatedBy`) → { modules: ModuleId[] }
 *          validates ids, closes the dependency closure (always-on modules
 *          included, dependents of disabled modules dropped), persists,
 *          appends audit `config.modules_changed` (old → new).
 *   GET /config/modules/presets → { presets: Record<string, ModulePreset> }
 */
import { Hono } from "hono";
import { z } from "zod";
import {
  MODULE_PRESETS,
  isKnownModuleId,
  resolveModuleSet,
  type DeploymentConfigPayload,
  type ModuleId,
} from "@calla/shared";
import type { CallaStore } from "../store/types.js";

interface ConfigAppDeps {
  store: CallaStore;
}

const setModulesSchema = z
  .object({
    modules: z
      .array(z.string())
      .min(1)
      .max(32)
      .optional(),
    preset: z.string().min(1).max(32).optional(),
    updatedBy: z.string().max(256).optional(),
  })
  .refine((b) => (b.modules ? 1 : 0) + (b.preset ? 1 : 0) === 1, {
    message: "Provide exactly one of: modules (array) or preset (name)",
  });

export function createConfigApp({ store }: ConfigAppDeps) {
  const app = new Hono();

  const readCurrent = async (): Promise<{
    payload: DeploymentConfigPayload | null;
    updatedAt: string | null;
  }> => {
    try {
      const row = await store.getDeploymentConfig();
      if (!row) return { payload: null, updatedAt: null };
      return { payload: row.payload, updatedAt: row.updatedAt };
    } catch (err) {
      console.error("[calla-brain] getDeploymentConfig failed:", err);
      return { payload: null, updatedAt: null };
    }
  };

  /** Stored modules array, re-validated + dep-closed, or null (= all on). */
  const effectiveModules = (payload: DeploymentConfigPayload | null): ModuleId[] | null => {
    const stored = payload?.modules;
    if (!stored || !Array.isArray(stored)) return null;
    if (!stored.every(isKnownModuleId)) return null;
    return resolveModuleSet(stored);
  };

  app.get("/modules", async (c) => {
    const { payload, updatedAt } = await readCurrent();
    const modules = effectiveModules(payload);
    return c.json({
      modules,
      preset: payload?.preset,
      updatedBy: payload?.updatedBy,
      updatedAt,
      source: modules === null ? "default" : "store",
    });
  });

  app.get("/modules/presets", (c) => {
    return c.json({ presets: MODULE_PRESETS });
  });

  app.put("/modules", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Invalid JSON body" }, 400);
    const parsed = setModulesSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const { modules: rawModules, preset, updatedBy } = parsed.data;

    let requested: string[];
    if (preset !== undefined) {
      const p = MODULE_PRESETS[preset];
      if (!p) {
        return c.json(
          { error: `Unknown preset: ${preset}`, known: Object.keys(MODULE_PRESETS) },
          400,
        );
      }
      requested = [...p.modules];
    } else {
      const unknown = (rawModules ?? []).filter((id) => !isKnownModuleId(id));
      if (unknown.length > 0) {
        return c.json({ error: `Unknown module ids: ${unknown.join(", ")}` }, 400);
      }
      requested = rawModules!;
    }

    const resolved = resolveModuleSet(requested);

    const prev = await readCurrent();
    const from = effectiveModules(prev.payload) ?? "all";

    let row: { payload: DeploymentConfigPayload; updatedAt: string } | null = null;
    try {
      row = await store.setDeploymentConfig({
        modules: resolved,
        ...(preset !== undefined ? { preset } : {}),
        updatedBy: updatedBy ?? "unknown",
      });
    } catch (err) {
      console.error("[calla-brain] setDeploymentConfig failed:", err);
      return c.json({ error: "Failed to persist deployment config" }, 500);
    }
    if (!row) return c.json({ error: "calla store unavailable" }, 500);

    try {
      await store.appendAudit({
        agentId: "deployment",
        kind: "config.modules_changed",
        entry: { from, to: resolved, preset: preset ?? null, updatedBy: updatedBy ?? "unknown" },
      });
    } catch (err) {
      console.error("[calla-brain] audit config.modules_changed failed:", err);
    }

    return c.json({
      modules: resolved,
      preset: preset,
      updatedBy: updatedBy ?? "unknown",
      updatedAt: row.updatedAt,
    });
  });

  return app;
}
