// Search provider stack for discovery:
//   1. Brave Search API — monthly quota tracked on disk (cap via
//      BRAVE_QUOTA_CAP, default 1000; the free key burns through 2000 fast
//      once dorking scales, so we stop it earlier).
//   2. Fallback when Brave is maxed: fetch a DuckDuckGo/Bing SERP, then let
//      the LLM (DeepSeek flash via Chutes) judge which hits match the ICP —
//      "search and fetch" with the LLM as the relevance brain. LLM calls
//      are cheap relative to the runway, so the crawl never stalls on quota.

import * as fs from "node:fs";
import * as path from "node:path";
import { braveSearch, isExcludedDomain, isGenericSingleToken } from "../discovery.js";
import type { BraveSearchResult } from "../types.js";
import { llmJson, llmConfigured } from "./llm.js";
import type { SearchHit, SearchOutcome, VerticalPack } from "./types.js";

const USAGE_FILE = () => path.join(process.env["DATA_DIR"] || "/data", "brave-usage.json");
const DEFAULT_QUOTA_CAP = 1000;

interface Usage {
  month: string; // "2026-10"
  calls: number;
}

function readUsage(): Usage {
  try {
    const u = JSON.parse(fs.readFileSync(USAGE_FILE(), "utf8")) as Usage;
    const month = new Date().toISOString().slice(0, 7);
    if (u.month === month) return u;
  } catch {
    /* first month / corrupt file */
  }
  return { month: new Date().toISOString().slice(0, 7), calls: 0 };
}

function bumpUsage(): number {
  const u = readUsage();
  u.calls += 1;
  try {
    fs.mkdirSync(path.dirname(USAGE_FILE()), { recursive: true });
    fs.writeFileSync(USAGE_FILE(), JSON.stringify(u));
  } catch {
    /* quota tracking is best-effort */
  }
  return u.calls;
}

export function braveQuotaState(): { calls: number; cap: number; exhausted: boolean } {
  const cap = Number(process.env["BRAVE_QUOTA_CAP"] ?? DEFAULT_QUOTA_CAP);
  const calls = readUsage().calls;
  return { calls, cap, exhausted: calls >= cap };
}

async function braveHits(
  query: string,
  apiKey: string,
  count: number,
): Promise<SearchHit[]> {
  const results = await braveSearch(query, { apiKey }, count) as BraveSearchResult[];
  return results
    .map((r) => ({ url: r.url, title: r.title, description: r.description }))
    .filter((h) => {
      try {
        const host = new URL(h.url).hostname;
        return !isExcludedDomain(host) && !isGenericSingleToken(host);
      } catch {
        return false;
      }
    });
}

// ── Fallback discovery (Brave quota exhausted / no key) ───────────────────
// Raw-hit sources, all best-effort in parallel:
//   1. URLScan search API — headless-friendly JSON (thin index, but real)
//   2. DuckDuckGo HTML — works from residential IPs (CAPTCHA from datacenter)
//   3. Bing HTML — works from residential IPs (bot-gated elsewhere)
// Then DeepSeek-flash (Chutes) does the heavy lifting the user asked for:
//   4. LLM candidate generation — the model names plausible businesses +
//      websites from its own knowledge of the ICP/country
//   5. LLM judgement — every raw/generated hit is scored against the ICP
// The pipeline then fetches each surviving site and the LLM enriches it.

const SERP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

const COUNTRY_TLD: Record<string, string> = { uk: "co.uk", ie: "ie", fr: "fr", ee: "ee", pt: "pt" };

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

/** Pull the quoted phrases out of a dork: '"web design" "our services" site:co.uk' → ["web design","our services"]. */
export function dorkPhrases(dork: string): string[] {
  const quoted = [...dork.matchAll(/"([^"]+)"/g)].map((m) => m[1]!.trim());
  if (quoted.length > 0) return quoted;
  const plain = dork.replace(/site:[^\s]+/g, "").trim();
  return plain ? [plain] : [];
}

async function fetchUrlScan(dork: string, tld: string): Promise<SearchHit[]> {
  const phrases = dorkPhrases(dork);
  const hits: SearchHit[] = [];
  for (const phrase of phrases.slice(0, 2)) {
    const q = `domain:${tld} page.url:"${phrase}"`;
    try {
      const res = await fetch(`https://urlscan.io/api/v1/search/?q=${encodeURIComponent(q)}&size=10`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        results?: Array<{ page?: { url?: string; title?: string }; task?: { domain?: string } }>;
      };
      for (const r of data.results ?? []) {
        const url = r.page?.url ?? (r.task?.domain ? `https://${r.task.domain}` : undefined);
        if (!url) continue;
        hits.push({ url, title: r.page?.title ?? r.task?.domain ?? "", description: `urlscan: ${r.task?.domain ?? ""}` });
      }
      if (hits.length > 0) break; // ANDing more phrases empties the index — first non-empty phrase wins
    } catch {
      /* best effort */
    }
  }
  return hits;
}

async function fetchDuckDuckGo(query: string): Promise<SearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": SERP_UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
  const descRe = /<a[^>]+class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
  const descs: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = descRe.exec(html)) !== null) descs.push(stripTags(m[1] ?? ""));
  let i = 0;
  while ((m = re.exec(html)) !== null) {
    let href = m[1] ?? "";
    // DDG wraps results in a redirect: //duckduckgo.com/l/?uddg=<urlencoded>
    const uddg = href.match(/[?&]uddg=([^&]+)/);
    if (uddg?.[1]) href = decodeURIComponent(uddg[1]);
    if (!/^https?:\/\//.test(href)) {
      if (href.startsWith("//")) href = `https:${href}`;
      else continue;
    }
    hits.push({ url: href, title: stripTags(m[2] ?? ""), description: descs[i] ?? "" });
    i += 1;
  }
  return hits;
}

async function fetchBing(query: string): Promise<SearchHit[]> {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, {
    headers: { "User-Agent": SERP_UA, Accept: "text/html" },
    redirect: "follow",
  });
  if (!res.ok) return [];
  const html = await res.text();
  const hits: SearchHit[] = [];
  const re = /<li class="b_algo"[\s\S]*?<h2>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:<p[^>]*>([\s\S]*?)<\/p>)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let href = (m[1] ?? "").replace(/&amp;/g, "&");
    // Bing wraps results in /ck/a redirects carrying the URL as u=a1<base64>.
    const u = href.match(/[?&]u=a1([A-Za-z0-9_-]+)/);
    if (u?.[1]) {
      try {
        href = Buffer.from(u[1], "base64").toString("utf8");
      } catch {
        /* keep the redirect URL — it will be filtered out below */
      }
    }
    if (!/^https?:\/\//.test(href)) continue;
    hits.push({ url: href, title: stripTags(m[2] ?? ""), description: stripTags(m[3] ?? "") });
  }
  return hits;
}

interface LlmJudgement {
  hits: Array<{ index: number; relevance: number; name?: string }>;
}

/** LLM judges raw SERP hits against the ICP and names the companies. */
async function llmJudge(
  env: Record<string, string>,
  pack: VerticalPack,
  query: string,
  raw: SearchHit[],
): Promise<SearchHit[]> {
  if (!llmConfigured(env) || raw.length === 0) return raw;
  const list = raw
    .slice(0, 12)
    .map((h, i) => `${i}. ${h.url} — ${h.title} | ${h.description.slice(0, 140)}`)
    .join("\n");
  const out = await llmJson<
    LlmJudgement & { _unused?: never }
  >(
    env,
    "You judge web-search results for B2B lead discovery. You are given the target ICP and raw SERP results. For each result that is plausibly a real business matching the ICP, return its index, a relevance score 0-100 (100 = obvious fit), and the company's name if identifiable from the result. Ignore directories, job boards, social profiles, news, and off-ICP businesses. STRICT JSON: {\"hits\":[{\"index\":number,\"relevance\":number,\"name\":string}]}.",
    `Target ICP: ${pack.icp}\nSearch query: ${query}\n\nResults:\n${list}`,
  );
  if (!out.data) return raw;
  const judged = out.data.hits
    .filter((h) => typeof h.index === "number" && (h.relevance ?? 0) >= 40)
    .map((h) => ({
      ...(raw[h.index] as SearchHit),
      relevance: h.relevance ?? 0,
      name: h.name,
    }));
  return judged;
}

interface LlmGenerated {
  candidates: Array<{ url: string; name?: string; reason?: string }>;
}

/**
 * The LLM "searches" from its own knowledge: given the ICP + country it names
 * plausible real businesses with their websites. These are unverified guesses
 * (the LLM can hallucinate domains) — that's fine because every generated
 * candidate still has to pass the pipeline's fetch + ICP gates, and a dead or
 * wrong domain simply drops as fetch_failed / icp_mismatch.
 */
async function llmGenerateCandidates(
  env: Record<string, string>,
  pack: VerticalPack,
  query: string,
  n: number,
): Promise<SearchHit[]> {
  if (!llmConfigured(env)) return [];
  const out = await llmJson<LlmGenerated>(
    env,
    "You help discover B2B leads. Given an ICP and a country, name up to N REAL businesses that plausibly match the ICP, with their most likely website URL. Only include businesses you are reasonably confident exist. Prefer small local businesses over chains. STRICT JSON: {\"candidates\":[{\"url\":string,\"name\":string,\"reason\":string}]}.",
    `ICP: ${pack.icp}\nCountry: ${pack.countries.join(", ")}\nSearch context: ${query}\nN: ${n}`,
  );
  if (!out.data) return [];
  const hits: SearchHit[] = [];
  for (const c of out.data.candidates ?? []) {
    const url = String(c.url ?? "").trim();
    let host = "";
    try {
      host = new URL(/^https?:\/\//.test(url) ? url : `https://${url}`).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (!host || host.length < 4 || isExcludedDomain(host) || isGenericSingleToken(host)) continue;
    hits.push({
      url: /^https?:\/\//.test(url) ? url : `https://${url}`,
      title: c.name ?? host,
      description: c.reason ? `llm: ${c.reason}` : "llm candidate",
      name: c.name,
    });
  }
  return hits;
}

// ── Unified entry point ────────────────────────────────────────────────────

export async function pipelineSearch(
  query: string,
  pack: VerticalPack,
  env: Record<string, string>,
  count = 10,
): Promise<SearchOutcome> {
  const braveKey = env.BRAVE_API_KEY ?? "";
  const quota = braveQuotaState();

  if (braveKey && !quota.exhausted) {
    try {
      bumpUsage();
      const hits = await braveHits(query, braveKey, count);
      return { hits, via: "brave" };
    } catch (e: any) {
      // Quota/429/other — fall through to SERP+LLM rather than stalling.
      return serpLlm(query, pack, env, count, `brave failed (${e.message})`);
    }
  }

  return serpLlm(query, pack, env, count, quota.exhausted ? "brave monthly quota exhausted" : "no brave key");
}

async function serpLlm(
  query: string,
  pack: VerticalPack,
  env: Record<string, string>,
  count: number,
  reason: string,
): Promise<SearchOutcome> {
  const tld = COUNTRY_TLD[pack.countries[0] ?? "uk"] ?? "co.uk";
  const [urlscan, ddg, bing, generated] = await Promise.allSettled([
    fetchUrlScan(query, tld),
    fetchDuckDuckGo(query),
    fetchBing(query),
    llmGenerateCandidates(env, pack, query, count),
  ]);
  const raw: SearchHit[] = [
    ...(generated.status === "fulfilled" ? generated.value : []),
    ...(urlscan.status === "fulfilled" ? urlscan.value : []),
    ...(ddg.status === "fulfilled" ? ddg.value : []),
    ...(bing.status === "fulfilled" ? bing.value : []),
  ];
  const seen = new Set<string>();
  const deduped: SearchHit[] = [];
  for (const h of raw) {
    let host = "";
    try {
      host = new URL(h.url).hostname.replace(/^www\./, "").toLowerCase();
    } catch {
      continue;
    }
    if (isExcludedDomain(host) || isGenericSingleToken(host) || seen.has(host)) continue;
    seen.add(host);
    deduped.push(h);
  }
  const judged = await llmJudge(env, pack, query, deduped);
  const hits = judged.slice(0, count).map((h) => ({
    ...h,
    relevance: h.relevance ?? 60,
    name: h.name ?? h.title,
  }));
  return { hits, via: "serp-llm", reason };
}
