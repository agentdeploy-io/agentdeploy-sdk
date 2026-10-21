import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  harvestUK,
  harvestIE,
  harvestFR,
  harvestEE,
  harvestPT,
  type RegistryCandidate,
} from "../workflows/registry-intake.js";

const HARVESTERS: Record<string, (opts: RegistryHarvestOpts) => Promise<RegistryCandidate[]>> = {
  uk: harvestUK,
  ie: harvestIE,
  fr: harvestFR,
  ee: harvestEE,
  pt: harvestPT,
};

export interface RegistryHarvestOpts {
  query?: string;
  apiKey?: string;
  dataDir?: string;
  braveApiKey?: string;
  limit?: number;
}

export async function harvestRegistry(
  country: string,
  opts: RegistryHarvestOpts,
): Promise<RegistryCandidate[]> {
  const harvester = HARVESTERS[country.toLowerCase()];
  if (!harvester) {
    throw new Error(`Unsupported registry country: ${country}`);
  }
  return harvester(opts);
}

const candidateSchema = z.object({
  key: z.string(),
  country: z.string(),
  name: z.string(),
  reg_number: z.string().optional(),
  sic: z.string().optional(),
  sic_label: z.string().optional(),
  incorporated: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  source: z.string(),
  source_url: z.string().optional(),
  website: z.string().optional(),
});

export const registryClientTool = createTool({
  id: "registry-client",
  description: "Harvest company candidates from country-specific registries (UK, IE, FR, EE, PT)",
  inputSchema: z.object({
    country: z.string().describe("Country code: uk, ie, fr, ee, pt"),
    query: z.string().optional().describe("Search query (for API-based registries)"),
    apiKey: z.string().optional().describe("Registry API key (e.g. Companies House key for UK)"),
    braveApiKey: z.string().optional().describe("Brave API key (for PT web discovery)"),
    dataDir: z.string().optional().describe("Data directory for cached downloads (IE CSV)"),
    limit: z.number().optional().default(20).describe("Maximum candidates to return"),
  }),
  execute: async ({ context }) => {
    const candidates = await harvestRegistry(context.country, {
      query: context.query,
      apiKey: context.apiKey,
      braveApiKey: context.braveApiKey,
      dataDir: context.dataDir,
      limit: context.limit,
    });
    return { candidates, count: candidates.length };
  },
});
