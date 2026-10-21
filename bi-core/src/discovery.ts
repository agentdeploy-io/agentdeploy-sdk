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
export async function braveSearch(
  query: string,
  opts: BraveOpts,
  count = 5
): Promise<BraveSearchResult[]> {
  const variants: (string | null)[] = opts.country
    ? [
        opts.country.toUpperCase(),
        COUNTRY_NAMES[opts.country.toLowerCase()] ?? null,
      ].filter(Boolean)
    : [];
  variants.push(null);

  let lastError = "no attempts";

  for (const country of variants) {
    const params = new URLSearchParams({ q: query, count: String(count) });
    if (country) params.set("country", country);

    try {
      const res = await fetch(`${BRAVE_ENDPOINT}?${params}`, {
        headers: {
          Accept: "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": opts.apiKey,
        },
      });

      if (res.status === 422) {
        lastError = `Brave 422 (country=${country ?? "none"})`;
        continue;
      }

      if (res.status === 429) {
        await sleep(3000);
        const retry = await fetch(`${BRAVE_ENDPOINT}?${params}`, {
          headers: {
            Accept: "application/json",
            "X-Subscription-Token": opts.apiKey,
          },
        });
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
    } catch (e) {
      lastError = (e as Error).message;
      await sleep(1500);
    }
  }

  throw new Error(lastError);
}

/**
 * Determine whether a hostname should be excluded from candidates.
 */
function isExcludedDomain(host: string): boolean {
  const clean = host.replace(/^www\./, "");
  if (DIRECTORY_DOMAINS.some((d) => clean.includes(d))) return true;
  if (HOSTED_PLATFORM_DOMAINS.some((d) => clean.includes(d))) return true;
  return false;
}

/**
 * Check if the registrable part of a domain is a single generic token
 * (e.g. "digital.com") which cannot be reliably verified by token overlap.
 */
function isGenericSingleToken(host: string): boolean {
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

  const results = await braveSearch(query, opts, count);
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
