import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { braveSearch, discoverCandidates } from "../../discovery.js";
import type { BraveSearchResult, CandidateResult } from "../../types.js";

let quotaUsed = 0;
let quotaLimit = Number(process.env["BRAVE_QUOTA_LIMIT"] || 2000);
let lastRequestAt = 0;

export function getQuotaUsage(): { used: number; limit: number } {
  return { used: quotaUsed, limit: quotaLimit };
}

export function resetQuota(): void {
  quotaUsed = 0;
}

function isQuotaExhausted(): boolean {
  return quotaUsed >= quotaLimit;
}

async function rateLimit(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastRequestAt;
  const minInterval = 500;
  if (elapsed < minInterval) {
    await new Promise((r) => setTimeout(r, minInterval - elapsed));
  }
  lastRequestAt = Date.now();
}

export async function braveSearchWithQuota(
  query: string,
  apiKey: string,
  country?: string,
  count = 5,
): Promise<BraveSearchResult[]> {
  if (isQuotaExhausted()) {
    throw new Error(`Brave quota exhausted (${quotaUsed}/${quotaLimit})`);
  }

  await rateLimit();
  quotaUsed += 1;

  try {
    return await braveSearch(query, { apiKey, country }, count);
  } catch (err) {
    if (err instanceof Error && err.message.includes("429")) {
      await new Promise((r) => setTimeout(r, 3000));
      quotaUsed += 1;
      return await braveSearch(query, { apiKey, country }, count);
    }
    throw err;
  }
}

export async function discoverWithQuota(
  registryName: string,
  apiKey: string,
  country?: string,
  city?: string,
  count = 5,
): Promise<CandidateResult[]> {
  if (isQuotaExhausted()) {
    throw new Error(`Brave quota exhausted (${quotaUsed}/${quotaLimit})`);
  }

  await rateLimit();
  quotaUsed += 1;

  try {
    return await discoverCandidates(registryName, { apiKey, country }, city, count);
  } catch (err) {
    if (err instanceof Error && err.message.includes("429")) {
      await new Promise((r) => setTimeout(r, 3000));
      quotaUsed += 1;
      return await discoverCandidates(registryName, { apiKey, country }, city, count);
    }
    throw err;
  }
}

export const braveSearchTool = createTool({
  id: "brave-search",
  description: "Search Brave Web API with quota tracking and 429 backoff",
  inputSchema: z.object({
    query: z.string().describe("Search query string"),
    apiKey: z.string().describe("Brave API key"),
    country: z.string().optional().describe("Country code hint"),
    count: z.number().optional().default(5).describe("Number of results"),
  }),
  execute: async ({ context }) => {
    const results = await braveSearchWithQuota(
      context.query,
      context.apiKey,
      context.country,
      context.count,
    );
    return { results, quotaUsed, quotaLimit };
  },
});

export const discoverCandidatesTool = createTool({
  id: "discover-candidates",
  description: "Discover website candidates for a company via Brave search with domain filtering",
  inputSchema: z.object({
    registryName: z.string().describe("Exact company registry name"),
    apiKey: z.string().describe("Brave API key"),
    country: z.string().optional().describe("Country code hint"),
    city: z.string().optional().describe("City to append to query"),
    count: z.number().optional().default(5).describe("Number of results to request"),
  }),
  execute: async ({ context }) => {
    const candidates = await discoverWithQuota(
      context.registryName,
      context.apiKey,
      context.country,
      context.city,
      context.count,
    );
    return { candidates, quotaUsed, quotaLimit };
  },
});
