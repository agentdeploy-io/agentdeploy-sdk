import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { SCHEMA_V1, runMigrations, hasRealSendByLead, hasRealSendByEmail } from "../../db/index.js";
import { appendSendToJournal, reconcileSendJournal } from "../../db/send-journal.js";

let tmp: string;
let journal: string;
let db: DatabaseType.Database;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "send-journal-"));
  journal = join(tmp, "send-journal.jsonl");
  vi.stubEnv("SEND_JOURNAL_PATH", journal);
  db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(tmp, { recursive: true, force: true });
});

describe("send journal (restart-proof double-send guard)", () => {
  it("appends real sends and rehydrates a fresh sent_log from the journal", async () => {
    await appendSendToJournal({
      lead_key: "uk/journal-test",
      email: "owner@journaltest.co.uk",
      subject: "Pitch",
      message_id: "<msg-j1@smtp-relay.mailin.fr>",
      status: "sent",
      at: "2026-11-13T10:00:00.000Z",
      channel: "email",
    });

    // Fresh DB (simulates a wiped state dir) — guard knows nothing yet.
    expect(hasRealSendByLead(db, "uk/journal-test")).toBe(false);

    const restored = await reconcileSendJournal(db);
    expect(restored).toBe(1);
    // The double-send guards now block again, without any lead row.
    expect(hasRealSendByLead(db, "uk/journal-test")).toBe(true);
    expect(hasRealSendByEmail(db, "owner@journaltest.co.uk")).toBe(true);
  });

  it("reconcile is idempotent and ignores non-sent entries", async () => {
    writeFileSync(
      journal,
      [
        JSON.stringify({ lead_key: "uk/a", email: "a@x.io", message_id: "<a@r>", status: "sent", at: "2026-11-13T09:00:00.000Z" }),
        JSON.stringify({ lead_key: "uk/b", email: "b@x.io", message_id: null, status: "dry-run", at: "2026-11-13T09:00:00.000Z" }),
        JSON.stringify({ lead_key: "uk/c", email: "c@x.io", message_id: null, status: "failed:smtp 550", at: "2026-11-13T09:00:00.000Z" }),
        "not-json\n",
      ].join("\n"),
      "utf8",
    );

    expect(await reconcileSendJournal(db)).toBe(1);
    expect(await reconcileSendJournal(db)).toBe(0); // idempotent
    expect(hasRealSendByLead(db, "uk/a")).toBe(true);
    expect(hasRealSendByLead(db, "uk/b")).toBe(false); // dry-run never counts
    expect(hasRealSendByLead(db, "uk/c")).toBe(false); // failure doesn't count
  });

  it("does not duplicate a send already present in sent_log (no message id)", async () => {
    writeFileSync(
      journal,
      JSON.stringify({ lead_key: "uk/a", email: "a@x.io", message_id: null, status: "sent", at: "2026-11-13T09:00:00.000Z" }) + "\n",
      "utf8",
    );
    db.prepare(
      `INSERT INTO sent_log (lead_key, email, subject, message_id, status, at, channel)
       VALUES ('uk/a', 'a@x.io', 'P', NULL, 'sent', '2026-11-13T09:00:00.000Z', 'email')`,
    ).run();

    expect(await reconcileSendJournal(db)).toBe(0);
    const count = (db.prepare(`SELECT COUNT(*) AS c FROM sent_log WHERE lead_key = 'uk/a'`).get() as { c: number }).c;
    expect(count).toBe(1);
  });

  it("no journal file → no-op, no throw", async () => {
    expect(await reconcileSendJournal(db)).toBe(0);
  });
});
