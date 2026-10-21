/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  listLeads,
  isPaused,
  updateLead,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";
import type { Lead } from "../db/types.js";
import { classifyBatch } from "../agents/qualifier.js";
import { runResearcher } from "../agents/researcher.js";
import { runWriter } from "../agents/writer.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

export async function researchCron(env: Record<string, unknown>, externalDb?: DatabaseType.Database): Promise<{
  classified: number;
  researched: number;
  written: number;
  skipped: boolean;
}> {
  const ownDb = !externalDb;
  const db = externalDb ?? initDb();

  try {
    if (isPaused(db)) {
      return { classified: 0, researched: 0, written: 0, skipped: true };
    }

    const unclassified = listLeads(db, { stage: "raw", page: 1, pageSize: 25 });
    let classified = 0;
    if (unclassified.rows.length > 0) {
      try {
        await classifyBatch(db, unclassified.rows, env);
        classified = unclassified.rows.length;
      } catch {
        classified = 0;
      }
    }

    const hotWarm = db
      .prepare(
        `SELECT * FROM leads
         WHERE stage IN ('classified', 'verified')
           AND research IS NULL
           AND json_extract(classification, '$.tier') IN ('HOT', 'WARM')
         ORDER BY json_extract(classification, '$.fit') DESC
         LIMIT 10`
      )
      .all() as Lead[];

    let researched = 0;
    let written = 0;

    for (const lead of hotWarm) {
      try {
        const evidence = await runResearcher(db, lead, env);
        researched++;
        try {
          await runWriter(db, lead, evidence, env);
          written++;
        } catch (e) {
          console.error(`[research] writer failed for ${lead.key}:`, e);
        }
      } catch {
        // research failure is non-fatal
      }
    }

    return { classified, researched, written, skipped: false };
  } finally {
    if (ownDb) db.close();
  }
}
