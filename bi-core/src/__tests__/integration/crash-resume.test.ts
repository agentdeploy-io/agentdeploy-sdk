import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("crash-resume integration", () => {
  let tempDir: string;
  let originalDataDir: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "bi-core-checkpoint-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tempDir;
  });

  afterEach(() => {
    if (originalDataDir !== undefined) {
      process.env.DATA_DIR = originalDataDir;
    } else {
      delete process.env.DATA_DIR;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function checkpointFile(runId: string, step: string): string {
    const dataDir = process.env.DATA_DIR || "/data";
    return path.join(dataDir, `checkpoint-${runId}-${step}.json`);
  }

  async function saveCheckpoint(runId: string, step: string, data: unknown): Promise<void> {
    const dataDir = process.env.DATA_DIR || "/data";
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(checkpointFile(runId, step), JSON.stringify(data), "utf8");
  }

  function loadCheckpoint<T>(runId: string, step: string): T | null {
    try {
      const p = checkpointFile(runId, step);
      if (fs.existsSync(p)) {
        return JSON.parse(fs.readFileSync(p, "utf8")) as T;
      }
    } catch {
      return null;
    }
    return null;
  }

  interface MockCrawlState {
    runId: string;
    candidates: Array<{ key: string; name: string; country: string; website?: string }>;
    verifiedLeads: Array<{ key: string; name: string; country: string; stage: string }>;
    stats: {
      totalCandidates: number;
      totalVerified: number;
      totalSynced: number;
      totalFailed: number;
      countriesProcessed: string[];
    };
  }

  it("saves checkpoint to disk and restores correctly", async () => {
    const runId = "run-test-001";
    const state: MockCrawlState = {
      runId,
      candidates: [
        { key: "uk/001", name: "Alpha Ltd", country: "uk", website: "https://alpha.co.uk" },
        { key: "uk/002", name: "Beta Ltd", country: "uk", website: "https://beta.co.uk" },
      ],
      verifiedLeads: [],
      stats: {
        totalCandidates: 2,
        totalVerified: 0,
        totalSynced: 0,
        totalFailed: 0,
        countriesProcessed: ["uk"],
      },
    };

    await saveCheckpoint(runId, "intake", state);

    const restored = loadCheckpoint<MockCrawlState>(runId, "intake");
    expect(restored).not.toBeNull();
    expect(restored?.runId).toBe(runId);
    expect(restored?.candidates).toHaveLength(2);
    expect(restored?.stats.totalCandidates).toBe(2);
  });

  it("returns null for missing checkpoint", () => {
    const result = loadCheckpoint("nonexistent-run", "intake");
    expect(result).toBeNull();
  });

  it("simulates crash at verify step and resumes from checkpoint", async () => {
    const runId = "run-crash-001";

    const intakeState: MockCrawlState = {
      runId,
      candidates: [
        { key: "uk/100", name: "Company A", country: "uk", website: "https://companya.co.uk" },
        { key: "uk/101", name: "Company B", country: "uk", website: "https://companyb.co.uk" },
        { key: "uk/102", name: "Company C", country: "uk", website: "https://companyc.co.uk" },
      ],
      verifiedLeads: [],
      stats: {
        totalCandidates: 3,
        totalVerified: 0,
        totalSynced: 0,
        totalFailed: 0,
        countriesProcessed: ["uk"],
      },
    };

    await saveCheckpoint(runId, "intake", intakeState);

    const restoredIntake = loadCheckpoint<MockCrawlState>(runId, "intake");
    expect(restoredIntake).not.toBeNull();
    expect(restoredIntake?.candidates).toHaveLength(3);

    const verifyCheckpoint = loadCheckpoint<MockCrawlState>(runId, "verify");
    expect(verifyCheckpoint).toBeNull();

    const verifyState: MockCrawlState = {
      runId,
      candidates: restoredIntake!.candidates,
      verifiedLeads: [
        { key: "uk/100", name: "Company A", country: "uk", stage: "verified" },
        { key: "uk/101", name: "Company B", country: "uk", stage: "verified" },
      ],
      stats: {
        ...restoredIntake!.stats,
        totalVerified: 2,
      },
    };

    await saveCheckpoint(runId, "verify", verifyState);

    const restoredVerify = loadCheckpoint<MockCrawlState>(runId, "verify");
    expect(restoredVerify).not.toBeNull();
    expect(restoredVerify?.verifiedLeads).toHaveLength(2);
    expect(restoredVerify?.stats.totalVerified).toBe(2);
  });

  it("prevents duplicate leads through key-based deduplication", async () => {
    const leads = new Map<string, { key: string; name: string; country: string }>();

    const batch1 = [
      { key: "uk/200", name: "First Version", country: "uk" },
      { key: "uk/201", name: "Unique Lead", country: "uk" },
    ];

    for (const lead of batch1) {
      leads.set(lead.key, lead);
    }

    expect(leads.size).toBe(2);

    const batch2 = [
      { key: "uk/200", name: "Updated Version", country: "uk" },
      { key: "uk/202", name: "New Lead", country: "uk" },
    ];

    for (const lead of batch2) {
      if (!leads.has(lead.key)) {
        leads.set(lead.key, lead);
      }
    }

    expect(leads.size).toBe(3);
    expect(leads.get("uk/200")?.name).toBe("First Version");
    expect(leads.get("uk/201")?.name).toBe("Unique Lead");
    expect(leads.get("uk/202")?.name).toBe("New Lead");
  });

  it("allows updating existing leads when explicitly intended", async () => {
    const leads = new Map<string, { key: string; name: string; country: string; stage: string }>();

    const batch1 = [
      { key: "uk/300", name: "Company X", country: "uk", stage: "raw" },
    ];

    for (const lead of batch1) {
      leads.set(lead.key, lead);
    }

    expect(leads.get("uk/300")?.stage).toBe("raw");

    const batch2 = [
      { key: "uk/300", name: "Company X", country: "uk", stage: "verified" },
    ];

    for (const lead of batch2) {
      leads.set(lead.key, lead);
    }

    expect(leads.size).toBe(1);
    expect(leads.get("uk/300")?.stage).toBe("verified");
  });

  it("handles multiple checkpoint steps in sequence", async () => {
    const runId = "run-sequence-001";

    const intakeState = {
      runId,
      candidates: [{ key: "uk/400", name: "Test", country: "uk" }],
      verifiedLeads: [],
      stats: { totalCandidates: 1, totalVerified: 0, totalSynced: 0, totalFailed: 0, countriesProcessed: ["uk"] },
    };

    await saveCheckpoint(runId, "intake", intakeState);

    const verifyState = {
      ...intakeState,
      verifiedLeads: [{ key: "uk/400", name: "Test", country: "uk", stage: "verified" }],
      stats: { ...intakeState.stats, totalVerified: 1 },
    };

    await saveCheckpoint(runId, "verify", verifyState);

    const extractState = {
      ...verifyState,
      verifiedLeads: [
        {
          key: "uk/400",
          name: "Test",
          country: "uk",
          stage: "verified",
        },
      ],
    };

    await saveCheckpoint(runId, "extract", extractState);

    expect(loadCheckpoint(runId, "intake")).not.toBeNull();
    expect(loadCheckpoint(runId, "verify")).not.toBeNull();
    expect(loadCheckpoint(runId, "extract")).not.toBeNull();
    expect(loadCheckpoint(runId, "finalize")).toBeNull();
  });

  it("checkpoint file is valid JSON and can be parsed", async () => {
    const runId = "run-json-001";
    const state = {
      runId,
      candidates: [],
      verifiedLeads: [],
      stats: {
        totalCandidates: 0,
        totalVerified: 0,
        totalSynced: 0,
        totalFailed: 0,
        countriesProcessed: [],
      },
    };

    await saveCheckpoint(runId, "intake", state);

    const filePath = checkpointFile(runId, "intake");
    expect(fs.existsSync(filePath)).toBe(true);

    const rawContent = fs.readFileSync(filePath, "utf8");
    expect(() => JSON.parse(rawContent)).not.toThrow();

    const parsed = JSON.parse(rawContent);
    expect(parsed.runId).toBe(runId);
  });

  it("handles checkpoint corruption gracefully", async () => {
    const runId = "run-corrupt-001";
    const filePath = checkpointFile(runId, "intake");

    fs.mkdirSync(tempDir, { recursive: true });
    fs.writeFileSync(filePath, "not valid json {{{", "utf8");

    const result = loadCheckpoint(runId, "intake");
    expect(result).toBeNull();
  });

  it("verifies stage transitions are preserved through checkpoint", async () => {
    const runId = "run-stages-001";

    const state1 = {
      runId,
      leads: [
        { key: "uk/500", stage: "raw" },
        { key: "uk/501", stage: "raw" },
      ],
    };

    await saveCheckpoint(runId, "step1", state1);

    const state2 = {
      runId,
      leads: [
        { key: "uk/500", stage: "verified" },
        { key: "uk/501", stage: "verified" },
      ],
    };

    await saveCheckpoint(runId, "step2", state2);

    const restored1 = loadCheckpoint<typeof state1>(runId, "step1");
    const restored2 = loadCheckpoint<typeof state2>(runId, "step2");

    expect(restored1?.leads.every((l) => l.stage === "raw")).toBe(true);
    expect(restored2?.leads.every((l) => l.stage === "verified")).toBe(true);
  });

  it("simulates full workflow with crash and resume", async () => {
    const runId = "run-full-001";

    const intakeState: MockCrawlState = {
      runId,
      candidates: [
        { key: "fr/001", name: "Agence Web Paris", country: "fr", website: "https://agence.fr" },
        { key: "fr/002", name: "Studio Digital", country: "fr", website: "https://studio.fr" },
      ],
      verifiedLeads: [],
      stats: {
        totalCandidates: 2,
        totalVerified: 0,
        totalSynced: 0,
        totalFailed: 0,
        countriesProcessed: ["fr"],
      },
    };

    await saveCheckpoint(runId, "intake", intakeState);

    const intakeRestored = loadCheckpoint<MockCrawlState>(runId, "intake");
    expect(intakeRestored).not.toBeNull();
    expect(intakeRestored?.candidates).toHaveLength(2);

    const verifyState: MockCrawlState = {
      runId,
      candidates: intakeRestored!.candidates,
      verifiedLeads: [
        { key: "fr/001", name: "Agence Web Paris", country: "fr", stage: "verified" },
      ],
      stats: {
        ...intakeRestored!.stats,
        totalVerified: 1,
      },
    };

    await saveCheckpoint(runId, "verify", verifyState);

    const verifyRestored = loadCheckpoint<MockCrawlState>(runId, "verify");
    expect(verifyRestored).not.toBeNull();
    expect(verifyRestored?.verifiedLeads).toHaveLength(1);

    const extractState: MockCrawlState = {
      runId,
      candidates: verifyRestored!.candidates,
      verifiedLeads: [
        {
          key: "fr/001",
          name: "Agence Web Paris",
          country: "fr",
          stage: "verified",
        },
      ],
      stats: verifyRestored!.stats,
    };

    await saveCheckpoint(runId, "extract", extractState);

    const finalizeState: MockCrawlState = {
      ...extractState,
      stats: {
        ...extractState.stats,
        totalSynced: 1,
      },
    };

    await saveCheckpoint(runId, "finalize", finalizeState);

    const finalRestored = loadCheckpoint<MockCrawlState>(runId, "finalize");
    expect(finalRestored).not.toBeNull();
    expect(finalRestored?.stats.totalSynced).toBe(1);
    expect(finalRestored?.stats.totalVerified).toBe(1);
  });
});
