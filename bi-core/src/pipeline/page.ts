// Page fetch shared by pipeline behaviors (verification + LLM enrichment).
import { parseSitemap, findContactUrls } from "../extraction.js";
import type { PageContent } from "../verification.js";

const UA = { "User-Agent": "Mozilla/5.0 (compatible; bi-core/0.2)", Accept: "text/html" } as const;

async function attemptFetch(url: string, maxChars: number): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: UA,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return null;
    const html = (await res.text()).slice(0, maxChars * 4);
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxChars);
    return { url, html, text };
  } catch {
    return null;
  }
}

/** One-shot fetches lose leads to transient 5xx/timeouts — retry once. */
export async function fetchPageContent(
  url: string,
  maxChars = 60_000,
  opts?: { retries?: number },
): Promise<PageContent | null> {
  const attempts = 1 + Math.max(0, Math.min(2, opts?.retries ?? 0));
  let page: PageContent | null = null;
  for (let i = 0; i < attempts; i++) {
    page = await attemptFetch(url, maxChars);
    if (page) return page;
    if (i < attempts - 1) await new Promise((r) => setTimeout(r, 800));
  }
  return page;
}

export async function fetchContactPages(
  website: string,
  paths: string[],
): Promise<PageContent[]> {
  const base = website.replace(/\/$/, "");
  const urls = [base, ...paths.slice(0, 3).map((p) => `${base}${p}`)];
  const out: PageContent[] = [];
  for (const u of urls) {
    const page = await fetchPageContent(u, 60_000, { retries: 1 });
    if (page) out.push(page);
  }
  return out;
}

/**
 * Sitemap-based contact-page discovery. The fixed CONTACT_PATHS list misses
 * team pages, legal notices and localized contact routes that only the
 * sitemap knows about — and contact data on those pages is where personal
 * emails live. Finds candidate URLs, the caller fetches them.
 */
export async function discoverSitemapContactUrls(
  base: string,
  knownPaths: string[],
  max = 3,
): Promise<string[]> {
  const sitemapUrls: string[] = [];
  try {
    const res = await fetch(`${base}/robots.txt`, {
      headers: { "User-Agent": UA["User-Agent"] },
      signal: AbortSignal.timeout(8_000),
    });
    if (res.ok) {
      const body = await res.text();
      for (const m of body.matchAll(/^\s*Sitemap:\s*(\S+)/gim)) {
        if (m[1] && sitemapUrls.length < 2) sitemapUrls.push(m[1]);
      }
    }
  } catch {
    /* no robots.txt */
  }
  if (sitemapUrls.length === 0) sitemapUrls.push(`${base}/sitemap.xml`);

  let host = "";
  try {
    host = new URL(base).hostname;
  } catch {
    return [];
  }

  const known = new Set(knownPaths.map((p) => p.replace(/^\/+/, "").toLowerCase()));
  const out: string[] = [];
  for (const su of sitemapUrls) {
    try {
      const res = await fetch(su, {
        headers: { "User-Agent": UA["User-Agent"] },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) continue;
      const locs = parseSitemap(await res.text());
      for (const c of findContactUrls(locs)) {
        let abs: URL;
        try {
          abs = new URL(c, base);
        } catch {
          continue;
        }
        if (abs.hostname !== host) continue; // off-host sitemap entries
        const p = abs.pathname.replace(/^\/+/, "").toLowerCase();
        if (!p || known.has(p)) continue;
        if (out.some((u) => u.endsWith(abs.pathname))) continue;
        out.push(abs.toString());
        if (out.length >= max) return out;
      }
    } catch {
      /* best effort */
    }
  }
  return out;
}
