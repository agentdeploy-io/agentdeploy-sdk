import { Workflow, createStep } from "@mastra/core/workflows";
import { z } from "zod";
import * as fs from "node:fs";
import * as path from "node:path";
import { syncCallback, resetWatermark, type SyncLead } from "../tools/sync-callback.js";
import { harvestFR, harvestUK, harvestIE, harvestEE, harvestPT, type RegistryCandidate } from "./registry-intake.js";
import { discoverCandidates } from "../../discovery.js";
import { verify, type PageContent, type RegistryInfo } from "../../verification.js";
import { extractContacts, validateMxRecords, CONTACT_PATHS } from "../../extraction.js";

// Read lazily: this module is imported (hoisted) before server.ts's .env
// loader runs, so a module-scope read would always see the pre-env default.
function dataDir(): string {
  return process.env["DATA_DIR"] || "/data";
}

// Live progress for the in-flight crawl, exposed via GET /status so the UI
// can show what the crawler is doing right now (harvest → verify → extract
// → sync) instead of a flat "idle".
export interface CrawlProgress {
  runId: string;
  step: "intake" | "verify" | "extract" | "finalize";
  done: number;
  total: number;
  detail: string;
  updatedAt: string;
}

let currentProgress: CrawlProgress | null = null;

export function getCrawlProgress(): CrawlProgress | null {
  return currentProgress;
}

function setProgress(runId: string, step: CrawlProgress["step"], done: number, total: number, detail: string): void {
  currentProgress = { runId, step, done, total, detail, updatedAt: new Date().toISOString() };
}

interface BudgetTracker {
  vmMinutesLimit: number;
  tokensLimit: number;
  startedAt: number;
}

function createBudgetTracker(vmMinutes: number, tokens: number): BudgetTracker {
  return {
    vmMinutesLimit: vmMinutes,
    tokensLimit: tokens,
    startedAt: Date.now(),
  };
}

function checkBudget(budget: BudgetTracker): { exceeded: boolean; reason?: string } {
  const vmMinutesUsed = (Date.now() - budget.startedAt) / 60_000;
  if (vmMinutesUsed >= budget.vmMinutesLimit) {
    return { exceeded: true, reason: `VM minutes exhausted (${vmMinutesUsed.toFixed(1)}/${budget.vmMinutesLimit})` };
  }
  return { exceeded: false };
}

function checkpointFile(runId: string, step: string): string {
  return path.join(dataDir(), `checkpoint-${runId}-${step}.json`);
}

async function saveCheckpoint(runId: string, step: string, data: unknown): Promise<void> {
  try {
    fs.mkdirSync(dataDir(), { recursive: true });
    fs.writeFileSync(checkpointFile(runId, step), JSON.stringify(data), "utf8");
  } catch {
    console.error(`[crawl] checkpoint write failed: ${runId}/${step}`);
  }
}

function loadCheckpoint<T>(runId: string, step: string): T | null {
  try {
    const p = checkpointFile(runId, step);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, "utf8")) as T;
    }
  } catch {
    console.error(`[crawl] checkpoint read failed: ${runId}/${step}`);
  }
  return null;
}

const crawlInputSchema = z.object({
  countries: z.array(z.string()).default(["fr", "uk", "ie", "ee", "pt"]),
  queries: z.record(z.array(z.string())).optional(),
  syncUrl: z.string(),
  syncSecret: z.string(),
  braveApiKey: z.string(),
  companiesHouseKey: z.string().optional(),
  vmMinutesLimit: z.number().optional().default(120),
  tokensLimit: z.number().optional().default(500000),
  perCountryLimit: z.number().optional().default(20),
  runId: z.string().optional(),
});

const crawlOutputSchema = z.object({
  runId: z.string(),
  totalCandidates: z.number(),
  totalVerified: z.number(),
  totalSynced: z.number(),
  totalFailed: z.number(),
  countriesProcessed: z.array(z.string()),
  dropReasons: z.object({
    noWebsite: z.number(),
    fetchFailed: z.number(),
    unverified: z.number(),
    duplicate: z.number(),
  }),
  budgetUsed: z.object({
    vmMinutes: z.number(),
    tokens: z.number(),
  }),
  status: z.string(),
});

interface CrawlState {
  runId: string;
  candidates: RegistryCandidate[];
  verifiedLeads: SyncLead[];
  stats: {
    totalCandidates: number;
    totalVerified: number;
    totalSynced: number;
    totalFailed: number;
    countriesProcessed: string[];
    dropReasons?: { noWebsite: number; fetchFailed: number; unverified: number; duplicate: number };
  };
}

const HARVESTERS: Record<string, (opts: { query?: string; apiKey?: string; dataDir?: string; braveApiKey?: string; limit?: number }) => Promise<RegistryCandidate[]>> = {
  fr: harvestFR,
  uk: harvestUK,
  ie: harvestIE,
  ee: harvestEE,
  pt: harvestPT,
};

const DEFAULT_QUERIES: Record<string, string[]> = {
  fr: ["agence web", "développement web", "consultant digital", "studio création"],
  uk: ["web development agency", "digital marketing agency", "software consultancy"],
  ie: ["web design agency", "software company Dublin", "digital marketing agency"],
  ee: ["tarkvara", "võrguarendus", "digital agency"],
  pt: ["agência web", "desenvolvimento de software", "agência digital marketing"],
};

const intakeStep = createStep({
  id: "intake",
  description: "Harvest candidates from country registries in parallel",
  inputSchema: crawlInputSchema,
  outputSchema: z.object({
    runId: z.string(),
    candidates: z.array(z.any()),
    stats: z.any(),
  }),
  execute: async ({ inputData }) => {
    const runId = inputData.runId || `run-${Date.now()}`;
    const budget = createBudgetTracker(inputData.vmMinutesLimit, inputData.tokensLimit);

    // Fail loudly on unknown countries — silently harvesting 0 candidates is
    // the "where's my data?" bug.
    const unknown = (inputData.countries as string[]).filter((c) => !HARVESTERS[c.toLowerCase()]);
    if (unknown.length > 0) {
      throw new Error(
        `Unknown countries: ${unknown.join(", ")} — supported: ${Object.keys(HARVESTERS).join(", ")}`,
      );
    }

    const existing = loadCheckpoint<CrawlState>(runId, "intake");
    if (existing) {
      return { runId, candidates: existing.candidates, stats: existing.stats };
    }

    const allCandidates: RegistryCandidate[] = [];
    const countriesProcessed: string[] = [];
    setProgress(runId, "intake", 0, (inputData.countries as string[]).length, "harvesting candidates");

    let intakeDone = 0;
    const harvestPromises = inputData.countries.map(async (country: string) => {
      const budgetCheck = checkBudget(budget);
      if (budgetCheck.exceeded) return [];

      const harvester = HARVESTERS[country.toLowerCase()];
      if (!harvester) return [];

      const queries = inputData.queries?.[country] || DEFAULT_QUERIES[country] || ["web agency"];
      const countryCandidates: RegistryCandidate[] = [];

      for (const query of queries) {
        try {
          const results = await harvester({
            query,
            apiKey: country === "uk" ? inputData.companiesHouseKey : undefined,
            braveApiKey: inputData.braveApiKey,
            dataDir: dataDir(),
            limit: inputData.perCountryLimit,
          });
          countryCandidates.push(...results);
        } catch (err) {
          console.error(`[intake] ${country}/${query} failed:`, err);
        }
      }

      countriesProcessed.push(country);
      intakeDone += 1;
      setProgress(runId, "intake", intakeDone, (inputData.countries as string[]).length, `${country}: ${countryCandidates.length} candidates`);
      return countryCandidates;
    });

    const results = await Promise.all(harvestPromises);
    for (const batch of results) {
      allCandidates.push(...batch);
    }
    // Harvest queries for one country frequently return the same companies
    // (broad registry matches) — dedupe by key so verify doesn't burn a
    // Brave call + page fetch on the same company 3×.
    const seenKeys = new Set<string>();
    const deduped = allCandidates.filter((c) => {
      if (seenKeys.has(c.key)) return false;
      seenKeys.add(c.key);
      return true;
    });
    allCandidates.length = 0;
    allCandidates.push(...deduped);

    const stats = {
      totalCandidates: allCandidates.length,
      totalVerified: 0,
      totalSynced: 0,
      totalFailed: 0,
      countriesProcessed,
      dropReasons: { noWebsite: 0, fetchFailed: 0, unverified: 0, duplicate: 0 },
    };

    const state: CrawlState = { runId, candidates: allCandidates, verifiedLeads: [], stats };
    await saveCheckpoint(runId, "intake", state);

    return { runId, candidates: allCandidates, stats };
  },
});

async function fetchPage(url: string): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; bi-core/0.1)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    return { url, html, text };
  } catch {
    return null;
  }
}

const verifyStep = createStep({
  id: "verify",
  description: "Discover and verify websites for harvested candidates",
  inputSchema: z.object({
    runId: z.string(),
    candidates: z.array(z.any()),
    stats: z.any(),
  }),
  outputSchema: z.object({
    runId: z.string(),
    candidates: z.array(z.any()),
    verifiedLeads: z.array(z.any()),
    stats: z.any(),
  }),
  execute: async ({ inputData }) => {
    const { runId, candidates, stats } = inputData;

    const existing = loadCheckpoint<CrawlState>(runId, "verify");
    if (existing) {
      return {
        runId,
        candidates: existing.candidates,
        verifiedLeads: existing.verifiedLeads,
        stats: existing.stats,
      };
    }

    const verifiedLeads: SyncLead[] = [];
    const verifiedSeen = new Set<string>();
    const braveKey = process.env["BRAVE_API_KEY"] ?? "";

    console.error(`[verify] starting: ${candidates.length} candidates`);
    const verifyStartedAt = Date.now();
    // Where candidates drop out — surfaced in stats so a "0 leads" crawl
    // tells you WHY instead of staying a mystery.
    const drops = { noWebsite: 0, fetchFailed: 0, unverified: 0, duplicate: 0 };
    setProgress(runId, "verify", 0, candidates.length, "verifying websites & contacts");
    for (let i = 0; i < (candidates as RegistryCandidate[]).length; i++) {
      const candidate = (candidates as RegistryCandidate[])[i];
      setProgress(runId, "verify", i, candidates.length, candidate.name ?? `candidate ${i + 1}`);
      if (i % 10 === 0) {
        console.error(`[verify] progress ${i}/${candidates.length} elapsed=${((Date.now() - verifyStartedAt) / 1000).toFixed(0)}s`);
      }
      // Stage B — website discovery: registry APIs (e.g. Companies House) don't
      // return websites, so search Brave for the exact registry name.
      if (!candidate.website && braveKey) {
        try {
          const found = await discoverCandidates(candidate.name, { apiKey: braveKey, country: candidate.country }, candidate.city, 5);
          if (found[0]?.url) candidate.website = found[0].url;
        } catch (err) {
          console.error(`[verify] website discovery ${candidate.key}:`, err);
        }
      }
      if (!candidate.website) {
        drops.noWebsite += 1;
        continue;
      }

      const registry: RegistryInfo = {
        name: candidate.name,
        address: candidate.address,
        regNumber: candidate.reg_number,
        city: candidate.city,
      };

      const homePage = await fetchPage(candidate.website);
      if (!homePage) {
        drops.fetchFailed += 1;
        continue;
      }

      const pages: PageContent[] = [homePage];
      const result = verify(pages, registry, candidate.website);

      if (result.verdict === "verified") {
        if (verifiedSeen.has(candidate.key)) {
          drops.duplicate += 1;
          continue;
        }
        verifiedSeen.add(candidate.key);

        verifiedLeads.push({
          key: candidate.key,
          country: candidate.country,
          name: candidate.name,
          reg_number: candidate.reg_number,
          sic: candidate.sic,
          sic_label: candidate.sic_label,
          incorporated: candidate.incorporated,
          address: candidate.address,
          city: candidate.city,
          website: candidate.website,
          website_status: "verified",
          score: result.score,
          source: candidate.source,
          source_url: candidate.source_url,
          stage: "verified",
        });
      } else {
        drops.unverified += 1;
      }
    }

    stats.totalVerified = verifiedLeads.length;
    stats.dropReasons = drops;
    console.error(
      `[verify] done: ${verifiedLeads.length}/${candidates.length} verified ` +
        `(noWebsite=${drops.noWebsite} fetchFailed=${drops.fetchFailed} unverified=${drops.unverified} dup=${drops.duplicate})`,
    );

    const state: CrawlState = {
      runId,
      candidates: candidates as RegistryCandidate[],
      verifiedLeads,
      stats,
    };
    await saveCheckpoint(runId, "verify", state);

    return { runId, candidates, verifiedLeads, stats };
  },
});

const extractStep = createStep({
  id: "extract",
  description: "Extract contacts from verified websites",
  inputSchema: z.object({
    runId: z.string(),
    candidates: z.array(z.any()),
    verifiedLeads: z.array(z.any()),
    stats: z.any(),
  }),
  outputSchema: z.object({
    runId: z.string(),
    verifiedLeads: z.array(z.any()),
    stats: z.any(),
  }),
  execute: async ({ inputData }) => {
    const { runId, verifiedLeads, stats } = inputData;

    const existing = loadCheckpoint<CrawlState>(runId, "extract");
    if (existing) {
      return { runId, verifiedLeads: existing.verifiedLeads, stats: existing.stats };
    }

    const leads = verifiedLeads as SyncLead[];
    setProgress(runId, "extract", 0, leads.length, "extracting contacts from websites");

    for (let i = 0; i < leads.length; i++) {
      const lead = leads[i]!;
      setProgress(runId, "extract", i, leads.length, lead.name ?? `lead ${i + 1}`);
      if (!lead.website) continue;
      if (lead.emails && lead.emails.length > 0) continue;

      try {
        const countryPaths = CONTACT_PATHS[lead.country] || CONTACT_PATHS["default"];
        const urlsToFetch = [lead.website];
        for (const p of countryPaths.slice(0, 3)) {
          urlsToFetch.push(`${lead.website.replace(/\/$/, "")}${p}`);
        }

        const pages: PageContent[] = [];
        for (const url of urlsToFetch) {
          const page = await fetchPage(url);
          if (page) pages.push(page);
        }

        if (pages.length === 0) continue;

        const extraction = await extractContacts(
          pages.map((p) => ({ url: p.url, html: p.html, text: p.text })),
          10,
          8,
        );

        await validateMxRecords(extraction);

        lead.emails = extraction.emails;
        lead.phones = extraction.phones;
        lead.socials = extraction.socials;
      } catch (err) {
        console.error(`[extract] failed for ${lead.key}:`, err);
      }
    }

    const state: CrawlState = {
      runId,
      candidates: [],
      verifiedLeads: leads,
      stats,
    };
    await saveCheckpoint(runId, "extract", state);

    return { runId, verifiedLeads: leads, stats };
  },
});

const finalizeStep = createStep({
  id: "finalize",
  description: "Sync verified leads and compute final stats",
  inputSchema: z.object({
    runId: z.string(),
    verifiedLeads: z.array(z.any()),
    stats: z.any(),
  }),
  outputSchema: crawlOutputSchema,
  execute: async ({ inputData }) => {
    const { runId, verifiedLeads, stats } = inputData;
    const leads = verifiedLeads as SyncLead[];

    if (leads.length > 0) {
      resetWatermark();
      const countryGroups = new Map<string, SyncLead[]>();
      for (const lead of leads) {
        const group = countryGroups.get(lead.country) || [];
        group.push(lead);
        countryGroups.set(lead.country, group);
      }

      const syncUrl = process.env["SYNC_URL"];
      const syncSecret = process.env["SYNC_SECRET"];

      if (syncUrl && syncSecret) {
        let syncDone = 0;
        for (const [country, countryLeads] of countryGroups) {
          setProgress(runId, "finalize", syncDone, countryGroups.size, `syncing ${country} (${countryLeads.length} leads)`);
          try {
            const result = await syncCallback(syncUrl, syncSecret, runId, country, countryLeads);
            stats.totalSynced += result.pushed;
            stats.totalFailed += result.failed;
          } catch (err) {
            console.error(`[finalize] sync failed for ${country}:`, err);
            stats.totalFailed += countryLeads.length;
          }
          syncDone += 1;
        }
      }
    }
    setProgress(runId, "finalize", leads.length, Math.max(leads.length, 1), "done");

    return {
      runId,
      totalCandidates: stats.totalCandidates,
      totalVerified: stats.totalVerified,
      totalSynced: stats.totalSynced,
      totalFailed: stats.totalFailed,
      countriesProcessed: stats.countriesProcessed,
      dropReasons: stats.dropReasons ?? { noWebsite: 0, fetchFailed: 0, unverified: 0, duplicate: 0 },
      budgetUsed: {
        vmMinutes: Number(((Date.now() - (stats.startedAt || Date.now())) / 60_000).toFixed(2)),
        tokens: stats.tokensUsed || 0,
      },
      status: stats.totalFailed > 0 ? "partial" : "completed",
    };
  },
});

export const crawlWorkflow = new Workflow({
  id: "crawl",
  inputSchema: crawlInputSchema,
  outputSchema: crawlOutputSchema,
});

crawlWorkflow
  .then(intakeStep)
  .then(verifyStep)
  .then(extractStep)
  .then(finalizeStep);

crawlWorkflow.commit();
