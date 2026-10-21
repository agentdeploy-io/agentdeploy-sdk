// Website discovery via Brave Search + site crawling via Crawlee (CheerioCrawler).

import { CheerioCrawler } from "crawlee";
import { CONTACT_PATHS, extractEmails, extractPhones, extractSocials } from "./extract.js";
import { domainToName, sleep } from "./registries.js";

const BRAVE_ENDPOINT = "https://api.search.brave.com/res/v1/web/search";

const DIRECTORY_DOMAINS = [
  "linkedin.com", "facebook.com", "instagram.com", "twitter.com", "x.com",
  "youtube.com", "github.com", "crunchbase.com", "wikipedia.org", "yelp.com",
  "yellowpages", "societe.com", "infogreffe", "pappers.fr", "data.gouv.fr",
  "recherche-entreprises.api.gouv.fr", "insee.fr", "companieshouse.gov.uk",
  "company-information.service.gov.uk", "ariregister.rik.ee", "cro.ie",
  "diariodarepublica.pt", "google.", "bing.com", "yahoo.", "annuaire.",
  "kompass.com", "opencorporates.com", "northdata.com", "dnb.com",
  "designrush.com", "wanderlog.com", "clutch.co", "upcity.com",
  "goodfirms.co", "design-love", "thebrandidentity", "procurement.",
  "glassdoor", "builtin.com", "indeed", "glass", "merriam",
];

export type BraveOpts = { apiKey: string; country?: string };

const COUNTRY_NAMES: Record<string, string> = {
  ie: "ireland", uk: "united kingdom", pt: "portugal", fr: "france",
  ee: "estonia", de: "germany", es: "spain", it: "italy",
};

export async function braveWebSearch(
  query: string,
  opts: BraveOpts,
  count = 5
): Promise<Array<{ title: string; url: string; description: string }>> {
  // Some plans reject ISO codes (422) — fall back to the country name, then none.
  const variants = opts.country
    ? [opts.country.toUpperCase(), COUNTRY_NAMES[opts.country.toLowerCase()]].filter(Boolean)
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
          headers: { Accept: "application/json", "X-Subscription-Token": opts.apiKey },
        });
        if (!retry.ok) throw new Error(`Brave search ${retry.status}`);
        const data = (await retry.json()) as any;
        return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
          title: r.title || "",
          url: r.url || "",
          description: r.description || "",
        }));
      }
      if (!res.ok) throw new Error(`Brave search ${res.status}`);
      const data = (await res.json()) as any;
      return (data.web?.results ?? []).slice(0, count).map((r: any) => ({
        title: r.title || "",
        url: r.url || "",
        description: r.description || "",
      }));
    } catch (e) {
      lastError = (e as Error).message;
      await sleep(1500);
    }
  }
  throw new Error(lastError);
}

export function pickWebsite(
  results: Array<{ title: string; url: string; description: string }>,
  leadName: string
): string | null {
  const nameTokens = leadName.toLowerCase().split(/[\s()&.,]+/).filter((t) => t.length > 3);
  for (const r of results) {
    try {
      const u = new URL(r.url);
      const host = u.hostname.replace(/^www\./, "");
      if (DIRECTORY_DOMAINS.some((d) => host.includes(d))) continue;
      if (host.includes("blogspot") || host.includes("wixsite") || host.includes("github.io")) continue;
      const text = `${u.hostname} ${r.title} ${r.description}`.toLowerCase();
      const hits = nameTokens.filter((t) => text.includes(t)).length;
      // Strict match: short names must match every token, long names at least 2.
      const need = nameTokens.length === 0 ? 0 : nameTokens.length <= 2 ? nameTokens.length : Math.min(3, Math.ceil(nameTokens.length / 2));
      if (nameTokens.length > 0 && hits >= need) {
        return `https://${host}`;
      }
    } catch {
      /* bad url */
    }
  }
  return null;
}

/**
 * Country web discovery (no open registry): Brave search scoped to the
 * country, keep results that look like real business sites. Returns
 * {domain, name, url, title} — the site-crawl phase adds contacts.
 */
export type DiscoveredSite = { domain: string; name: string; url: string; title: string };

// Titles that are articles/listicles/courses, not business names.
const TITLE_JUNK = /(melhores?|top \d|guia|listicle|best of|como escolher|curso de|formação|tutorial|20\d\d)(?![a-z]{3,})/i;
// Hosts that are educational institutions, not SMB buyers.
const NON_BUYER_HOST = /(\.edu\.[a-z]{2}$|\.ipp\.[a-z]{2}$|escola|instituto|istec|ipta|isep|univ)/i;

export async function webDiscover(
  query: string,
  country: string,
  braveKey: string,
  max = 5
): Promise<DiscoveredSite[]> {
  const results = await braveWebSearch(query, { apiKey: braveKey, country }, 8);
  const out: DiscoveredSite[] = [];
  const seenDomains = new Set<string>();
  for (const r of results) {
    if (out.length >= max) break;
    let u: URL;
    try {
      u = new URL(r.url);
    } catch {
      continue;
    }
    const host = u.hostname.replace(/^www\./, "");
    if (DIRECTORY_DOMAINS.some((d) => host.includes(d))) continue;
    if (/(blogspot|wixsite|github\.io|squarespace)/.test(host)) continue;
    if (NON_BUYER_HOST.test(host)) continue;
    if (TITLE_JUNK.test(r.title)) continue;
    // Country scoping: keep only local ccTLD hosts (drops global noise like
    // glassdoor.com / merriam-webster.com surfacing in the results).
    if (host !== `${country}.ie` && !host.endsWith(`.${country}`)) continue;
    if (seenDomains.has(host)) continue;
    seenDomains.add(host);
    const name = domainToName(host, r.title);
    if (name.length < 3) continue;
    out.push({ domain: host, name, url: `https://${host}`, title: r.title });
  }
  return out;
}

export type SiteContacts = {
  emails: string[];
  phones: string[];
  socials: Record<string, string[]>;
  pages: string[];
  contactability: number;
};

/**
 * Crawl a lead's website with Crawlee (CheerioCrawler): homepage + contact
 * paths for the country, extracting emails / phones / socials.
 */
export async function crawlSite(
  website: string,
  country: string
): Promise<SiteContacts | null> {
  let base: URL;
  try {
    base = new URL(website);
  } catch {
    return null;
  }
  const paths = ["/", ...(CONTACT_PATHS[country] ?? CONTACT_PATHS.default)];
  const seen = new Set<string>();
  const startUrls: string[] = [];
  for (const p of paths) {
    const u = new URL(p, base.origin).toString();
    if (!seen.has(u)) {
      seen.add(u);
      startUrls.push(u);
    }
  }

  const emails = new Set<string>();
  const phones = new Set<string>();
  const socials: Record<string, string[]> = {};
  const pages: string[] = [];

  try {
    const crawler = new CheerioCrawler({
      maxConcurrency: 2,
      maxRequestRetries: 1,
      useSessionPool: false,
      async requestHandler({ $, request }) {
        const text = $("body").text() || "";
        const html = $.html() || "";
        for (const e of extractEmails(`${text}\n${html}`)) emails.add(e);
        for (const ph of extractPhones(text)) phones.add(ph);
        for (const [k, arr] of Object.entries(extractSocials(html))) {
          socials[k] = [...new Set([...(socials[k] ?? []), ...arr])];
        }
        const tel = $("a[href^='tel:']").map((_, el) => $(el).attr("href")).get();
        for (const t of tel) {
          const digits = t.replace(/\D/g, "");
          if (digits.length >= 7 && digits.length <= 15) phones.add(t.slice(4).trim());
        }
        pages.push(request.url);
      },
    });
    await crawler.run(startUrls.slice(0, 5));
  } catch (e) {
    console.warn(`[crawl] ${website} failed: ${(e as Error).message}`);
  }

  let score = 0;
  if (emails.size > 0) score += 25;
  if (phones.size > 0) score += 10;
  if (socials.linkedin?.length) score += 15;
  if (socials.twitter?.length || socials.instagram?.length) score += 10;
  if (pages.length > 1) score += 10;

  return {
    emails: [...emails].slice(0, 6),
    phones: [...phones].slice(0, 4),
    socials,
    pages: pages.slice(0, 6),
    contactability: Math.min(100, score),
  };
}
