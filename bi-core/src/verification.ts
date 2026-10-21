import { normalizeName, getDistinctiveFragment } from "./normalize.js";
import { makeSignal, computeVerdict } from "./scoring.js";
import type { NormalizedName, VerificationResult } from "./types.js";

export interface PageContent {
  url: string;
  html: string;
  text: string;
}

export interface RegistryInfo {
  name: string;
  address?: string;
  regNumber?: string;
  city?: string;
}

const FOOTER_FALLBACK_CHARS = 2000;

/**
 * Extract the footer text from an HTML page.
 * Falls back to the last N characters of the body text if no <footer> tag found.
 */
function extractFooterText(html: string, fallbackText: string): string {
  const footerMatch = html.match(/<footer[^>]*>([\s\S]*?)<\/footer>/i);
  if (footerMatch) {
    return footerMatch[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  }
  return fallbackText.slice(-FOOTER_FALLBACK_CHARS);
}

/**
 * Extract the <title> and og:site_name from HTML head.
 */
function extractTitleAndOgSiteName(html: string): { title: string; ogSiteName: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const ogMatch = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)
    ?? html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i);

  return {
    title: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : "",
    ogSiteName: ogMatch ? ogMatch[1].trim() : "",
  };
}

/**
 * Extract the first <h1> heading text from HTML.
 */
function extractH1(html: string): string {
  const match = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return "";
  return match[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function containsMatch(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function snippetAround(haystack: string, needle: string, radius = 60): string {
  const lower = haystack.toLowerCase();
  const idx = lower.indexOf(needle.toLowerCase());
  if (idx === -1) return "";
  const start = Math.max(0, idx - radius);
  const end = Math.min(haystack.length, idx + needle.length + radius);
  return haystack.slice(start, end).replace(/\s+/g, " ").trim();
}

/**
 * Stage B — Verification.
 *
 * Checks 5 independent signals on the crawled page content against
 * the registry information. Returns a verification result with score,
 * individual signal evidence, and a verdict.
 *
 * @param pages - Array of crawled page content (homepage + contact/imprint pages).
 * @param registry - Registry information (name, address, reg number).
 * @param candidateUrl - The candidate website URL being verified.
 */
export function verify(
  pages: PageContent[],
  registry: RegistryInfo,
  candidateUrl: string
): VerificationResult {
  const norm: NormalizedName = normalizeName(registry.name);
  const fragment = getDistinctiveFragment(norm.normalized);

  const allText = pages.map((p) => p.text).join("\n");
  const allHtml = pages.map((p) => p.html).join("\n");
  const homePage = pages[0];

  const footerText = homePage
    ? extractFooterText(homePage.html, homePage.text)
    : "";
  const { title, ogSiteName } = homePage
    ? extractTitleAndOgSiteName(homePage.html)
    : { title: "", ogSiteName: "" };
  const h1 = homePage ? extractH1(homePage.html) : "";

  const sig1Fired =
    containsMatch(footerText, norm.normalized) ||
    (fragment.length >= 6 && containsMatch(footerText, fragment));
  const sig1Snippet = sig1Fired
    ? snippetAround(footerText, fragment.length >= 6 ? fragment : norm.normalized)
    : "";

  const sig2Fired =
    (fragment.length >= 1 && containsMatch(title, fragment)) ||
    (fragment.length >= 1 && containsMatch(ogSiteName, fragment));
  const sig2Snippet = sig2Fired
    ? snippetAround(title, fragment) || snippetAround(ogSiteName, fragment)
    : "";

  const sig3Fired =
    fragment.length >= 1 && containsMatch(h1, fragment);
  const sig3Snippet = sig3Fired ? snippetAround(h1, fragment) : "";

  const sig4Fired =
    !!registry.address &&
    registry.address.split(/\s+/).filter((w) => w.length > 3).length >= 2 &&
    containsMatch(allText, registry.address);
  const sig4Snippet =
    sig4Fired && registry.address
      ? snippetAround(allText, registry.address)
      : "";

  const sig5Fired =
    !!registry.regNumber &&
    registry.regNumber.length > 0 &&
    containsMatch(allText, registry.regNumber);
  const sig5Snippet =
    sig5Fired && registry.regNumber
      ? snippetAround(allText, registry.regNumber)
      : "";

  const signals = [
    makeSignal(1, sig1Fired, sig1Snippet),
    makeSignal(2, sig2Fired, sig2Snippet),
    makeSignal(3, sig3Fired, sig3Snippet),
    makeSignal(4, sig4Fired, sig4Snippet),
    makeSignal(5, sig5Fired, sig5Snippet),
  ];

  return computeVerdict(candidateUrl, signals);
}
