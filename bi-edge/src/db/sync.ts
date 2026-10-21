import type Database from "better-sqlite3";
import type { Lead, SyncWatermark } from "./types.js";
import { upsertLead } from "./leads.js";

const INIT_WATERMARK = `
  INSERT OR IGNORE INTO sync_watermark (id, last_rowid, last_synced_at) VALUES (1, 0, NULL)
`;

const GET_WATERMARK = `SELECT * FROM sync_watermark WHERE id = 1`;

const UPDATE_WATERMARK = `
  UPDATE sync_watermark SET last_rowid = ?, last_synced_at = ? WHERE id = 1
`;

export function initWatermark(db: Database.Database): void {
  db.exec(INIT_WATERMARK);
}

export function getWatermark(db: Database.Database): SyncWatermark {
  initWatermark(db);
  const row = db.prepare(GET_WATERMARK).get() as SyncWatermark | undefined;
  return row ?? { id: 1, last_rowid: 0, last_synced_at: null };
}

export function advanceWatermark(db: Database.Database, rowid: number): void {
  db.prepare(UPDATE_WATERMARK).run(rowid, new Date().toISOString());
}

export function upsertSyncBatch(db: Database.Database, leads: Lead[]): {
  accepted: number;
  watermark: number;
} {
  const runInTransaction = db.transaction(() => {
    let accepted = 0;
    const wm = getWatermark(db);
    let maxRowid = wm.last_rowid;

    for (const lead of leads) {
      upsertLead(db, lead);
      accepted++;
    }

    if (accepted > 0) {
      const lastRow = db
        .prepare("SELECT MAX(rowid) as maxRowid FROM leads")
        .get() as { maxRowid: number | null };
      if (lastRow.maxRowid && lastRow.maxRowid > maxRowid) {
        maxRowid = lastRow.maxRowid;
      }
      advanceWatermark(db, maxRowid);
    }

    return { accepted, watermark: maxRowid };
  });

  return runInTransaction();
}
