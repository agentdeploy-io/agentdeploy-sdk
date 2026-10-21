import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { handleInboundSync } from "../../routes/inbound-sync.js";
import { runMigrations, getWatermark, getLead, listLeads } from "../../db/index.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeSyncLead(overrides: Partial<Lead> = {}): Lead {
  return {
    key: "uk/12345",
    country: "uk",
    name: "Acme Design Ltd",
    reg_number: "12345678",
    sic: "62012",
    sic_label: "Business and domestic software development",
    incorporated: "2020-01-15",
    address: "123 High Street",
    city: "London",
    website: "https://acmedesign.co.uk",
    website_status: "verified",
    source: "companies-house",
    source_url: "https://find-and-update.company-information.service.gov.uk/company/12345678",
    stage: "raw",
    status: "pending_review",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  };
}

async function postSyncBatch(
  db: DatabaseType.Database,
  leads: Lead[],
  syncSecret = "test-secret-123"
): Promise<Response> {
  const request = new Request("http://localhost/inbound/sync", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AD-Sync": syncSecret,
    },
    body: JSON.stringify({ leads }),
  });

  const env = { AD_SYNC_SECRET: syncSecret };
  return handleInboundSync(request, env, db);
}

describe("sync-pipeline integration", () => {
  let db: DatabaseType.Database;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => {
    db.close();
  });

  it("accepts a valid sync batch and upserts leads", async () => {
    const leads = [
      makeSyncLead({ key: "uk/001", name: "Alpha Ltd" }),
      makeSyncLead({ key: "uk/002", name: "Beta Ltd" }),
      makeSyncLead({ key: "uk/003", name: "Gamma Ltd" }),
    ];

    const response = await postSyncBatch(db, leads);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.accepted).toBe(3);
    expect(body.batch_size).toBe(3);
    expect(body.watermark).toBeGreaterThan(0);

    const lead1 = getLead(db, "uk/001");
    expect(lead1).toBeDefined();
    expect(lead1?.name).toBe("Alpha Ltd");
    expect(lead1?.stage).toBe("raw");

    const lead2 = getLead(db, "uk/002");
    expect(lead2?.name).toBe("Beta Ltd");

    const lead3 = getLead(db, "uk/003");
    expect(lead3?.name).toBe("Gamma Ltd");
  });

  it("advances watermark after successful sync", async () => {
    const initialWatermark = getWatermark(db);
    expect(initialWatermark.last_rowid).toBe(0);

    const leads = [makeSyncLead({ key: "uk/100" })];
    await postSyncBatch(db, leads);

    const updatedWatermark = getWatermark(db);
    expect(updatedWatermark.last_rowid).toBeGreaterThan(0);
    expect(updatedWatermark.last_synced_at).toBeTruthy();
  });

  it("handles idempotent upsert — no duplicates on overlapping keys", async () => {
    const batch1 = [
      makeSyncLead({ key: "uk/200", name: "First Version" }),
      makeSyncLead({ key: "uk/201", name: "Unique Lead" }),
    ];

    await postSyncBatch(db, batch1);

    const count1 = listLeads(db, { page: 1, pageSize: 100 });
    expect(count1.total).toBe(2);

    const batch2 = [
      makeSyncLead({ key: "uk/200", name: "Updated Version" }),
      makeSyncLead({ key: "uk/202", name: "New Lead" }),
    ];

    await postSyncBatch(db, batch2);

    const count2 = listLeads(db, { page: 1, pageSize: 100 });
    expect(count2.total).toBe(3);

    const updated = getLead(db, "uk/200");
    expect(updated?.name).toBe("Updated Version");

    const unique = getLead(db, "uk/201");
    expect(unique?.name).toBe("Unique Lead");

    const newLead = getLead(db, "uk/202");
    expect(newLead?.name).toBe("New Lead");
  });

  it("transitions stage from raw to verified on second sync with updated data", async () => {
    const rawLead = makeSyncLead({
      key: "uk/300",
      stage: "raw",
      website_status: "candidate",
    });

    await postSyncBatch(db, [rawLead]);

    const lead1 = getLead(db, "uk/300");
    expect(lead1?.stage).toBe("raw");
    expect(lead1?.website_status).toBe("candidate");

    const verifiedLead = makeSyncLead({
      key: "uk/300",
      stage: "verified",
      website_status: "verified",
      score: 85,
    });

    await postSyncBatch(db, [verifiedLead]);

    const lead2 = getLead(db, "uk/300");
    expect(lead2?.stage).toBe("verified");
    expect(lead2?.website_status).toBe("verified");
  });

  it("rejects request with invalid sync secret", async () => {
    const leads = [makeSyncLead({ key: "uk/400" })];

    const request = new Request("http://localhost/inbound/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AD-Sync": "wrong-secret",
      },
      body: JSON.stringify({ leads }),
    });

    const env = { AD_SYNC_SECRET: "correct-secret" };
    const response = await handleInboundSync(request, env, db);

    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error).toMatch(/invalid sync secret/i);

    const count = listLeads(db, { page: 1, pageSize: 100 });
    expect(count.total).toBe(0);
  });

  it("rejects request with missing leads array", async () => {
    const request = new Request("http://localhost/inbound/sync", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-AD-Sync": "test-secret",
      },
      body: JSON.stringify({ notLeads: [] }),
    });

    const env = { AD_SYNC_SECRET: "test-secret" };
    const response = await handleInboundSync(request, env, db);

    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatch(/leads\[\] required/i);
  });

  it("limits batch size to MAX_BATCH (25)", async () => {
    const leads = Array.from({ length: 30 }, (_, i) =>
      makeSyncLead({ key: `uk/${500 + i}`, name: `Lead ${i}` })
    );

    const response = await postSyncBatch(db, leads);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.accepted).toBe(25);
    expect(body.batch_size).toBe(25);

    const count = listLeads(db, { page: 1, pageSize: 100 });
    expect(count.total).toBe(25);
  });

  it("normalizes missing fields to defaults", async () => {
    const minimalLead = {
      key: "uk/600",
      country: "uk",
      name: "Minimal Lead",
    };

    await postSyncBatch(db, [minimalLead as Lead]);

    const lead = getLead(db, "uk/600");
    expect(lead).toBeDefined();
    expect(lead?.stage).toBe("raw");
    expect(lead?.status).toBe("pending_review");
    expect(lead?.website_status).toBe("none");
    expect(lead?.source).toBe("sync");
    expect(lead?.created_at).toBeTruthy();
    expect(lead?.updated_at).toBeTruthy();
    expect(lead?.last_sync_at).toBeTruthy();
  });

  it("replaces entire row on re-sync (INSERT OR REPLACE semantics)", async () => {
    const fullLead = makeSyncLead({
      key: "uk/700",
      name: "Full Lead",
      emails: JSON.stringify([{ addr: "test@example.com", kind: "role" }]),
      phones: JSON.stringify(["+44 20 1234 5678"]),
      stage: "verified",
    });

    await postSyncBatch(db, [fullLead]);

    const partialUpdate = makeSyncLead({
      key: "uk/700",
      name: "Updated Name",
      stage: "classified",
    });

    await postSyncBatch(db, [partialUpdate]);

    const lead = getLead(db, "uk/700");
    expect(lead?.name).toBe("Updated Name");
    expect(lead?.stage).toBe("classified");
    expect(lead?.emails).toBeNull();
    expect(lead?.phones).toBeNull();
  });
});
