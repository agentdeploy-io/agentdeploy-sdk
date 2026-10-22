/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  isPaused,
  createCrawlRun,
  updateCrawlRun,
  getSetting,
  getDefaultVertical,
  getVertical,
  SCHEMA_V1,
  runMigrations,
  type Vertical,
} from "../db/index.js";
import { parseCountries, SUPPORTED_COUNTRY_CODES } from "../services/countries.js";
import type { CrawlTrigger } from "../db/types.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

export interface CrawlCronOpts {
  /** Run this specific vertical. Omitted → the default vertical, if any,
   *  otherwise the legacy registry harvest from the countries setting. */
  verticalId?: string;
  trigger?: CrawlTrigger;
}

export async function crawlCron(
  env: Record<string, unknown>,
  externalDb?: DatabaseType.Database,
  opts?: CrawlCronOpts,
): Promise<{
  runId: number | null;
  state: string;
  skipped: boolean;
}> {
  const ownDb = !externalDb;
  const db = externalDb ?? initDb();
  const trigger = opts?.trigger ?? "cron";

  try {
    if (isPaused(db)) {
      return { runId: null, state: "skipped", skipped: true };
    }

    // A vertical pack (UI-editable) drives the run when selected or when it
    // is the default. Without one we fall back to the legacy harvest.
    let vertical: Vertical | null = null;
    if (opts?.verticalId) {
      vertical = getVertical(db, opts.verticalId);
    } else {
      vertical = getDefaultVertical(db);
    }

    let countriesRaw: string;
    let limit: number;
    if (vertical) {
      countriesRaw = vertical.countries.join(",");
      limit = vertical.perCountryLimit * Math.max(1, vertical.countries.length);
    } else {
      countriesRaw = String(getSetting(db, "countries") ?? "uk,ie,fr");
      limit = Number(getSetting(db, "crawlLimit") ?? 50);
    }
    const coreUrl = env.CORE_URL as string;

    // Normalise country names to the 2-letter codes the core harvesters key
    // on ("Ireland" -> "ie"). Fail LOUDLY on unknown countries instead of
    // silently harvesting nothing — that was the "where's my data?" bug.
    const { codes, unknown } = parseCountries(countriesRaw);
    if (unknown.length > 0 || codes.length === 0) {
      const runId = createCrawlRun(db, {
        started_at: new Date().toISOString(),
        trigger,
        countries: countriesRaw,
        params: JSON.stringify({ limit, verticalId: vertical?.id }),
        state: "failed",
      });
      const err = unknown.length > 0
        ? `Unsupported countries: ${unknown.join(", ")} — supported: ${SUPPORTED_COUNTRY_CODES.join(", ")}`
        : "No countries configured (set e.g. \"uk,ie,fr\")";
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "failed",
        stats: JSON.stringify({ error: err }),
      });
      return { runId, state: "failed", skipped: false };
    }
    const countries = codes.join(",");

    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger,
      countries,
      params: JSON.stringify({ limit, verticalId: vertical?.id }),
      state: "running",
    });

    if (!coreUrl) {
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "failed",
        stats: JSON.stringify({ error: "CORE_URL not configured" }),
      });
      return { runId, state: "failed", skipped: false };
    }

    try {
      const res = await fetch(`${coreUrl.replace(/\/$/, "")}/v1/handoff`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countries: codes,
          limit,
          trigger,
          ...(vertical
            ? {
                vertical: {
                  id: vertical.id,
                  name: vertical.name,
                  icp: vertical.icp,
                  countries: codes,
                  dorks: vertical.dorks,
                  cities: vertical.cities,
                  sicInclude: vertical.sicInclude,
                  sicExclude: vertical.sicExclude,
                  requireWebsite: vertical.requireWebsite,
                  useRegistry: vertical.useRegistry,
                  llmEnrich: vertical.llmEnrich,
                  mxGuess: vertical.mxGuess,
                  minScore: vertical.minScore,
                  perCountryLimit: vertical.perCountryLimit,
                },
              }
            : {}),
        }),
      });

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        updateCrawlRun(db, runId, {
          finished_at: new Date().toISOString(),
          state: "failed",
          stats: JSON.stringify({ error: `core ${res.status}: ${text.slice(0, 200)}` }),
        });
        return { runId, state: "failed", skipped: false };
      }

      const data = (await res.json()) as Record<string, unknown>;

      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "succeeded",
        stats: JSON.stringify(data),
      });

      return { runId, state: "succeeded", skipped: false };
    } catch (e: any) {
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "failed",
        stats: JSON.stringify({ error: e.message }),
      });
      return { runId, state: "failed", skipped: false };
    }
  } finally {
    if (ownDb) db.close();
  }
}
