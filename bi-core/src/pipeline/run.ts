// runVerticalPack — the orchestrator. Executes a vertical pack's pipeline:
//
//   discover (dorks via brave → LLM-SERP fallback)
//   → verify (registry SIC/active gate, website name-match)
//   → enrich (contacts + MX-gated guessing, LLM ICP fit + summary)
//   → score (weighted composite, minScore gate)
//   → sync (batches to the engine)
//
// Progress + per-stage drop reasons are reported live so the UI can show
// exactly where a run is and why a candidate was dropped.

import { syncCallback, type SyncLead } from "../mastra/tools/sync-callback.js";
import {
  checkWebsite,
  discoverDorks,
  enrichContacts,
  enrichLlm,
  verifyRegistry,
} from "./behaviors.js";
import { pipelineSearch } from "./search.js";
import type { SmartFetchResult } from "./renderer.js";
import {
  discoverCommonCrawl,
  discoverDefiLlama,
  discoverGithub,
  discoverRegistry,
  discoverUrlScan,
  fetchOpenPageRank,
  fetchWayback,
  hitsToCandidates,
  intentSummary,
  probeList,
  sourceList,
} from "./sources.js";
import { getCustomSource, isCustomSource } from "./custom-sources.js";
import {
  emptyDrops,
  emptyStats,
  type Candidate,
  type Progress,
  type Stage,
  type SyncedLead,
  type VerticalPack,
} from "./types.js";

function hostOf(url?: string): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface RunCallbacks {
  progress: (p: Progress) => void;
  vmMinutesLimit?: number;
  syncUrl?: string;
  syncSecret?: string;
  runId?: string;
}

const DEFAULTS = {
  requireWebsite: true,
  useRegistry: true,
  llmEnrich: true,
  mxGuess: true,
  minScore: 50,
  perCountryLimit: 20,
};

export function normalizePack(raw: Partial<VerticalPack> & { id: string; name: string }): VerticalPack {
  return {
    id: raw.id,
    name: raw.name,
    icp: raw.icp ?? "",
    countries: raw.countries?.length ? raw.countries : ["uk"],
    dorks: raw.dorks ?? [],
    cities: raw.cities,
    sicInclude: raw.sicInclude,
    sicExclude: raw.sicExclude,
    requireWebsite: raw.requireWebsite ?? DEFAULTS.requireWebsite,
    useRegistry: raw.useRegistry ?? DEFAULTS.useRegistry,
    llmEnrich: raw.llmEnrich ?? DEFAULTS.llmEnrich,
    mxGuess: raw.mxGuess ?? DEFAULTS.mxGuess,
    minScore: raw.minScore ?? DEFAULTS.minScore,
    perCountryLimit: raw.perCountryLimit ?? DEFAULTS.perCountryLimit,
    sources: raw.sources,
    probes: raw.probes,
    ccFilters: raw.ccFilters,
    githubTopics: raw.githubTopics,
    urlscanQueries: raw.urlscanQueries,
    defillamaChains: raw.defillamaChains,
    registryWindowMonths: raw.registryWindowMonths,
  };
}

/**
 * Contact points by deliverability: a verified personal inbox is worth more
 * than a role address, and MX-guessed info@/hello@ barely at all — the old
 * flat +15 let guessed inboxes push leads over minScore with nothing real.
 */
function emailPoints(lead: SyncedLead): number {
  const emails = lead.emails ?? [];
  if (emails.some((e) => e.kind === "personal" && e.mx_ok !== false)) return 15;
  if (emails.some((e) => e.kind !== "guessed")) return 10;
  if (emails.length > 0) return 5;
  return 0;
}

function scoreLead(
  lead: SyncedLead,
  verdict: "verified" | "flagged",
  relevance: number,
  hasLlm: boolean,
  pack: VerticalPack,
): number {
  let score = verdict === "verified" ? 40 : 25;
  score += hasLlm ? Math.round(relevance * 0.3) : 15;
  score += emailPoints(lead);
  if ((lead.phones ?? []).length > 0) score += 10;
  if (lead.reg_number) score += 10;
  if (lead.sic && pack.sicInclude?.some((p) => lead.sic!.startsWith(p))) score += 5;
  return Math.min(100, score);
}

export async function runVerticalPack(
  rawPack: Partial<VerticalPack> & { id: string; name: string },
  env: Record<string, string>,
  cb: RunCallbacks,
): Promise<ReturnType<typeof emptyStats>> {
  const pack = normalizePack(rawPack);
  const stats = emptyStats();
  const drops = stats.dropReasons;
  const startedAt = Date.now();
  const search = (query: string) => pipelineSearch(query, pack, env);

  for (const country of pack.countries) {
    const limit = pack.perCountryLimit;

    // ── discover (all configured sources, merged, deduped by host) ──
    const sources = sourceList(pack);
    const hostSeen = new Set<string>();
    const candidates: Candidate[] = [];
    for (let si = 0; si < sources.length; si++) {
      const src = sources[si]!;
      cb.progress({ stage: "discover", done: si, total: sources.length, detail: `${pack.name} · ${country}: source ${src}` });
      let batch: Candidate[] = [];
      try {
        if (src === "dorks") {
          batch = await discoverDorks({ pack, country, env, search, limit, drops }, stats);
        } else if (src === "registry") {
          batch = await discoverRegistry({ pack, country, env, search, limit, drops });
        } else if (isCustomSource(src)) {
          const custom = getCustomSource(src)!;
          const hits = await custom.discover({ pack, country, env, search, limit, drops });
          batch = hitsToCandidates(country, hits, src);
        } else {
          const fn =
            src === "commoncrawl" ? discoverCommonCrawl :
            src === "github" ? discoverGithub :
            src === "urlscan" ? discoverUrlScan :
            discoverDefiLlama;
          const hits = await fn({ pack, country, env, search, limit, drops });
          batch = hitsToCandidates(country, hits, src);
        }
      } catch {
        batch = []; // a source failing never kills the run
      }
      for (const c of batch) {
        if (candidates.length >= limit) break;
        const host = hostOf(c.website);
        if (!host || hostSeen.has(host)) continue;
        hostSeen.add(host);
        candidates.push(c);
      }
      cb.progress({ stage: "discover", done: si + 1, total: sources.length, detail: `${pack.name} · ${country}: ${candidates.length} candidates after ${src}` });
    }
    stats.totalCandidates += candidates.length;
    if (candidates.length === 0) {
      stats.countriesProcessed.push(country);
      continue;
    }

    // ── verify ──
    const websiteChecks = new Map<string, { verdict: "verified" | "flagged"; score: number; signals: string[]; text: string; home: SmartFetchResult }>();
    const verified: Candidate[] = [];
    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i]!;
      if ((Date.now() - startedAt) / 60_000 > (cb.vmMinutesLimit ?? 120)) {
        drops.budget += candidates.length - i;
        break;
      }
      cb.progress({ stage: "verify", done: i, total: candidates.length, detail: c.name });

      const reg = await verifyRegistry({ pack, country, env, candidate: c });
      if (!reg.ok) {
        drops.registry_sic += 1;
        continue;
      }
      Object.assign(c, reg.patch);

      const web = await checkWebsite({ pack, country, env, candidate: c });
      if ("reason" in web) {
        drops[web.reason] += 1;
        continue;
      }
      if (web.verdict === "rejected") {
        drops.website_unverified += 1;
        continue;
      }
      websiteChecks.set(c.key, { verdict: web.verdict, score: web.score, signals: web.signals, text: web.page.text, home: { page: web.page, rendered: web.rendered } });
      c.website_status = web.verdict;
      verified.push(c);
    }
    stats.totalVerified += verified.length;

    // Intent probe (Wayback CDX + optional OpenPageRank) is batched once per
    // country — OPR is a single bulk call, Wayback is per-domain in the loop.
    const probes = probeList(pack);
    const intentOn = probes.includes("intent");
    const oprKey = env.OPENPAGERANK_API_KEY ?? "";
    const oprMap =
      intentOn && oprKey && verified.length > 0
        ? await fetchOpenPageRank(
            verified.map((c) => hostOf(c.website)).filter((h): h is string => !!h),
            oprKey,
          )
        : {};

    // ── enrich ──
    const leads: SyncedLead[] = [];
    for (let i = 0; i < verified.length; i++) {
      const c = verified[i]!;
      if ((Date.now() - startedAt) / 60_000 > (cb.vmMinutesLimit ?? 120)) {
        drops.budget += verified.length - i;
        break;
      }
      cb.progress({ stage: "enrich", done: i, total: verified.length, detail: c.name });
      const ctx = { pack, country, env, candidate: c, drops };
      const home = websiteChecks.get(c.key)?.home;

      const lead = await enrichContacts(ctx, c, home);
      let relevance = 50;
      let hasLlm = false;
      let llmReason = "LLM off";
      let summary = "";
      let intentLine = "";

      if (pack.llmEnrich) {
        const text = websiteChecks.get(c.key)?.text ?? "";
        const out = await enrichLlm(ctx, c, text);
        relevance = out.relevant;
        hasLlm = out.reason !== "LLM unavailable";
        llmReason = out.reason;
        summary = out.summary;
        Object.assign(lead, out.patch);
        if (hasLlm && relevance < 40) {
          drops.icp_mismatch += 1;
          continue;
        }
      }

      if (intentOn) {
        const host = hostOf(c.website) ?? "";
        const wb = await fetchWayback(host);
        intentLine = intentSummary(wb, oprMap[host]);
      }

      lead.score = scoreLead(lead, websiteChecks.get(c.key)?.verdict ?? "flagged", relevance, hasLlm, pack);
      if (lead.score < pack.minScore) {
        drops.below_min_score += 1;
        continue;
      }

      const evidence = [
        ...(websiteChecks.get(c.key)?.signals ?? []),
        ...(lead.sic ? [`SIC ${lead.sic}`] : []),
        `LLM fit ${relevance}/100: ${llmReason}`,
      ].join("; ");
      lead.website_evidence = evidence || undefined;
      const researchParts = [
        summary ? `${summary}\n\nFit: ${llmReason} (${relevance}/100)` : undefined,
        intentLine || undefined,
      ].filter(Boolean);
      lead.research = researchParts.length > 0 ? researchParts.join("\n\n") : undefined;
      leads.push(lead);
    }

    // ── sync ──
    if (leads.length > 0 && cb.syncUrl && cb.syncSecret) {
      for (let i = 0; i < leads.length; i += 10) {
        cb.progress({ stage: "sync", done: i, total: leads.length, detail: `syncing batch ${Math.floor(i / 10) + 1}` });
        const batch = leads.slice(i, i + 10) as SyncLead[];
        try {
          const result = await syncCallback(cb.syncUrl, cb.syncSecret, cb.runId ?? "vertical", country, batch);
          stats.totalSynced += result.pushed;
          stats.totalFailed += result.failed;
        } catch (err: any) {
          stats.totalFailed += batch.length;
          console.error(`[vertical] sync failed for ${country}:`, err);
        }
      }
      cb.progress({ stage: "sync", done: leads.length, total: leads.length, detail: "synced" });
    }

    stats.countriesProcessed.push(country);
  }

  stats.elapsedMs = Date.now() - startedAt;
  return stats;
}
