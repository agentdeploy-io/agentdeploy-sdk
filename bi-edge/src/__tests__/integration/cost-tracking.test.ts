import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { runMigrations } from "../../db/migrations.js";
import { setSetting, getSetting, getSettingsWithDefaults } from "../../db/settings.js";
import { createCrawlRun, updateCrawlRun, getCrawlRun, listCrawlRuns } from "../../db/crawl-runs.js";
import { upsertLead, getLead, countByStage } from "../../db/leads.js";
import { logSentEmail, countSentToday } from "../../db/sent-log.js";
import { runGateStack } from "../../agents/outreach.js";
import type { Lead, CrawlRun } from "../../db/types.js";

const VM_RATE_PER_MINUTE = 0.002;
const TOKEN_RATE_PER_1K = 0.005;
const JEV_TOKEN_RATE_PER_1K = 0.001;
const MAX_VM_HOURS_PER_DAY = 2;

function createDb(): Database.Database {
  const db = new Database(":memory:");
  runMigrations(db);
  return db;
}

function makeApprovedLead(overrides: Partial<Lead> = {}): Lead {
  return {
    key: "uk/12345",
    country: "uk",
    name: "Acme Ltd",
    stage: "approved",
    status: "approved",
    emails: JSON.stringify([{ addr: "hello@acme.com", kind: "role", source: "web", confidence: 0.9, mx_ok: true }]),
    pitch_subject: "AI intake tool",
    pitch_body: "Hi, we help firms like yours automate intake.",
    ...overrides,
  };
}

function openAllGates(db: Database.Database): void {
  setSetting(db, "paused", "false");
  setSetting(db, "sendEnabled", "true");
  setSetting(db, "dryRun", "true");
  setSetting(db, "dailyCap", "10");
}

function calcVmCost(vmMinutes: number): number {
  return vmMinutes * VM_RATE_PER_MINUTE;
}

function calcTokenCost(tokens: number, ratePer1k: number = TOKEN_RATE_PER_1K): number {
  return (tokens / 1000) * ratePer1k;
}

function getDailyVmBudgetMinutes(): number {
  return MAX_VM_HOURS_PER_DAY * 60;
}

function totalVmMinutesUsed(db: Database.Database): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const row = db.prepare(
    `SELECT COALESCE(SUM(vm_minutes), 0) as total FROM crawl_runs WHERE started_at >= ?`
  ).get(today.toISOString()) as { total: number };
  return row.total;
}

function totalTokensUsed(db: Database.Database): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const row = db.prepare(
    `SELECT COALESCE(SUM(tokens_used), 0) as total FROM crawl_runs WHERE started_at >= ?`
  ).get(today.toISOString()) as { total: number };
  return row.total;
}

function weeklyVmMinutes(db: Database.Database): number {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const row = db.prepare(
    `SELECT COALESCE(SUM(vm_minutes), 0) as total FROM crawl_runs WHERE started_at >= ?`
  ).get(weekAgo.toISOString()) as { total: number };
  return row.total;
}

function weeklyTokens(db: Database.Database): number {
  const weekAgo = new Date();
  weekAgo.setDate(weekAgo.getDate() - 7);
  const row = db.prepare(
    `SELECT COALESCE(SUM(tokens_used), 0) as total FROM crawl_runs WHERE started_at >= ?`
  ).get(weekAgo.toISOString()) as { total: number };
  return row.total;
}

describe("cost tracking: VM-minutes", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("records vm_minutes on a crawl run", () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "running",
    });

    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      vm_minutes: 12.5,
      tokens_used: 50000,
      stats: JSON.stringify({ candidates: 20, verified: 15 }),
    });

    const run = getCrawlRun(db, runId);
    expect(run).toBeDefined();
    expect(run!.vm_minutes).toBe(12.5);
    expect(run!.tokens_used).toBe(50000);
  });

  it("calculates cost correctly from vm_minutes", () => {
    const vmMinutes = 30;
    const cost = calcVmCost(vmMinutes);
    expect(cost).toBeCloseTo(0.06, 6);
  });

  it("tracks cumulative daily vm_minutes across multiple runs", () => {
    for (let i = 0; i < 3; i++) {
      const runId = createCrawlRun(db, {
        started_at: new Date().toISOString(),
        trigger: "cron",
        countries: "uk",
        state: "running",
      });
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "succeeded",
        vm_minutes: 25,
        tokens_used: 10000,
      });
    }

    const totalMinutes = totalVmMinutesUsed(db);
    expect(totalMinutes).toBe(75);
  });

  it("enforces daily VM budget (maxVmHoursPerDay)", () => {
    const budgetMinutes = getDailyVmBudgetMinutes();
    expect(budgetMinutes).toBe(120);

    for (let i = 0; i < 5; i++) {
      const runId = createCrawlRun(db, {
        started_at: new Date().toISOString(),
        trigger: "cron",
        countries: "uk",
        state: "running",
      });
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "succeeded",
        vm_minutes: 30,
      });
    }

    const used = totalVmMinutesUsed(db);
    const overBudget = used > budgetMinutes;
    expect(used).toBe(150);
    expect(overBudget).toBe(true);
  });

  it("does not count runs from yesterday toward today's budget", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);

    const runId = createCrawlRun(db, {
      started_at: yesterday.toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "succeeded",
      vm_minutes: 100,
    });

    const todayUsed = totalVmMinutesUsed(db);
    expect(todayUsed).toBe(0);
  });
});

describe("cost tracking: token usage", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("records tokens_used per crawl run", () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "manual",
      countries: "uk,ie",
      state: "running",
    });

    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      tokens_used: 125000,
    });

    const run = getCrawlRun(db, runId);
    expect(run!.tokens_used).toBe(125000);
  });

  it("calculates token cost correctly", () => {
    const tokens = 250000;
    const cost = calcTokenCost(tokens);
    expect(cost).toBeCloseTo(1.25, 6);
  });

  it("tracks per-lead token attribution via research field", () => {
    const lead: Lead = {
      key: "uk/99001",
      country: "uk",
      name: "Test Corp",
      stage: "researched",
      status: "pending_review",
      research: JSON.stringify({
        services: ["accounting", "tax"],
        team: ["3 partners"],
        techStack: ["Xero"],
        clients: ["SMBs"],
        news: [],
        snippets: ["Full-service accounting firm"],
        tokens_used: 8500,
      }),
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    upsertLead(db, lead);

    const stored = getLead(db, "uk/99001");
    expect(stored).toBeDefined();
    expect(stored!.research).toBeDefined();

    const research = JSON.parse(stored!.research!);
    expect(research.tokens_used).toBe(8500);
  });

  it("enforces daily token budget via settings", () => {
    setSetting(db, "dailyTokenBudget", "500000");
    const budget = Number(getSetting(db, "dailyTokenBudget"));
    expect(budget).toBe(500000);

    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "running",
    });
    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      tokens_used: 600000,
    });

    const used = totalTokensUsed(db);
    expect(used > budget).toBe(true);
  });
});

describe("cost tracking: cost attribution", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
  });

  it("attributes crawl cost to the crawl_runs row", () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "running",
    });

    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      vm_minutes: 45,
      tokens_used: 200000,
      stats: JSON.stringify({ candidates: 50, verified: 30 }),
    });

    const run = getCrawlRun(db, runId);
    const vmCost = calcVmCost(run!.vm_minutes!);
    const tokenCost = calcTokenCost(run!.tokens_used!);
    const totalCost = vmCost + tokenCost;

    expect(vmCost).toBeCloseTo(0.09, 6);
    expect(tokenCost).toBeCloseTo(1.0, 6);
    expect(totalCost).toBeCloseTo(1.09, 6);
  });

  it("attributes research cost per-lead (tokens x model price)", () => {
    const leads: Lead[] = [
      {
        key: "uk/001",
        country: "uk",
        name: "Alpha Accountants",
        stage: "researched",
        status: "pending_review",
        research: JSON.stringify({ services: ["tax"], tokens_used: 5000 }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      {
        key: "uk/002",
        country: "uk",
        name: "Beta Legal",
        stage: "researched",
        status: "pending_review",
        research: JSON.stringify({ services: ["legal"], tokens_used: 7500 }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
    ];

    for (const lead of leads) upsertLead(db, lead);

    let totalResearchCost = 0;
    for (const lead of leads) {
      const stored = getLead(db, lead.key);
      const research = JSON.parse(stored!.research!);
      const leadCost = calcTokenCost(research.tokens_used);
      totalResearchCost += leadCost;
    }

    expect(totalResearchCost).toBeCloseTo(0.0625, 6);
  });

  it("attributes classification cost per-lead (jev tokens)", () => {
    const leads: Lead[] = [];
    for (let i = 0; i < 10; i++) {
      leads.push({
        key: `uk/cls-${i}`,
        country: "uk",
        name: `Company ${i}`,
        stage: "classified",
        status: "pending_review",
        classification: JSON.stringify({
          tier: i < 3 ? "HOT" : "COLD",
          fit: i < 3 ? 85 : 20,
          jev_tokens_used: 1200,
        }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }
    for (const lead of leads) upsertLead(db, lead);

    let totalJevTokens = 0;
    for (const lead of leads) {
      const stored = getLead(db, lead.key);
      const cls = JSON.parse(stored!.classification!);
      totalJevTokens += cls.jev_tokens_used ?? 0;
    }

    const jevCost = calcTokenCost(totalJevTokens, JEV_TOKEN_RATE_PER_1K);
    expect(totalJevTokens).toBe(12000);
    expect(jevCost).toBeCloseTo(0.012, 6);
  });

  it("simulates a full crawl + research cycle with cost accumulation", () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "running",
    });

    for (let i = 0; i < 5; i++) {
      upsertLead(db, {
        key: `uk/full-${i}`,
        country: "uk",
        name: `Biz ${i}`,
        stage: "researched",
        status: "pending_review",
        classification: JSON.stringify({ tier: "HOT", fit: 80, jev_tokens_used: 1500 }),
        research: JSON.stringify({ services: ["consulting"], tokens_used: 6000 }),
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      vm_minutes: 20,
      tokens_used: 100000,
      stats: JSON.stringify({ candidates: 5, verified: 5, synced: 5 }),
    });

    const crawlVmCost = calcVmCost(20);
    const crawlTokenCost = calcTokenCost(100000);

    let researchCost = 0;
    let classificationCost = 0;
    for (let i = 0; i < 5; i++) {
      const lead = getLead(db, `uk/full-${i}`);
      const research = JSON.parse(lead!.research!);
      const cls = JSON.parse(lead!.classification!);
      researchCost += calcTokenCost(research.tokens_used);
      classificationCost += calcTokenCost(cls.jev_tokens_used, JEV_TOKEN_RATE_PER_1K);
    }

    const totalCost = crawlVmCost + crawlTokenCost + researchCost + classificationCost;

    expect(crawlVmCost).toBeCloseTo(0.04, 6);
    expect(crawlTokenCost).toBeCloseTo(0.5, 6);
    expect(researchCost).toBeCloseTo(0.15, 6);
    expect(classificationCost).toBeCloseTo(0.0075, 6);
    expect(totalCost).toBeCloseTo(0.6975, 6);
  });
});

describe("cost tracking: cost reporting via pipeline", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createDb();
    openAllGates(db);
  });

  it("pipeline returns stage counts for cost-per-lead calculation", () => {
    for (let i = 0; i < 10; i++) {
      upsertLead(db, {
        key: `uk/pipe-${i}`,
        country: "uk",
        name: `Pipeline Co ${i}`,
        stage: i < 3 ? "raw" : i < 7 ? "classified" : "approved",
        status: i >= 7 ? "approved" : "pending_review",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const counts = countByStage(db);
    expect(counts["raw"]).toBe(3);
    expect(counts["classified"]).toBe(4);
    expect(counts["approved"]).toBe(3);

    const totalLeads = Object.values(counts).reduce((a, b) => a + b, 0);
    expect(totalLeads).toBe(10);
  });

  it("calculates cost-per-lead from crawl run + pipeline data", () => {
    const runId = createCrawlRun(db, {
      started_at: new Date().toISOString(),
      trigger: "cron",
      countries: "uk",
      state: "running",
    });
    updateCrawlRun(db, runId, {
      finished_at: new Date().toISOString(),
      state: "succeeded",
      vm_minutes: 30,
      tokens_used: 150000,
      stats: JSON.stringify({ candidates: 20, verified: 15, synced: 10 }),
    });

    for (let i = 0; i < 10; i++) {
      upsertLead(db, {
        key: `uk/cpl-${i}`,
        country: "uk",
        name: `CPL Co ${i}`,
        stage: "approved",
        status: "approved",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    const run = getCrawlRun(db, runId);
    const crawlCost = calcVmCost(run!.vm_minutes!) + calcTokenCost(run!.tokens_used!);
    const counts = countByStage(db);
    const approvedCount = counts["approved"] ?? 0;
    const costPerLead = approvedCount > 0 ? crawlCost / approvedCount : 0;

    expect(approvedCount).toBe(10);
    expect(crawlCost).toBeCloseTo(0.81, 6);
    expect(costPerLead).toBeCloseTo(0.081, 6);
  });

  it("daily cost rollup sums vm + token costs", () => {
    for (let i = 0; i < 4; i++) {
      const runId = createCrawlRun(db, {
        started_at: new Date().toISOString(),
        trigger: "cron",
        countries: "uk",
        state: "running",
      });
      updateCrawlRun(db, runId, {
        finished_at: new Date().toISOString(),
        state: "succeeded",
        vm_minutes: 10,
        tokens_used: 25000,
      });
    }

    const dailyVm = totalVmMinutesUsed(db);
    const dailyTokens = totalTokensUsed(db);
    const dailyCost = calcVmCost(dailyVm) + calcTokenCost(dailyTokens);

    expect(dailyVm).toBe(40);
    expect(dailyTokens).toBe(100000);
    expect(dailyCost).toBeCloseTo(0.58, 6);
  });

  it("weekly cost rollup aggregates 7 days", () => {
    for (let d = 0; d < 7; d++) {
      const date = new Date();
      date.setDate(date.getDate() - d);
      const runId = createCrawlRun(db, {
        started_at: date.toISOString(),
        trigger: "cron",
        countries: "uk",
        state: "succeeded",
        vm_minutes: 15,
        tokens_used: 50000,
      });
    }

    const wkVm = weeklyVmMinutes(db);
    const wkTokens = weeklyTokens(db);
    const wkCost = calcVmCost(wkVm) + calcTokenCost(wkTokens);

    expect(wkVm).toBe(105);
    expect(wkTokens).toBe(350000);
    expect(wkCost).toBeCloseTo(1.96, 6);
  });

  it("cost fields are queryable from listCrawlRuns", () => {
    for (let i = 0; i < 3; i++) {
      createCrawlRun(db, {
        started_at: new Date().toISOString(),
        trigger: "cron",
        countries: "uk",
        state: "succeeded",
        vm_minutes: 5 + i * 10,
        tokens_used: 10000 + i * 50000,
      });
    }

    const runs = listCrawlRuns(db, 10);
    expect(runs.length).toBe(3);

    let totalCost = 0;
    for (const run of runs) {
      totalCost += calcVmCost(run.vm_minutes ?? 0) + calcTokenCost(run.tokens_used ?? 0);
    }
    expect(totalCost).toBeGreaterThan(0);
  });
});

describe("cost tracking: gate-stack budget enforcement", () => {
  let db: Database.Database;
  const env: Record<string, unknown> = { BRAND_NAME: "TestBrand" };

  beforeEach(() => {
    db = createDb();
    openAllGates(db);
  });

  it("daily cap on sends acts as a cost limiter", () => {
    setSetting(db, "dailyCap", "2");

    logSentEmail(db, {
      lead_key: "uk/sent-1",
      email: "a@test.com",
      subject: "test",
      message_id: null,
      status: "sent",
      at: new Date().toISOString(),
    });
    logSentEmail(db, {
      lead_key: "uk/sent-2",
      email: "b@test.com",
      subject: "test",
      message_id: null,
      status: "sent",
      at: new Date().toISOString(),
    });

    expect(countSentToday(db)).toBe(2);

    const lead = makeApprovedLead({ key: "uk/over-cap" });
    const result = runGateStack(db, lead, env);
    expect(result.proceed).toBe(false);
    expect(result.reason).toMatch(/daily cap/);
  });

  it("dryRun=true generates zero send cost", () => {
    setSetting(db, "dryRun", "true");
    const lead = makeApprovedLead();
    const result = runGateStack(db, lead, env);

    expect(result.proceed).toBe(true);
    expect(result.dryRun).toBe(true);
    expect(result.email).toBe("");
    expect(result.statusStr).toBe("dry-run");
  });
});
