// Vertical-pack pipeline: the crawl is no longer a fixed
// registry→search→fetch chain. A vertical pack is DATA (stored in the
// engine, editable in the UI) that selects and parameterises behaviors:
//
//   discover (dorking via search providers) → verify (registry + website)
//   → enrich (contacts + LLM) → score → sync
//
// Adding a vertical = new config. Adding a behavior = new module registered
// by name in behaviors.ts.

// A candidate flows through the stages and is mutated in place, so every
// field any stage may attach is optional here. SyncedLead tightens `score`.
export interface Candidate {
  key: string;
  country: string;
  name: string;
  source: string;
  reg_number?: string;
  city?: string;
  website?: string;
  source_url?: string;
  /** The query/dork that found this candidate (for drop-reason clarity). */
  via?: string;
  sic?: string;
  sic_label?: string;
  incorporated?: string;
  address?: string;
  website_status?: string;
  emails?: Array<{ address: string; kind: string; mx_ok: boolean | null }>;
  phones?: string[];
  socials?: Record<string, string[]>;
  /** Named person at the company (from the LLM contact pass) — pitch salutation. */
  contact_name?: string;
  contact_role?: string;
  research?: string;
  website_evidence?: string;
  stage?: string;
  score?: number;
}

export interface SyncedLead extends Candidate {
  score: number;
}

export interface SearchHit {
  url: string;
  title: string;
  description: string;
  /** 0-100, only set when the LLM judged the hit against the ICP. */
  relevance?: number;
  /** Company name guessed by the LLM (fallback search only). */
  name?: string;
}

export interface SearchOutcome {
  hits: SearchHit[];
  via: "brave" | "serp-llm";
  reason?: string;
}

export interface VerticalPack {
  id: string;
  name: string;
  /** Free-form ICP description — drives LLM relevance + summaries. */
  icp: string;
  countries: string[];
  /** Discovery queries, one dork per entry. */
  dorks: string[];
  /** If set, dorks are expanded as `dork + city` (capped by perCountryLimit). */
  cities?: string[];
  /** Registry verification: keep only these SIC prefixes (when data exists). */
  sicInclude?: string[];
  sicExclude?: string[];
  requireWebsite: boolean;
  useRegistry: boolean;
  llmEnrich: boolean;
  mxGuess: boolean;
  minScore: number;
  perCountryLimit: number;
  /** Discovery sources to run: dorks | commoncrawl | github | urlscan | defillama. */
  sources?: string[];
  /** Enrichment probes: monetization | techstack | intent. */
  probes?: string[];
  /** Common Crawl CDX regex filters (override the dork-derived defaults). */
  ccFilters?: string[];
  /** GitHub topics to mine for deployed homepages. */
  githubTopics?: string[];
  /** URLScan query strings (override the dork-derived defaults). */
  urlscanQueries?: string[];
  /** DefiLlama chain filter (DeFi verticals). */
  defillamaChains?: string[];
  /** Registry source: only companies incorporated within the last N months. */
  registryWindowMonths?: number;
}

export type Stage = "discover" | "verify" | "enrich" | "sync";

export interface Progress {
  stage: Stage;
  done: number;
  total: number;
  detail: string;
}

export interface StageDrops {
  registry_sic: number;
  no_website: number;
  fetch_failed: number;
  website_unverified: number;
  icp_mismatch: number;
  below_min_score: number;
  budget: number;
  duplicate: number;
}

export interface PipelineStats {
  totalCandidates: number;
  totalVerified: number;
  totalSynced: number;
  totalFailed: number;
  countriesProcessed: string[];
  dropReasons: StageDrops;
  searchVia: { brave: number; serpLlm: number };
  elapsedMs: number;
}

export interface DiscoverCtx {
  pack: VerticalPack;
  country: string;
  env: Record<string, string>;
  search: (query: string) => Promise<SearchOutcome>;
  limit: number;
  drops: StageDrops;
}

export interface VerifyCtx {
  pack: VerticalPack;
  country: string;
  env: Record<string, string>;
  candidate: Candidate;
}

export interface VerifyResult {
  ok: boolean;
  reason?: keyof StageDrops | string;
  patch?: Partial<Candidate>;
}

export interface EnrichCtx {
  pack: VerticalPack;
  country: string;
  env: Record<string, string>;
  candidate: Candidate;
  drops: StageDrops;
}

export interface EnrichResult {
  ok: boolean;
  reason?: keyof StageDrops | string;
  lead?: SyncedLead;
}

export function emptyDrops(): StageDrops {
  return {
    registry_sic: 0,
    no_website: 0,
    fetch_failed: 0,
    website_unverified: 0,
    icp_mismatch: 0,
    below_min_score: 0,
    budget: 0,
    duplicate: 0,
  };
}

export function emptyStats(): PipelineStats {
  return {
    totalCandidates: 0,
    totalVerified: 0,
    totalSynced: 0,
    totalFailed: 0,
    countriesProcessed: [],
    dropReasons: emptyDrops(),
    searchVia: { brave: 0, serpLlm: 0 },
    elapsedMs: 0,
  };
}
