// Rendered-DOM scraping via Playwright/Chromium (headless shell).
//
// Plain fetch is fast and fine for server-rendered sites, but JS-only
// frontends (Next/Nuxt/React shells, Lovable/v0 sites, SPAs) return an
// empty body — contacts, pricing and payment scripts live in the rendered
// DOM. So: fetch plain first, and when the page looks like a JS shell,
// re-fetch it with a real browser and read the live DOM. This is the same
// technique agent-recon used in its discovery scans.

import { chromium, type Browser } from "playwright";
import { fetchPageContent } from "./page.js";
import type { PageContent } from "../verification.js";

const IDLE_CLOSE_MS = 10 * 60_000;
const GO_TIMEOUT_MS = 20_000;
const SETTLE_MS = 1500;

let browser: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;

async function getBrowser(): Promise<Browser | null> {
  try {
    if (!browser) {
      browser = await chromium.launch({ headless: true });
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void closeBrowser();
    }, IDLE_CLOSE_MS);
    return browser;
  } catch (e) {
    console.error("[renderer] browser unavailable:", e instanceof Error ? e.message : e);
    return null;
  }
}

export async function closeBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browser) {
    try {
      await browser.close();
    } catch {
      /* already gone */
    }
    browser = null;
  }
}

/** Render `url` in headless chromium and return the live DOM content. */
export async function renderContent(url: string, maxChars = 60_000): Promise<PageContent | null> {
  const b = await getBrowser();
  if (!b) return null;
  const page = await b.newPage().catch(() => null);
  if (!page) return null;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: GO_TIMEOUT_MS });
    await page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(SETTLE_MS);
    const html = await page.content();
    const text = await page.evaluate(() => document.body?.innerText ?? "");
    return { url, html, text: text.slice(0, maxChars) };
  } catch {
    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

/** Heuristic: is this page a client-rendered shell with no usable content? */
export function looksLikeJsShell(html: string, text: string): boolean {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length < 120) return true; // nearly empty body — nothing to work with
  if (t.length >= 400) return false;
  const markers = ["__NEXT_DATA__", "ng-version", "data-reactroot", "window.__NUXT__", 'id="root"', 'id="__next"', 'id="app"'];
  return markers.some((m) => html.includes(m));
}

export interface SmartFetchResult {
  page: PageContent;
  /** True when the plain fetch was a JS shell and the browser filled it in. */
  rendered: boolean;
}

/** Plain fetch first (fast path); browser re-fetch only for JS shells. */
export async function smartFetch(url: string): Promise<SmartFetchResult | null> {
  const plain = await fetchPageContent(url);
  if (!plain) return null;
  if (!looksLikeJsShell(plain.html, plain.text)) {
    return { page: plain, rendered: false };
  }
  const rendered = await renderContent(url);
  if (rendered && rendered.text.replace(/\s+/g, " ").trim().length >= plain.text.replace(/\s+/g, " ").trim().length) {
    return { page: rendered, rendered: true };
  }
  return { page: plain, rendered: false };
}

// ── Monetization probe (ported from agent-recon's payments-probe) ──────────
// Detects payment infrastructure + paid-tier structure in (rendered) HTML.
// Signals feed the lead's website_evidence / research.

interface ProviderSpec {
  name: string;
  patterns: string[];
}

const PAYMENT_PROVIDERS: ProviderSpec[] = [
  { name: "stripe", patterns: ["stripe.js", "stripe.com", "Stripe(", "createPaymentMethod", "pk_live_", "pk_test_"] },
  { name: "paddle", patterns: ["paddle.js", "Paddle.", "paddle.com"] },
  { name: "lemonsqueezy", patterns: ["lemonsqueezy", "LemonSqueezy"] },
  { name: "paypal", patterns: ["paypal.com", "paypal-sdk", "paypal.Button"] },
  { name: "gumroad", patterns: ["gumroad.com", "gumroad.js", "gumroad-button"] },
  { name: "braintree", patterns: ["braintree", "braintreegateway.com"] },
  { name: "square", patterns: ["squareup.com", "sq-payment-form"] },
  { name: "mollie", patterns: ["mollie.com", "mollie.js"] },
  { name: "razorpay", patterns: ["razorpay", "checkout.razorpay"] },
  { name: "klarna", patterns: ["klarna.com", "klarna-sdk"] },
  { name: "nowpayments", patterns: ["nowpayments", "nowpayments.io"] },
  { name: "coingate", patterns: ["coingate", "coingate.com"] },
  { name: "coinbase-commerce", patterns: ["commerce.coinbase", "coinbase-commerce"] },
  { name: "bitpay", patterns: ["bitpay", "bitpay.com"] },
];

const STRONG_PRICING = [
  /freemium/i,
  /\bper\s+user\/?(month|year)?/i,
  /\bbilled\s+annually/i,
  /\blifetime\s+(access|license|deal|price)/i,
  /\bsubscription/i,
  /\bfree\s+trial/i,
  /\$\s?[0-9]+(\.[0-9]{1,2})?\s?\/?(month|mo|yr|year)?/i,
  /\b(start|pro|premium|business|enterprise|team)\s+plan\b/i,
];

export function probeMonetization(html: string, baseUrl: string): string[] {
  const signals: string[] = [];
  const lower = html.toLowerCase();
  for (const p of PAYMENT_PROVIDERS) {
    if (p.patterns.some((pat) => lower.includes(pat.toLowerCase()))) {
      signals.push(`payment:${p.name}`);
    }
  }
  let pricingLinks = 0;
  for (const m of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi)) {
    const href = m[1] ?? "";
    if (!href || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
    if (/\/(pricing|plans|subscribe|checkout|billing)(\/|\?|$)/.test(href.toLowerCase())) pricingLinks += 1;
  }
  if (pricingLinks > 0) signals.push(`pricing_links:${Math.min(pricingLinks, 9)}`);
  const textSample = html.replace(/<[^>]+>/g, " ").slice(0, 40_000);
  if (STRONG_PRICING.some((re) => re.test(textSample))) signals.push("paid_tier_terms");
  void baseUrl;
  return signals;
}
