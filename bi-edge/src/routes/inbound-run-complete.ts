/// <reference types="@cloudflare/workers-types" />

import type DatabaseType from "better-sqlite3";
import { updateCrawlRun, getCrawlRun } from "../db/index.js";
import type { CrawlState } from "../db/types.js";

/**
 * Crawl runs are created by the engine (state "running") when it queues a
 * crawl on bi-core; the core reports the real outcome here when the pipeline
 * actually finishes — candidates, drop reasons, sync counts. Before this
 * endpoint the run was marked "succeeded" at queue time, so the UI showed
 * "crawl succeeded" before the crawl existed.
 */
export async function handleRunComplete(
  request: Request,
  env: Record<string, unknown>,
  db: DatabaseType.Database,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(
      JSON.stringify({ error: "Method not allowed" }),
      { status: 405, headers: { "Content-Type": "application/json" } },
    );
  }

  const syncSecret = env.AD_SYNC_SECRET as string;
  if (syncSecret) {
    const provided = request.headers.get("X-AD-Sync");
    if (provided !== syncSecret) {
      return new Response(
        JSON.stringify({ error: "Invalid sync secret" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }
  }

  let body: { runId?: number; state?: string; stats?: unknown };
  try {
    body = await request.json();
  } catch {
    return new Response(
      JSON.stringify({ error: "Invalid JSON body" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const runId = Number(body.runId);
  if (!Number.isInteger(runId) || runId <= 0) {
    return new Response(
      JSON.stringify({ error: "runId (positive integer) required" }),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
  }

  const state = (body.state === "failed" || body.state === "stopped" ? body.state : "succeeded") as CrawlState;
  const existing = getCrawlRun(db, runId);
  if (!existing) {
    return new Response(
      JSON.stringify({ error: `unknown crawl run ${runId}` }),
      { status: 404, headers: { "Content-Type": "application/json" } },
    );
  }
  // A terminal state is final — a late duplicate report must not overwrite it.
  if (existing.state !== "running") {
    return new Response(
      JSON.stringify({ accepted: false, reason: `run already ${existing.state}` }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  const vmMinutes =
    body.stats && typeof body.stats === "object" && typeof (body.stats as any).vmMinutes === "number"
      ? Number((body.stats as any).vmMinutes)
      : existing.vm_minutes ?? null;

  const updated = updateCrawlRun(db, runId, {
    finished_at: new Date().toISOString(),
    state,
    vm_minutes: vmMinutes,
    stats: JSON.stringify(body.stats ?? null),
  });

  return new Response(
    JSON.stringify({ accepted: updated, runId, state }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}
