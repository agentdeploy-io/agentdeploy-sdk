import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { handleRunComplete } from "../../routes/inbound-run-complete.js";
import { runMigrations, createCrawlRun, getCrawlRun } from "../../db/index.js";
import { housekeepingCron } from "../../cron/housekeeping.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

async function post(db: DatabaseType.Database, body: unknown, secret = "s3cret"): Promise<Response> {
  const request = new Request("http://localhost/inbound/run-complete", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-AD-Sync": secret },
    body: JSON.stringify(body),
  });
  return handleRunComplete(request, { AD_SYNC_SECRET: "s3cret" }, db);
}

describe("crawl run-complete reporting", () => {
  let db: DatabaseType.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("completes a running run with real stats", async () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      params: "{}",
      state: "running",
    });
    const res = await post(db, {
      runId,
      state: "succeeded",
      stats: { totalCandidates: 20, totalSynced: 3, vmMinutes: 4.2, dropReasons: { fetchFailed: 1 } },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.accepted).toBe(true);

    const run = getCrawlRun(db, runId)!;
    expect(run.state).toBe("succeeded");
    expect(run.finished_at).toBeTruthy();
    expect(run.vm_minutes).toBe(4.2);
    expect(JSON.parse(run.stats!)).toMatchObject({ totalCandidates: 20, totalSynced: 3 });
  });

  it("rejects unknown run ids and wrong secrets", async () => {
    expect((await post(db, { runId: 999, state: "succeeded" })).status).toBe(404);
    expect((await post(db, { runId: 1, state: "succeeded" }, "wrong")).status).toBe(401);
  });

  it("terminal state is final — late reports do not overwrite", async () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      params: "{}",
      state: "running",
    });
    await post(db, { runId, state: "failed", stats: { error: "boom" } });
    const second = await post(db, { runId, state: "succeeded", stats: {} });
    const body = await second.json();
    expect(body.accepted).toBe(false);
    expect(getCrawlRun(db, runId)!.state).toBe("failed");
  });

  it("405 for non-POST", async () => {
    const res = await handleRunComplete(new Request("http://localhost/inbound/run-complete"), { AD_SYNC_SECRET: "s3cret" }, db);
    expect(res.status).toBe(405);
  });

  it("housekeeping fails runs stuck in 'running' for over 2h", async () => {
    const stale = new Date(Date.now() - 3 * 3600_000).toISOString();
    const runId = createCrawlRun(db, {
      started_at: stale,
      trigger: "cron",
      countries: "uk",
      params: "{}",
      state: "running",
    });
    const fresh = new Date().toISOString();
    const freshId = createCrawlRun(db, {
      started_at: fresh,
      trigger: "cron",
      countries: "uk",
      params: "{}",
      state: "running",
    });

    const out = await housekeepingCron({}, db);
    expect(out.staleRunsFailed).toBe(1);
    expect(getCrawlRun(db, runId)!.state).toBe("failed");
    expect(getCrawlRun(db, freshId)!.state).toBe("running");
  });
});
