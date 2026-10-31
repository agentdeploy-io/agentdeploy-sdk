import { describe, it, expect, beforeEach } from "vitest";

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead, logReply, updateReplyDraft } from "../../db/index.js";
import { handleDataApi } from "../../routes/data-api.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeLead(d: DatabaseType.Database): Lead {
  const lead: Lead = {
    key: "uk/history-test",
    country: "UK",
    name: "History Test Ltd",
    website: "https://historytest.co.uk",
    emails: JSON.stringify([{ address: "owner@historytest.co.uk", kind: "role", mx_ok: true }]),
    stage: "sent",
    status: "sent",
    pitch_subject: "Missed calls = missed jobs",
    pitch_body: "Hi...",
    created_at: "2026-10-01T00:00:00Z",
    updated_at: "2026-10-20T00:00:00Z",
  };
  upsertLead(d, lead);
  return lead;
}

async function getReplies(
  db: DatabaseType.Database,
  status: string | undefined,
): Promise<Record<string, unknown>> {
  const url = status ? `/cmd/replies?status=${status}` : "/cmd/replies";
  const req = new Request(`http://x${url}`);
  const res = await handleDataApi(req, {}, db);
  return res.json() as Promise<Record<string, unknown>>;
}

describe("GET /cmd/replies history (status=resolved)", () => {
  let db: DatabaseType.Database;
  beforeEach(() => {
    db = createTestDb();
    makeLead(db);

    const pendingId = logReply(db, {
      lead_key: "uk/history-test",
      reply_from: "owner@historytest.co.uk",
      reply_subject: "Re: Missed calls = missed jobs",
      reply_body: "still waiting",
      intent: "question",
      draft: "pending draft text",
      draft_status: "pending",
      at: "2026-10-31T01:00:00Z",
    });
    const sentId = logReply(db, {
      lead_key: "uk/history-test",
      reply_from: "owner@historytest.co.uk",
      reply_subject: "Re: Missed calls = missed jobs",
      reply_body: "the sent one",
      intent: "interested",
      draft: "sent draft text",
      draft_status: "pending",
      at: "2026-10-31T02:00:00Z",
    });
    const discardedId = logReply(db, {
      lead_key: "uk/history-test",
      reply_from: "owner@historytest.co.uk",
      reply_subject: "Re: Missed calls = missed jobs",
      reply_body: "the discarded one",
      intent: "not_interested",
      draft: "discarded draft text",
      draft_status: "pending",
      at: "2026-10-31T03:00:00Z",
    });
    updateReplyDraft(db, sentId, "sent draft text", "sent");
    updateReplyDraft(db, discardedId, "discarded draft text", "discarded");
    expect(pendingId).toBeGreaterThan(0);
  });

  it("status=pending returns only pending drafts", async () => {
    const out = await getReplies(db, "pending");
    const replies = out.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0].draft_status).toBe("pending");
    expect(replies[0].lead_name).toBe("History Test Ltd");
  });

  it("status=resolved returns sent + discarded drafts, not pending", async () => {
    const out = await getReplies(db, "resolved");
    const replies = out.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(2);
    const statuses = replies.map((r) => r.draft_status).sort();
    expect(statuses).toEqual(["discarded", "sent"]);
  });

  it("status=sent returns only sent drafts", async () => {
    const out = await getReplies(db, "sent");
    const replies = out.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0].draft).toBe("sent draft text");
  });

  it("no status defaults to pending", async () => {
    const out = await getReplies(db, undefined);
    const replies = out.replies as Array<Record<string, unknown>>;
    expect(replies).toHaveLength(1);
    expect(replies[0].draft_status).toBe("pending");
  });
});
