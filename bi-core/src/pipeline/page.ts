// Page fetch shared by pipeline behaviors (verification + LLM enrichment).
import type { PageContent } from "../verification.js";

export async function fetchPageContent(url: string, maxChars = 60_000): Promise<PageContent | null> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; bi-core/0.2)",
        Accept: "text/html",
      },
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

export async function fetchContactPages(
  website: string,
  paths: string[],
): Promise<PageContent[]> {
  const base = website.replace(/\/$/, "");
  const urls = [base, ...paths.slice(0, 3).map((p) => `${base}${p}`)];
  const out: PageContent[] = [];
  for (const u of urls) {
    const page = await fetchPageContent(u);
    if (page) out.push(page);
  }
  return out;
}
