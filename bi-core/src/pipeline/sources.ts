// Named discovery sources + enrichment probes, ported from agent-recon.
// A vertical pack selects which ones run (pack.sources / pack.probes);
// each is a small, independent, best-effort unit that returns hits or
// signals and never throws.

import type { Candidate, DiscoverCtx, SearchHit, VerticalPack } from "./types.js";
import { dorkPhrases, urlscanSearch } from "./search.js";

export const SOURCE_IDS = ["dorks", "commoncrawl", "github", "urlscan", "defillama"] as const;
export const PROBE_IDS = ["monetization", "techstack", "intent"] as const;

export function sourceList(pack: VerticalPack): string[] {
  const s = pack.sources;
  if (!s || s.length === 0) return ["dorks"];
  return s.filter((x) => (SOURCE_IDS as readonly string[]).includes(x));
}

export function probeList(pack: VerticalPack): string[] {
  const p = pack.probes;
  if (!p || p.length === 0) return ["monetization", "techstack"];
  return p.filter((x) => (PROBE_IDS as readonly string[]).includes(x));
}

const COUNTRY_TLD: Record<string, string> = { uk: "co.uk", ie: "ie", fr: "fr", ee: "ee", pt: "pt" };

function rootDomain(hostname: string): string | null {
  const parts = hostname.replace(/^www\./, "").toLowerCase().split(".");
  if (parts.length <= 2) return hostname || null;
  const tld2 = ["co.uk", "com.au", "co.jp", "co.in", "com.br", "org.uk", "net.au"];
  const last2 = parts.slice(-2).join(".");
  if (tld2.includes(last2)) return parts.slice(-3).join(".");
  return parts.slice(-2).join(".");
}

const NOISE_HOST = /(twitter\.com|x\.com|reddit\.com|linkedin\.com|facebook\.com|youtube\.com|instagram\.com|github\.com|github\.io|gitlab\.io|bitbucket|medium\.com|substack\.com|notion\.so|wikipedia\.org|stackoverflow|hackernews|producthunt\.com|indiehackers\.com|vercel\.app|netlify\.app|pages\.dev|replit\.co|lovable\.app|lovable\.dev|gptengineer\.app)/i;

// ── Common Crawl CDX index (free, no key) ───────────────────────────────────
// Port of recon's free-lovable-finder source 3: find crawled pages whose URL
// matches a regex, dedupe to origins. Default patterns: dork phrases matched
// as path slugs under the country TLD ("web design" → web[-_]?design).

let ccIndexCache: { id: string; at: number } | null = null;

export async function commonCrawlLatestIndex(): Promise<string | null> {
  if (ccIndexCache && Date.now() - ccIndexCache.at < 6 * 3600_000) return ccIndexCache.id;
  try {
    const res = await fetch("https://index.commoncrawl.org/collinfo.json", { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    const indexes = (await res.json()) as Array<{ id: string }>;
    const id = indexes[0]?.id ?? null;
    if (id) ccIndexCache = { id, at: Date.now() };
    return id;
  } catch {
    return null;
  }
}

function defaultCcFilters(pack: VerticalPack): string[] {
  const tld = COUNTRY_TLD[pack.countries[0] ?? "uk"] ?? "co.uk";
  const phrases = (pack.dorks ?? []).flatMap((d) => dorkPhrases(d)).slice(0, 3);
  if (phrases.length === 0) return [];
  return phrases.map((p) => `url:.*\\.${tld}.*${p.replace(/"/g, "").replace(/\s+/g, "[-_]?")}`);
}

export async function discoverCommonCrawl(ctx: DiscoverCtx): Promise<SearchHit[]> {
  const { pack, env } = ctx;
  const index = await commonCrawlLatestIndex();
  if (!index) return [];
  const filters = pack.ccFilters?.length ? pack.ccFilters : defaultCcFilters(pack);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const filter of filters.slice(0, 4)) {
    try {
      const url = `https://index.commoncrawl.org/${index}-index?url=*&output=json&fl=url&filter=${encodeURIComponent(filter)}&limit=1000`;
      const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
      if (!res.ok) continue;
      const lines = (await res.text()).trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as { url?: string };
          if (!entry.url) continue;
          const u = new URL(entry.url);
          const host = u.hostname.replace(/^www\./, "").toLowerCase();
          if (!host || NOISE_HOST.test(host) || seen.has(host)) continue;
          seen.add(host);
          hits.push({ url: `${u.protocol}//${u.host}/`, title: host, description: `commoncrawl: ${entry.url.slice(0, 100)}` });
        } catch {
          /* not json */
        }
        if (hits.length >= (pack.perCountryLimit ?? 20)) return hits;
      }
    } catch {
      /* best effort */
    }
  }
  void env;
  return hits;
}

// ── GitHub repo homepage discovery (free, 60 req/h unauthenticated) ────────

const GITHUB_DEFAULT_TOPICS = ["web-agency", "web-design", "digital-agency", "marketing-agency"];

export async function discoverGithub(ctx: DiscoverCtx): Promise<SearchHit[]> {
  const { pack } = ctx;
  const topics = (pack.githubTopics ?? GITHUB_DEFAULT_TOPICS).slice(0, 4);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const topic of topics) {
    try {
      const res = await fetch(
        `https://api.github.com/search/repositories?q=topic:${encodeURIComponent(topic)}&sort=stars&per_page=100&page=1`,
        { headers: { Accept: "application/vnd.github+json", "User-Agent": "bi-core" }, signal: AbortSignal.timeout(20_000) },
      );
      if (res.status === 403 || res.status === 429) break; // rate budget spent
      if (!res.ok) continue;
      const data = (await res.json()) as { items?: Array<{ homepage?: string | null; description?: string | null }> };
      for (const repo of data.items ?? []) {
        if (hits.length >= (pack.perCountryLimit ?? 20)) return hits;
        if (!repo.homepage || !/^https?:\/\//i.test(repo.homepage)) continue;
        try {
          const u = new URL(repo.homepage);
          const host = u.hostname.replace(/^www\./, "").toLowerCase();
          const root = rootDomain(host);
          if (!root || NOISE_HOST.test(root) || seen.has(root)) continue;
          seen.add(root);
          hits.push({ url: repo.homepage.split("#")[0].split("?")[0].replace(/\/$/, ""), title: root, description: `github topic:${topic}${repo.description ? ` — ${String(repo.description).slice(0, 80)}` : ""}` });
        } catch {
          /* bad url */
        }
      }
    } catch {
      /* best effort */
    }
  }
  return hits;
}

// ── URLScan direct queries (free) ──────────────────────────────────────────

function defaultUrlscanQueries(pack: VerticalPack): string[] {
  const tld = COUNTRY_TLD[pack.countries[0] ?? "uk"] ?? "co.uk";
  const phrases = (pack.dorks ?? []).flatMap((d) => dorkPhrases(d)).slice(0, 2);
  return phrases.map((p) => `domain:${tld} page.url:"${p}"`);
}

export async function discoverUrlScan(ctx: DiscoverCtx): Promise<SearchHit[]> {
  const { pack } = ctx;
  const queries = pack.urlscanQueries?.length ? pack.urlscanQueries : defaultUrlscanQueries(pack);
  const hits: SearchHit[] = [];
  const seen = new Set<string>();
  for (const q of queries.slice(0, 3)) {
    for (const h of await urlscanSearch(q, 50)) {
      const host = h.url && (() => { try { return new URL(h.url).hostname; } catch { return ""; } })();
      const root = host ? rootDomain(host) : null;
      if (!root || seen.has(root)) continue;
      seen.add(root);
      hits.push(h);
    }
    if (hits.length >= (pack.perCountryLimit ?? 20)) break;
  }
  return hits.slice(0, pack.perCountryLimit ?? 20);
}

// ── DefiLlama protocols (free) — for crypto/DeFi verticals ─────────────────

export async function discoverDefiLlama(ctx: DiscoverCtx): Promise<SearchHit[]> {
  const { pack } = ctx;
  try {
    const res = await fetch("https://api.llama.fi/protocols", { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return [];
    const protocols = (await res.json()) as Array<{
      name?: string;
      url?: string;
      chain?: string;
      tvl?: number;
      category?: string;
    }>;
    const chains = (pack.defillamaChains ?? []).map((c) => c.toLowerCase());
    const hits: SearchHit[] = [];
    for (const p of protocols) {
      if (!p.url || !/^https?:\/\//i.test(p.url)) continue;
      if (chains.length > 0 && !(p.chain ?? "").toLowerCase().includes(chains[0])) continue;
      if ((p.tvl ?? 0) <= 0) continue;
      try {
        const host = new URL(p.url).hostname.replace(/^www\./, "").toLowerCase();
        if (NOISE_HOST.test(host)) continue;
      } catch {
        continue;
      }
      hits.push({ url: p.url, title: p.name ?? "", description: `defillama: ${p.category ?? "protocol"} · ${p.chain ?? ""} · TVL $${Math.round(p.tvl ?? 0).toLocaleString()}` });
      if (hits.length >= (pack.perCountryLimit ?? 20)) break;
    }
    return hits;
  } catch {
    return [];
  }
}

// ── Tech-stack probe (recon's builder detection) ───────────────────────────
// Site builder / platform markers — a strong ICP signal (e.g. "agency lead
// running a Webflow site" or "built with Lovable"). Runs on the (rendered)
// HTML the verify stage already fetched — zero extra network cost.

const STACK_MARKERS: Array<[string, string[]]> = [
  ["webflow", ["data-wf-site", "webflow.com"]],
  ["framer", ["__framer", "framer.com", "framerusercontent"]],
  ["wix", ["wixstatic.com", "wix.com", "warmup-client"]],
  ["squarespace", ["squarespace.com", "sqs-"]],
  ["shopify", ["cdn.shopify.com", "shopify.com", "Shopify.theme"]],
  ["wordpress", ["wp-content", "wp-includes"]],
  ["elementor", ["elementor"]],
  ["nextjs", ["__NEXT_DATA__", "/_next/"]],
  ["nuxt", ["__NUXT__", "data-nuxt"]],
  ["lovable", ["cdn.gpteng.co", "data-lovable", "lovable-proxy"]],
  ["v0", ["v0.dev", "__v0_app"]],
  ["bolt", ["bolt.new"]],
  ["replit", ["replit.com", "replit.dev"]],
  ["vercel", ["vercel.com", "vercel-storage"]],
  ["netlify", ["netlify.app", "netlify.com"]],
];

export function probeTechStack(html: string): string[] {
  const lower = html.toLowerCase();
  const found: string[] = [];
  for (const [name, markers] of STACK_MARKERS) {
    if (markers.some((m) => lower.includes(m.toLowerCase()))) found.push(`stack:${name}`);
  }
  return found;
}

// ── Intent probe: Wayback CDX (+ optional OpenPageRank) ────────────────────
// Port of recon's intent-scan: proves a site is alive and being updated
// (snapshot recency) and, with an OPR key, how much authority it has.

export interface WaybackInfo {
  snapshotCount: number;
  lastSnapshot: string | null;
  ageDays: number | null;
  active: boolean;
  available: boolean;
}

export async function fetchWayback(domain: string): Promise<WaybackInfo> {
  try {
    const url = `https://web.archive.org/cdx/search/cdx?url=${encodeURIComponent(domain)}&output=json&fl=timestamp&collapse=urlkey&limit=5000`;
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { snapshotCount: 0, lastSnapshot: null, ageDays: null, active: false, available: true };
    const data = (await res.json()) as string[][];
    const rows = Array.isArray(data) ? data.slice(1) : [];
    const timestamps = rows.map((r) => r[0]).filter(Boolean);
    if (timestamps.length === 0) return { snapshotCount: 0, lastSnapshot: null, ageDays: null, active: false, available: true };
    const last = Math.max(...timestamps.map((t) => Number(t)));
    const lastSnapshot = `${String(last).slice(0, 4)}-${String(last).slice(4, 6)}-${String(last).slice(6, 8)}`;
    const ageDays = Math.max(0, Math.floor((Date.now() - new Date(`${lastSnapshot}T00:00:00Z`).getTime()) / 86_400_000));
    return { snapshotCount: timestamps.length, lastSnapshot, ageDays, active: ageDays <= 90, available: true };
  } catch {
    return { snapshotCount: 0, lastSnapshot: null, ageDays: null, active: false, available: false };
  }
}

interface OprInfo {
  authority: number | null;
  referringDomains: number | null;
}

export async function fetchOpenPageRank(domains: string[], apiKey: string): Promise<Record<string, OprInfo>> {
  const map: Record<string, OprInfo> = {};
  if (!apiKey || domains.length === 0) return map;
  try {
    const res = await fetch("https://openpagerank.keywordseverywhere.com/v1/domains/bulk", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ domains }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) return map;
    const data = (await res.json()) as { results?: Array<{ domain: string; open_page_rank?: number; referring_domains?: number }> };
    for (const r of data.results ?? []) {
      map[r.domain] = { authority: r.open_page_rank ?? null, referringDomains: r.referring_domains ?? null };
    }
  } catch {
    /* optional source */
  }
  return map;
}

/** Human-readable intent line for the lead's research (recon's intent tier). */
export function intentSummary(wb: WaybackInfo, opr?: OprInfo): string {
  const parts: string[] = [];
  if (wb.available && wb.snapshotCount > 0) {
    parts.push(`${wb.active ? "updated " + wb.ageDays + "d ago" : "last snapshot " + (wb.ageDays ?? "?") + "d ago"} (${wb.snapshotCount} snapshots)`);
  } else if (wb.available) {
    parts.push("no archive presence");
  }
  if (opr?.authority != null) parts.push(`authority ${opr.authority.toFixed(1)}`);
  if (opr?.referringDomains != null) parts.push(`${opr.referringDomains} referring domains`);
  if (parts.length === 0) return "intent: n/a";
  const score =
    (wb.active ? 15 : 0) +
    (wb.snapshotCount >= 50 ? 5 : 0) +
    ((opr?.authority ?? 0) >= 5 ? 20 : (opr?.authority ?? 0) >= 2 ? 10 : 4) +
    ((opr?.referringDomains ?? 0) >= 10 ? 9 : 0);
  const tier = score >= 40 ? "HIGH" : score >= 20 ? "MEDIUM" : "LOW";
  return `intent: ${tier} — ${parts.join(", ")}`;
}

/** Build candidates from raw source hits (shared by all discovery sources). */
export function hitsToCandidates(country: string, hits: SearchHit[], via: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const h of hits) {
    let host = "";
    try {
      host = new URL(h.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    const root = rootDomain(host);
    if (!root || seen.has(root)) continue;
    seen.add(root);
    out.push({
      key: `${country}-${root}`,
      country,
      name: (h.name ?? h.title ?? root).slice(0, 120),
      website: h.url,
      source: `source:${via}`,
      source_url: h.url,
      via,
    });
  }
  return out;
}
