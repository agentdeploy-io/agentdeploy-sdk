import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { runMigrations, upsertLead, getLead, setSetting, listLeads } from "../../db/index.js";
import type { Lead } from "../../db/types.js";

vi.mock("../../agents/qualifier.js", () => ({
  classifyBatch: vi.fn(async (db: any, leads: any[]) => {
    const results = [];
    for (const lead of leads) {
      const tier = lead.sic === "62012" ? "HOT" : lead.sic === "70229" ? "WARM" : "COLD";
      const fit = tier === "HOT" ? 90 : tier === "WARM" ? 60 : 20;
      const classification = {
        key: lead.key,
        vertical: "Digital Agency",
        vertical_detail: "Web development and design",
        fit,
        tier,
        language: lead.country.toLowerCase(),
        signals: ["SIC match", "website verified"],
        reasoning: `Classified as ${tier} based on SIC ${lead.sic}`,
      };
      db.prepare("UPDATE leads SET stage = ?, classification = ? WHERE key = ?").run(
        "classified",
        JSON.stringify(classification),
        lead.key
      );
      results.push(classification);
    }
    return results;
  }),
}));

vi.mock("../../agents/researcher.js", () => ({
  runResearcher: vi.fn(async (db: any, lead: any) => {
    const evidence = {
      services: ["web design", "SEO", "digital marketing"],
      team: ["Team of 8 designers and developers"],
      techStack: ["WordPress", "React", "Node"],
      clients: ["Local businesses", "e-commerce stores"],
      news: [],
      snippets: [`Found info about ${lead.name} online`],
    };
    db.prepare("UPDATE leads SET stage = ?, research = ? WHERE key = ?").run(
      "researched",
      JSON.stringify(evidence),
      lead.key
    );
    return evidence;
  }),
}));

vi.mock("../../agents/writer.js", () => ({
  runWriter: vi.fn(async (db: any, lead: any, evidence: unknown) => {
    const output = {
      ai_agents_needed: [
        {
          agent: "Intake Bot",
          purpose: "Automate lead capture",
          pain_point: "Manual lead handling",
          priority: "high",
          evidenceRef: "team",
        },
      ],
      pitch_angle: "Automate your intake process",
      confidence: 75,
      pitch_subject: "Quick question about your lead process",
      pitch_body: `Hi, I noticed ${lead.name} is growing fast. We help agencies like yours automate intake so no lead slips through. Worth a 15-min chat?`,
    };
    db.prepare("UPDATE leads SET pitch_subject = ?, pitch_body = ? WHERE key = ?").run(
      output.pitch_subject,
      output.pitch_body,
      lead.key
    );
    return output;
  }),
}));

import { researchCron } from "../../cron/research.js";
import { classifyBatch } from "../../agents/qualifier.js";
import { runResearcher } from "../../agents/researcher.js";
import { runWriter } from "../../agents/writer.js";

function createTestDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function seedRawLeads(db: DatabaseType.Database, count: number, startIdx = 0): void {
  for (let i = 0; i < count; i++) {
    upsertLead(db, {
      key: `raw/${startIdx + i}`,
      country: "uk",
      name: `Raw Lead ${startIdx + i}`,
      sic: "62012",
      website: `https://rawlead${startIdx + i}.co.uk`,
      stage: "raw",
      status: "pending_review",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

function seedClassifiedLeads(
  db: DatabaseType.Database,
  count: number,
  tier: "HOT" | "WARM" | "COLD",
  startIdx = 0
): void {
  for (let i = 0; i < count; i++) {
    const classification = {
      key: `${tier.toLowerCase()}/${startIdx + i}`,
      vertical: "Digital Agency",
      vertical_detail: "Web development",
      fit: tier === "HOT" ? 90 : tier === "WARM" ? 60 : 20,
      tier,
      language: "uk",
      signals: ["SIC match"],
      reasoning: `Classified as ${tier}`,
    };

    upsertLead(db, {
      key: `${tier.toLowerCase()}/${startIdx + i}`,
      country: "uk",
      name: `${tier} Lead ${startIdx + i}`,
      sic: tier === "HOT" ? "62012" : tier === "WARM" ? "70229" : "99999",
      website: `https://${tier.toLowerCase()}lead${startIdx + i}.co.uk`,
      stage: "classified",
      classification: JSON.stringify(classification),
      status: "pending_review",
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  }
}

describe("research-cron integration", () => {
  let db: DatabaseType.Database;
  const env: Record<string, unknown> = {
    JEV_URL: "http://mock-jev.local",
    AD_JEV_URL: "http://mock-jev.local",
    AD_JEV_GATEWAY_KEY: "mock-key",
    BRAVE_API_KEY: "mock-brave-key",
    AD_GATEWAY_API_KEY: "mock-gateway-key",
  };

  beforeEach(() => {
    db = createTestDb();
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it("skips when paused", async () => {
    setSetting(db, "paused", "true");
    seedRawLeads(db, 5);
    seedClassifiedLeads(db, 3, "HOT");

    const result = await researchCron(env, db);

    expect(result.skipped).toBe(true);
    expect(result.classified).toBe(0);
    expect(result.researched).toBe(0);
    expect(classifyBatch).not.toHaveBeenCalled();
    expect(runResearcher).not.toHaveBeenCalled();
  });

  it("classifies raw leads and researches HOT/WARM leads", async () => {
    setSetting(db, "paused", "false");

    seedRawLeads(db, 5);
    seedClassifiedLeads(db, 3, "HOT", 0);
    seedClassifiedLeads(db, 2, "WARM", 0);
    seedClassifiedLeads(db, 1, "COLD", 0);

    const result = await researchCron(env, db);

    expect(result.skipped).toBe(false);
    expect(result.classified).toBe(5);
    expect(classifyBatch).toHaveBeenCalledTimes(1);

    expect(result.researched).toBe(10);
    expect(runResearcher).toHaveBeenCalledTimes(10);

    expect(result.written).toBe(10);
    expect(runWriter).toHaveBeenCalledTimes(10);

    for (let i = 0; i < 5; i++) {
      const lead = getLead(db, `raw/${i}`);
      expect(lead?.stage).toBe("researched");
      expect(lead?.classification).toBeTruthy();
    }

    for (let i = 0; i < 3; i++) {
      const lead = getLead(db, `hot/${i}`);
      expect(lead?.stage).toBe("researched");
      expect(lead?.research).toBeTruthy();
    }

    for (let i = 0; i < 2; i++) {
      const lead = getLead(db, `warm/${i}`);
      expect(lead?.stage).toBe("researched");
      expect(lead?.research).toBeTruthy();
    }
  });

  it("skips COLD leads during research phase", async () => {
    setSetting(db, "paused", "false");

    seedClassifiedLeads(db, 1, "COLD", 0);

    const result = await researchCron(env, db);

    expect(result.classified).toBe(0);
    expect(result.researched).toBe(0);
    expect(runResearcher).not.toHaveBeenCalled();

    const coldLead = getLead(db, "cold/0");
    expect(coldLead?.stage).toBe("classified");
    expect(coldLead?.research).toBeNull();
  });

  it("limits research to top 10 HOT/WARM leads by fit score", async () => {
    setSetting(db, "paused", "false");

    seedClassifiedLeads(db, 8, "HOT", 0);
    seedClassifiedLeads(db, 5, "WARM", 0);

    const result = await researchCron(env, db);

    expect(result.researched).toBe(10);
    expect(runResearcher).toHaveBeenCalledTimes(10);
  });

  it("handles classify failures gracefully", async () => {
    setSetting(db, "paused", "false");
    seedRawLeads(db, 3);

    vi.mocked(classifyBatch).mockRejectedValueOnce(new Error("jev down"));

    const result = await researchCron(env, db);

    expect(result.classified).toBe(0);
    expect(result.researched).toBe(0);
  });

  it("handles researcher failures gracefully — partial success", async () => {
    setSetting(db, "paused", "false");

    seedClassifiedLeads(db, 3, "HOT", 0);

    let callCount = 0;
    vi.mocked(runResearcher).mockImplementation(async (db: DatabaseType.Database, lead: Lead) => {
      callCount++;
      if (callCount === 2) throw new Error("brave timeout");

      const evidence = {
        services: ["web design"],
        team: [],
        techStack: [],
        clients: [],
        news: [],
        snippets: [],
      };
      const { updateLead } = await import("../../db/leads.js");
      updateLead(db, lead.key, { stage: "researched", research: JSON.stringify(evidence) });
      return evidence;
    });

    const result = await researchCron(env, db);

    expect(result.researched).toBe(2);
    expect(runResearcher).toHaveBeenCalledTimes(3);

    const lead0 = getLead(db, "hot/0");
    expect(lead0?.stage).toBe("researched");

    const lead1 = getLead(db, "hot/1");
    expect(lead1?.stage).toBe("classified");

    const lead2 = getLead(db, "hot/2");
    expect(lead2?.stage).toBe("researched");
  });

  it("processes no leads when DB is empty", async () => {
    setSetting(db, "paused", "false");

    const result = await researchCron(env, db);

    expect(result.classified).toBe(0);
    expect(result.researched).toBe(0);
    expect(result.written).toBe(0);
    expect(result.skipped).toBe(false);
  });

  it("handles writer failures as non-fatal", async () => {
    setSetting(db, "paused", "false");

    seedClassifiedLeads(db, 2, "HOT", 0);

    vi.mocked(runWriter).mockRejectedValue(new Error("LLM rate limited"));

    const result = await researchCron(env, db);

    expect(result.researched).toBe(2);
    expect(result.written).toBe(0);
    expect(runResearcher).toHaveBeenCalledTimes(2);
    expect(runWriter).toHaveBeenCalledTimes(2);
  });
});
