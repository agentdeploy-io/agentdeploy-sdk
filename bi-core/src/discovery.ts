import type { BraveOpts, BraveSearchResult, CandidateResult } from "./types.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

export const DIRECTORY_DOMAINS = [
  "linkedin.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "youtube.com",
  "github.com",
  "crunchbase.com",
  "wikipedia.org",
  "yelp.com",
  "yellowpages",
  "societe.com",
  "infogreffe",
  "pappers.fr",
  "data.gouv.fr",
  "recherche-entreprises.api.gouv.fr",
  "insee.fr",
  "companieshouse.gov.uk",
  "company-information.service.gov.uk",
  "ariregister.rik.ee",
  "cro.ie",
  "diariodarepublica.pt",
  "google.",
  "bing.com",
  "yahoo.",
  "annuaire.",
  "kompass.com",
  "opencorporates.com",
  "northdata.com",
  "dnb.com",
  "designrush.com",
  "wanderlog.com",
  "clutch.co",
  "upcity.com",
  "goodfirms.co",
  "design-love",
  "thebrandidentity",
  "procurement.",
  "glassdoor",
  "builtin.com",
  "indeed",
  "glass",
  "merriam",
  "rocketreach.co",
  "zoominfo.com",
  "apollo.io",
  "lusha.com",
  "contactout.com",
  "signalhire.com",
  "theorg.com",
  "110111.io",
  "databasmc.com",
];

const HOSTED_PLATFORM_DOMAINS = [
  "blogspot",
  "wixsite",
  "github.io",
  "squarespace",
];

const GENERIC_SINGLE_TOKEN_RE = /^[a-z]+$/;

const COUNTRY_NAMES: Record<string, string> = {
  ie: "ireland",
  uk: "united kingdom",
  pt: "portugal",
  fr: "france",
  ee: "estonia",
  de: "germany",
  es: "spain",
  it: "italy",
  nl: "netherlands",
  be: "belgium",
  at: "austria",
  ch: "switzerland",
  dk: "denmark",
  se: "sweden",
  no: "norway",
  fi: "finland",
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Query Brave Web Search API. Retries on 429 with backoff.
 * Falls back through country name variants if the ISO code is rejected (422).
 *
 * @param query - The search query string.
 * @param opts - Brave API key and optional country hint.
 * @param count - Number of results to return (default 5).
 */
// Brave Free plan = 1 req/s. Pace all calls through this gate so a crawl
// never hammers the quota into a wall of 429s.
let lastBraveCallAt = 0;
const BRAVE_MIN_INTERVAL_MS = 1100;

async function paceBrave(): Promise<void> {
  const wait = lastBraveCallAt + BRAVE_MIN_INTERVAL_MS - Date.now();
  if (wait > 0) await sleep(wait);
  lastBraveCallAt = Date.now();
}

export async function braveSearch(
  query: string,
  opts: BraveOpts,
  count = 5
): Promise<BraveSearchResult[]> {
  // NOTE: no `country` param. Our key rejects ISO codes with 422 (seen with
  // UK, IE) and Brave only accepts ISO codes anyway, so the old
  // code→name→none fallback burned 2 guaranteed-failing requests per
  // candidate and then hit the rate limit. The quoted exact registry name
  // (+ city) is specific enough; the verify step still checks the site
  // against registry name/address.
  const params = new URLSearchParams({ q: query, count: String(count) });

  const doFetch = async () =>
    fetch(`${BRAVE_ENDPOINT}?${params}`, {
      headers: {
        Accept: "application/json",
        "Accept-Encoding": "gzip",
        "X-Subscription-Token": opts.apiKey,
      },
    });

  await paceBrave();
  const res = await doFetch();

  if (res.status === 429) {
    await sleep(3000);
    await paceBrave();
    const retry = await doFetch();
    if (!retry.ok) throw new Error(`Brave search ${retry.status}`);
    const data = (await retry.json()) as {
      web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    return (data.web?.results ?? []).slice(0, count).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      description: r.description ?? "",
    }));
  }

  if (!res.ok) throw new Error(`Brave search ${res.status}`);

  const data = (await res.json()) as {
    web?: { results?: Array<{ title?: string; url?: string; description?: string }> };
  };
  return (data.web?.results ?? []).slice(0, count).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    description: r.description ?? "",
  }));
}

/**
 * Determine whether a hostname should be excluded from candidates.
 */
export function isExcludedDomain(host: string): boolean {
  const clean = host.replace(/^www\./, "");
  if (DIRECTORY_DOMAINS.some((d) => clean.includes(d))) return true;
  if (HOSTED_PLATFORM_DOMAINS.some((d) => clean.includes(d))) return true;
  return false;
}

/**
 * Check if the registrable part of a domain is a single generic token
 * (e.g. "digital.com") which cannot be reliably verified by token overlap.
 */
export function isGenericSingleToken(host: string): boolean {
  const clean = host.replace(/^www\./, "");
  const parts = clean.split(".");
  if (parts.length < 2) return true;
  const registrable = parts[0];
  return GENERIC_SINGLE_TOKEN_RE.test(registrable) && registrable.length > 0;
}

/**
 * Stage A — Candidate Discovery.
 *
 * Searches Brave for `"EXACT REGISTRY NAME"` + city, then filters out
 * directory domains, hosted platforms, and generic single-token domains.
 * Each remaining result is returned as a candidate with `website_status='candidate'`.
 *
 * @param registryName - The exact company registry name.
 * @param opts - Brave API key and optional country.
 * @param city - Optional city to append to the query.
 * @param count - Number of results to request (default 5).
 */
export async function discoverCandidates(
  registryName: string,
  opts: BraveOpts,
  city?: string,
  count = 5
): Promise<CandidateResult[]> {
  const query = city
    ? `"${registryName}" ${city}`
    : `"${registryName}"`;

  let results = await braveSearch(query, opts, count);
  // The registry city is often an old or sub-town address; when the
  // name+city query over-constrains to zero hits, retry with the exact
  // name alone.
  if (results.length === 0 && city) {
    results = await braveSearch(`"${registryName}"`, opts, count);
  }
  const candidates: CandidateResult[] = [];
  const seen = new Set<string>();

  for (const r of results) {
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }

    const host = u.hostname.replace(/^www\./, "").toLowerCase();

    if (isExcludedDomain(host)) continue;
    if (isGenericSingleToken(host)) continue;
    if (seen.has(host)) continue;

    seen.add(host);
    candidates.push({
      url: `https://${host}`,
      title: r.title,
      description: r.description,
      website_status: "candidate",
    });
  }

  return candidates;
}
