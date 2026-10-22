import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../pipeline/behaviors.js", () => ({
  discoverDorks: vi.fn(),
  verifyRegistry: vi.fn(),
  checkWebsite: vi.fn(),
  enrichContacts: vi.fn(),
  enrichLlm: vi.fn(),
}));
vi.mock("../pipeline/search.js", () => ({
  pipelineSearch: vi.fn(),
}));
vi.mock("../mastra/tools/sync-callback.js", () => ({
  syncCallback: vi.fn(),
}));

import { runVerticalPack, normalizePack } from "../pipeline/run.js";
import { discoverDorks, verifyRegistry, checkWebsite, enrichContacts, enrichLlm } from "../pipeline/behaviors.js";
import { pipelineSearch } from "../pipeline/search.js";
import { syncCallback } from "../mastra/tools/sync-callback.js";

type AnyFn = ReturnType<typeof vi.fn>;

const basePack = {
  id: "v-test",
  name: "Test Vertical",
  icp: "test ICP",
  countries: ["uk"] as string[],
  dorks: ["dork one"] as string[],
  requireWebsite: true,
  useRegistry: true,
  llmEnrich: true,
  mxGuess: true,
  minScore: 50,
  perCountryLimit: 10,
};

const ENV = { COMPANIES_HOUSE_KEY: "k", BRAVE_API_KEY: "b" };

function candidate(name: string, country = "uk") {
  return { key: `${country}-${name}`, country, name, source: "dork:brave", website: `https://${name}.example` };
}

describe("normalizePack", () => {
  it("applies defaults for missing fields", () => {
    const p = normalizePack({ id: "x", name: "N" } as never);
    expect(p).toMatchObject({ countries: ["uk"], requireWebsite: true, useRegistry: true, llmEnrich: true, minScore: 50, perCountryLimit: 20, dorks: [] });
  });

  it("keeps provided values", () => {
    const p = normalizePack({ id: "x", name: "N", minScore: 77, countries: ["ie"] } as never);
    expect(p.minScore).toBe(77);
    expect(p.countries).toEqual(["ie"]);
  });
});

describe("runVerticalPack", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("discovers → verifies → enriches → scores → syncs, and reports progress per stage", async () => {
    (discoverDorks as AnyFn).mockResolvedValue([candidate("alpha")]);
    (verifyRegistry as AnyFn).mockResolvedValue({ ok: true, patch: { reg_number: "123", sic: "62010" } });
    (checkWebsite as AnyFn).mockResolvedValue({
      verdict: "verified",
      score: 80,
      signals: ["footer_name"],
      page: { url: "https://alpha.example", html: "", text: "Alpha web agency" },
    });
    (enrichContacts as AnyFn).mockImplementation(async (_ctx, c) => ({
      ...c,
      score: 0,
      stage: "raw",
      emails: [{ address: `info@${c.name}.example`, kind: "role", mx_ok: true }],
      phones: ["+44 123"],
    }));
    (enrichLlm as AnyFn).mockResolvedValue({
      relevant: 90,
      reason: "fits",
      summary: "Alpha builds sites",
      patch: {},
    });
    (syncCallback as AnyFn).mockResolvedValue({ pushed: 1, failed: 0, watermark: 1 });

    const progress: string[] = [];
    const stats = await runVerticalPack(basePack as never, ENV as never, {
      runId: "r1",
      syncUrl: "http://engine/inbound/sync",
      syncSecret: "s",
      progress: (p) => progress.push(`${p.stage}:${p.done}/${p.total}`),
    });

    expect(stats.totalCandidates).toBe(1);
    expect(stats.totalVerified).toBe(1);
    expect(stats.totalSynced).toBe(1);
    expect(stats.totalFailed).toBe(0);
    expect(stats.dropReasons).toMatchObject({ registry_sic: 0, icp_mismatch: 0, below_min_score: 0 });
    expect(stats.countriesProcessed).toEqual(["uk"]);
    expect(progress).toEqual(expect.arrayContaining(["discover:1/1", "verify:0/1", "enrich:0/1", "sync:0/1"]));

    // Score: verified 40 + relevance 90*0.3=27 + email 15 + phone 10 + reg 10 + sic(none) = 100 cap
    expect(syncCallback).toHaveBeenCalledTimes(1);
    const synced = (syncCallback as AnyFn).mock.calls[0]![4] as Array<{ score: number; reg_number?: string }>;
    expect(synced[0]?.score).toBe(100);
    expect(synced[0]?.reg_number).toBe("123");
  });

  it("drops at each stage with the right drop reason", async () => {
    (discoverDorks as AnyFn).mockResolvedValue([
      candidate("alpha"),
      candidate("beta"),
      candidate("gamma"),
      candidate("delta"),
      candidate("eps"),
    ]);
    (verifyRegistry as AnyFn).mockImplementation(async (ctx) =>
      ctx.candidate.name === "alpha" ? { ok: false, reason: "registry_sic" } : { ok: true }
    );
    (checkWebsite as AnyFn).mockImplementation(async (ctx) => {
      const c = ctx.candidate;
      if (c.name === "beta") return { reason: "no_website" };
      if (c.name === "gamma") return { reason: "fetch_failed" };
      if (c.name === "delta") return { verdict: "rejected", score: 5, signals: [], page: { url: c.website ?? "", html: "", text: "" } };
      return { verdict: "flagged", score: 30, signals: [], page: { url: c.website ?? "", html: "", text: "eps text" } };
    });
    (enrichContacts as AnyFn).mockImplementation(async (_ctx, c) => ({ ...c, score: 0, stage: "raw" as const }));
    (enrichLlm as AnyFn).mockResolvedValue({ relevant: 10, reason: "not a fit", summary: "", patch: {} });

    const stats = await runVerticalPack(basePack as never, ENV as never, {
      progress: () => {},
    });

    expect(stats.dropReasons).toMatchObject({
      registry_sic: 1,
      no_website: 1,
      fetch_failed: 1,
      website_unverified: 1,
      icp_mismatch: 1,
    });
    expect(syncCallback).not.toHaveBeenCalled();
  });

  it("drops below minScore and gates icp_mismatch only when the LLM actually answered", async () => {
    // eps: flagged (25) + no LLM answer (neutral 15) + no contacts = 40 < 50 → below_min_score
    (discoverDorks as AnyFn).mockResolvedValue([candidate("alpha"), candidate("beta")]);
    (verifyRegistry as AnyFn).mockResolvedValue({ ok: true });
    (checkWebsite as AnyFn).mockImplementation(async (ctx) => ({
      verdict: "flagged" as const,
      score: 30,
      signals: [] as string[],
      page: { url: ctx.candidate.website ?? "", html: "", text: "text" },
    }));
    (enrichContacts as AnyFn).mockImplementation(async (_ctx, c) => ({ ...c, score: 0, stage: "raw" as const }));
    (enrichLlm as AnyFn)
      .mockResolvedValueOnce({ relevant: 50, reason: "LLM unavailable", summary: "", patch: {} })
      .mockResolvedValueOnce({ relevant: 95, reason: "good fit", summary: "ok", patch: {} });

    (syncCallback as AnyFn).mockResolvedValue({ pushed: 1, failed: 0, watermark: 1 });
    const stats = await runVerticalPack(basePack as never, ENV as never, {
      progress: () => {},
      syncUrl: "http://e",
      syncSecret: "s",
    });

    expect(stats.dropReasons.below_min_score).toBe(1);
    expect(stats.dropReasons.icp_mismatch).toBe(0);
    // beta: flagged 25 + 95*0.3=29 → 54 ≥ 50 → synced
    expect((syncCallback as AnyFn).mock.calls[0]![4]).toHaveLength(1);
    expect(stats.totalSynced).toBe(1);
  });

  it("skips the LLM entirely when llmEnrich is off (neutral relevance, no icp_mismatch)", async () => {
    const pack = { ...basePack, llmEnrich: false };
    (discoverDorks as AnyFn).mockResolvedValue([candidate("alpha")]);
    (verifyRegistry as AnyFn).mockResolvedValue({ ok: true });
    (checkWebsite as AnyFn).mockResolvedValue({ verdict: "flagged", score: 30, signals: [], page: { url: "", html: "", text: "" } });
    (enrichContacts as AnyFn).mockImplementation(async (_ctx, c) => ({ ...c, score: 0, stage: "raw" }));

    const stats = await runVerticalPack(pack as never, ENV as never, {
      progress: () => {},
      syncUrl: "http://e",
      syncSecret: "s",
    });

    expect(enrichLlm).not.toHaveBeenCalled();
    expect(stats.dropReasons.icp_mismatch).toBe(0);
    // flagged 25 + neutral 15 = 40 < 50 → dropped, nothing to sync
    expect(syncCallback).not.toHaveBeenCalled();
    expect(stats.totalSynced).toBe(0);
  });

  it("processes multiple countries in order and sums stats", async () => {
    const pack = { ...basePack, countries: ["uk", "ie"] };
    (discoverDorks as AnyFn)
      .mockResolvedValueOnce([candidate("alpha", "uk")])
      .mockResolvedValueOnce([candidate("beta", "ie")]);
    (verifyRegistry as AnyFn).mockResolvedValue({ ok: true });
    (checkWebsite as AnyFn).mockImplementation(async (ctx) => ({
      verdict: "verified" as const,
      score: 90,
      signals: ["footer_name"],
      page: { url: ctx.candidate.website ?? "", html: "", text: "t" },
    }));
    (enrichContacts as AnyFn).mockImplementation(async (_ctx, c) => ({
      ...c,
      score: 0,
      stage: "raw" as const,
      emails: [{ address: `info@${c.name}.example`, kind: "role", mx_ok: true }],
    }));
    (enrichLlm as AnyFn).mockResolvedValue({ relevant: 80, reason: "fit", summary: "s", patch: {} });
    (syncCallback as AnyFn).mockResolvedValue({ pushed: 1, failed: 0, watermark: 1 });

    const stats = await runVerticalPack(pack as never, ENV as never, {
      progress: () => {},
      syncUrl: "http://e",
      syncSecret: "s",
    });

    expect(stats.countriesProcessed).toEqual(["uk", "ie"]);
    expect(stats.totalCandidates).toBe(2);
    expect(stats.totalSynced).toBe(2);
    expect((syncCallback as AnyFn).mock.calls.map((c) => c[3])).toEqual(["uk", "ie"]);
  });
});
