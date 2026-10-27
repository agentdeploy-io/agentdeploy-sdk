/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  isPaused,
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

export async function housekeepingCron(env: Record<string, unknown>, externalDb?: DatabaseType.Database): Promise<{
  leadsPruned: number;
  blacklistPruned: number;
  optedOutPurged: number;
  staleRunsFailed: number;
  watermarkReset: boolean;
  skipped: boolean;
}> {
  const ownDb = !externalDb;
  const db = externalDb ?? initDb();

  try {
    const retentionDays = Number(getSetting(db, "retentionDays") ?? 90);
    const gdprDays = Number(getSetting(db, "gdprPurgeDays") ?? 30);

    const retentionCutoff = new Date();
    retentionCutoff.setDate(retentionCutoff.getDate() - retentionDays);
    const retentionIso = retentionCutoff.toISOString();

    const gdprCutoff = new Date();
    gdprCutoff.setDate(gdprCutoff.getDate() - gdprDays);
    const gdprIso = gdprCutoff.toISOString();

    const prunedLeads = db
      .prepare(
        `DELETE FROM leads
         WHERE stage = 'raw'
           AND created_at < ?
           AND status NOT IN ('approved', 'sent', 'replied')`
      )
      .run(retentionIso);

    const prunedSentLog = db
      .prepare("DELETE FROM sent_log WHERE at < ?")
      .run(retentionIso);

    const prunedRepliesLog = db
      .prepare("DELETE FROM replies_log WHERE at < ?")
      .run(retentionIso);

    const prunedCrawlRuns = db
      .prepare(
        "DELETE FROM crawl_runs WHERE finished_at IS NOT NULL AND finished_at < ?"
      )
      .run(retentionIso);

    const prunedBlacklist = db
      .prepare(
        `DELETE FROM blacklist
         WHERE created_at < ?
           AND kind = 'any'`
      )
      .run(retentionIso);

    const purgedOptedOut = db
      .prepare(
        `DELETE FROM leads
         WHERE status = 'opted_out'
           AND updated_at < ?`
      )
      .run(gdprIso);

    const inboundSeen = db
      .prepare("SELECT ids FROM inbound_seen WHERE id = 1")
      .get() as { ids: string } | undefined;

    let watermarkReset = false;
    if (inboundSeen) {
      try {
        const ids = JSON.parse(inboundSeen.ids) as string[];
        if (ids.length > 2000) {
          const trimmed = ids.slice(ids.length - 1000);
          db.prepare(
            "UPDATE inbound_seen SET ids = ?, updated_at = ? WHERE id = 1"
          ).run(JSON.stringify(trimmed), new Date().toISOString());
          watermarkReset = true;
        }
      } catch {
        // invalid JSON, reset
        db.prepare(
          "UPDATE inbound_seen SET ids = '[]', updated_at = ? WHERE id = 1"
        ).run(new Date().toISOString());
        watermarkReset = true;
      }
    }

    // Crawl runs are "running" until bi-core POSTs /inbound/run-complete. If
    // the core dies mid-run (VM crash, OOM) the run would spin forever —
    // fail it after 2h so the UI never shows a phantom in-flight crawl.
    const staleCutoff = new Date(Date.now() - 2 * 3600_000).toISOString();
    const staleRuns = db
      .prepare(
        `UPDATE crawl_runs
         SET state = 'failed',
             finished_at = ?,
             stats = JSON_OBJECT('error', 'core did not report completion within 2h')
         WHERE state = 'running' AND started_at < ?`
      )
      .run(new Date().toISOString(), staleCutoff);

    return {
      leadsPruned: prunedLeads.changes,
      blacklistPruned: prunedBlacklist.changes,
      optedOutPurged: purgedOptedOut.changes,
      staleRunsFailed: staleRuns.changes,
      watermarkReset,
      skipped: false,
    };
  } finally {
    if (ownDb) db.close();
  }
}
