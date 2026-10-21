/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  isPaused,
  createCrawlRun,
  updateCrawlRun,
  getSetting,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

export async function crawlCron(env: Record<string, unknown>, externalDb?: DatabaseType.Database): Promise<{
  runId: number | null;
  state: string;
  skipped: boolean;
}> {
  const ownDb = !externalDb;
  const db = externalDb ?? initDb();

  try {
    if (isPaused(db)) {
      return { runId: null, state: "skipped", skipped: true };
    }

    const countries = String(getSetting(db, "countries") ?? "uk,ie,fr");
    const limit = Number(getSetting(db, "crawlLimit") ?? 50);
    const coreUrl = env.CORE_URL as string;

    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries,
      params: JSON.stringify({ limit }),
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
          countries: countries.split(",").map((c) => c.trim()),
          limit,
          trigger: "cron",
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
