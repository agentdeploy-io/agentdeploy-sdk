import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead } from "../../db/index.js";
import { handleDataApi } from "../../routes/data-api.js";
import type { Lead } from "../../db/types.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function seedLeads(db: DatabaseType.Database): void {
  const stages = ["raw", "verified", "classified", "researched", "approved", "sent", "replied"];
  const countries = ["uk", "fr", "ie"];

  for (let i = 0; i < 50; i++) {
    const stage = stages[i % stages.length];
    const country = countries[i % countries.length];
    const tier = i % 3 === 0 ? "HOT" : i % 3 === 1 ? "WARM" : "COLD";

    upsertLead(db, {
      key: `${country}/${String(i).padStart(4, "0")}`,
      country,
      name: `Company ${i} Ltd`,
      reg_number: `REG${String(i).padStart(6, "0")}`,
      sic: i % 2 === 0 ? "62012" : "70229",
      sic_label: i % 2 === 0 ? "Software development" : "Management consultancy",
      incorporated: `202${i % 5}-0${(i % 9) + 1}-15`,
      address: `${i} High Street`,
      city: country === "uk" ? "London" : country === "fr" ? "Paris" : "Dublin",
      website: `https://company${i}.example.com`,
      website_status: stage === "raw" ? "candidate" : "verified",
      stage: stage as Lead["stage"],
      classification: stage !== "raw"
        ? JSON.stringify({ tier, fit: 50 + i, vertical: "Digital", signals: [], reasoning: "" })
        : null,
      status: stage === "approved" || stage === "sent" ? "approved" : "pending_review",
      emails: stage !== "raw"
        ? JSON.stringify([{ addr: `contact@company${i}.example.com`, kind: "role", mx_ok: true }])
        : null,
      source: "test-seed",
      created_at: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T10:00:00Z`,
      updated_at: `2025-01-${String((i % 28) + 1).padStart(2, "0")}T12:00:00Z`,
    });
  }
}

function makeRequest(method: string, path: string, body?: unknown): Request {
  const url = `http://localhost${path}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json" },
  };
  if (body) opts.body = JSON.stringify(body);
  return new Request(url, opts);
}

describe("data-api integration", () => {
  let db: DatabaseType.Database;
  const env: Record<string, unknown> = {};

  beforeEach(() => {
    db = createTestDb();
    seedLeads(db);
  });

  afterEach(() => {
    db.close();
  });

  describe("GET /cmd/data — list leads", () => {
    it("returns paginated leads", async () => {
      const req = makeRequest("GET", "/cmd/data?page=1&pageSize=10");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.rows).toHaveLength(10);
      expect(body.total).toBe(50);
      expect(body.page).toBe(1);
      expect(body.pageSize).toBe(10);
    });

    it("filters by stage", async () => {
      const req = makeRequest("GET", "/cmd/data?stage=raw");
      const res = await handleDataApi(req, env, db);
      const body = await res.json();

      expect(body.rows.every((r: Lead) => r.stage === "raw")).toBe(true);
      expect(body.total).toBeGreaterThan(0);
    });

    it("filters by country", async () => {
      const req = makeRequest("GET", "/cmd/data?country=uk");
      const res = await handleDataApi(req, env, db);
      const body = await res.json();

      expect(body.rows.every((r: Lead) => r.country === "uk")).toBe(true);
      expect(body.total).toBeGreaterThan(0);
    });

    it("filters by tier", async () => {
      const req = makeRequest("GET", "/cmd/data?tier=HOT");
      const res = await handleDataApi(req, env, db);
      const body = await res.json();

      expect(body.total).toBeGreaterThan(0);
      for (const row of body.rows) {
        const cls = JSON.parse(row.classification);
        expect(cls.tier).toBe("HOT");
      }
    });

    it("returns page 2 correctly", async () => {
      const req1 = makeRequest("GET", "/cmd/data?page=1&pageSize=10");
      const res1 = await handleDataApi(req1, env, db);
      const page1 = await res1.json();

      const req2 = makeRequest("GET", "/cmd/data?page=2&pageSize=10");
      const res2 = await handleDataApi(req2, env, db);
      const page2 = await res2.json();

      expect(page2.rows).toHaveLength(10);
      expect(page2.page).toBe(2);

      const page1Keys = new Set(page1.rows.map((r: Lead) => r.key));
      const page2Keys = new Set(page2.rows.map((r: Lead) => r.key));
      for (const key of page2Keys) {
        expect(page1Keys.has(key)).toBe(false);
      }
    });

    it("filters by status", async () => {
      const req = makeRequest("GET", "/cmd/data?status=approved");
      const res = await handleDataApi(req, env, db);
      const body = await res.json();

      expect(body.rows.every((r: Lead) => r.status === "approved")).toBe(true);
    });

    it("returns empty for non-matching filter", async () => {
      const req = makeRequest("GET", "/cmd/data?country=zz");
      const res = await handleDataApi(req, env, db);
      const body = await res.json();

      expect(body.rows).toHaveLength(0);
      expect(body.total).toBe(0);
    });
  });

  describe("GET /cmd/data/row — get single lead", () => {
    it("returns a specific lead by key", async () => {
      const req = makeRequest("GET", "/cmd/data/row?key=uk/0000");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const lead = await res.json();
      expect(lead.key).toBe("uk/0000");
      expect(lead.country).toBe("uk");
      expect(lead.name).toBe("Company 0 Ltd");
    });

    it("returns 404 for unknown key", async () => {
      const req = makeRequest("GET", "/cmd/data/row?key=xx/9999");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(404);
    });

    it("returns 400 if key parameter missing", async () => {
      const req = makeRequest("GET", "/cmd/data/row");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /cmd/data/row — inline edit", () => {
    it("updates a lead field", async () => {
      const req = makeRequest("POST", "/cmd/data/row", {
        key: "uk/0000",
        patch: { name: "Updated Company Name", city: "Manchester" },
      });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.updated).toBe(true);

      const getReq = makeRequest("GET", "/cmd/data/row?key=uk/0000");
      const getRes = await handleDataApi(getReq, env, db);
      const lead = await getRes.json();
      expect(lead.name).toBe("Updated Company Name");
      expect(lead.city).toBe("Manchester");
    });

    it("updates stage", async () => {
      const req = makeRequest("POST", "/cmd/data/row", {
        key: "uk/0000",
        patch: { stage: "verified", status: "approved" },
      });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const getReq = makeRequest("GET", "/cmd/data/row?key=uk/0000");
      const getRes = await handleDataApi(getReq, env, db);
      const lead = await getRes.json();
      expect(lead.stage).toBe("verified");
      expect(lead.status).toBe("approved");
    });

    it("returns 400 if key or patch missing", async () => {
      const req = makeRequest("POST", "/cmd/data/row", { key: "uk/0000" });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(400);
    });
  });

  describe("POST /cmd/data/batch — bulk operations", () => {
    it("bulk approve leads", async () => {
      const keys = ["uk/0000", "uk/0003", "uk/0006"];
      const req = makeRequest("POST", "/cmd/data/batch", {
        keys,
        patch: { status: "approved", stage: "approved" },
      });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.updated).toBe(3);

      for (const key of keys) {
        const getReq = makeRequest("GET", `/cmd/data/row?key=${key}`);
        const getRes = await handleDataApi(getReq, env, db);
        const lead = await getRes.json();
        expect(lead.status).toBe("approved");
        expect(lead.stage).toBe("approved");
      }
    });

    it("returns 400 if keys or patch missing", async () => {
      const req = makeRequest("POST", "/cmd/data/batch", { keys: ["uk/0000"] });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(400);
    });

    it("handles empty keys array", async () => {
      const req = makeRequest("POST", "/cmd/data/batch", {
        keys: [],
        patch: { status: "approved" },
      });
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.updated).toBe(0);
    });
  });

  describe("GET /cmd/pipeline — stage counts", () => {
    it("returns correct stage counts", async () => {
      const req = makeRequest("GET", "/cmd/pipeline");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);

      const body = await res.json();
      expect(body.stages).toBeDefined();
      expect(body.funnel).toBeDefined();
      expect(body.total).toBe(50);

      expect(Array.isArray(body.funnel)).toBe(true);
      const stageNames = body.funnel.map((f: { stage: string }) => f.stage);
      expect(stageNames).toContain("raw");
      expect(stageNames).toContain("verified");
      expect(stageNames).toContain("classified");

      const totalFromFunnel = body.funnel.reduce(
        (sum: number, f: { count: number }) => sum + f.count,
        0
      );
      expect(totalFromFunnel).toBe(50);
    });
  });

  describe("GET /cmd/data/export — CSV export", () => {
    it("returns valid CSV with headers", async () => {
      const req = makeRequest("GET", "/cmd/data/export");
      const res = await handleDataApi(req, env, db);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/csv");

      const csv = await res.text();
      const lines = csv.split("\r\n").filter(Boolean);
      expect(lines.length).toBeGreaterThan(1);

      const header = lines[0];
      expect(header).toContain("key");
      expect(header).toContain("country");
      expect(header).toContain("name");
      expect(header).toContain("stage");
      expect(header).toContain("status");

      expect(lines.length - 1).toBe(50);
    });

    it("filters exported CSV by stage", async () => {
      const req = makeRequest("GET", "/cmd/data/export?stage=raw");
      const res = await handleDataApi(req, env, db);
      const csv = await res.text();
      const lines = csv.split("\r\n").filter(Boolean);

      expect(lines.length).toBeGreaterThan(1);
      for (let i = 1; i < lines.length; i++) {
        expect(lines[i]).toContain(",raw,");
      }
    });

    it("properly escapes CSV fields with commas", async () => {
      upsertLead(db, {
        key: "uk/special",
        country: "uk",
        name: 'Company "with, commas" Ltd',
        stage: "raw",
        status: "pending_review",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const req = makeRequest("GET", "/cmd/data/export?stage=raw");
      const res = await handleDataApi(req, env, db);
      const csv = await res.text();
      expect(csv).toContain('""with, commas""');
    });
  });
});
