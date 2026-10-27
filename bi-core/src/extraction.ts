import * as dns from "node:dns/promises";
import type { ContactExtraction, ExtractedEmail } from "./types.js";

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;
const OBFUSCATED_EMAIL_RE =
  /([a-zA-Z0-9._%+-]+)\s*[\[\(]\s*(at|@)\s*[\]\)]\s*([a-zA-Z0-9.-]+)\s*[\[\(]\s*(dot|\.)\s*[\]\)]\s*([a-zA-Z]{2,})/gi;

const TLD_RE =
  /\.(com|co\.uk|org\.uk|ie|pt|fr|ee|de|es|it|net|org|eu|io|dev|app|studio|agency|digital|online|site|shop|biz|info|me|ca|us|uk|co|ac\.uk|sch\.ie|edu\.pt|edu\.ie|nl|be|at|ch|dk|se|no|fi|pl|cz|hu|ro|bg|hr|si|sk|lt|lv)$/i;

const EMAIL_BLACKLIST = [
  "example.com",
  "test.com",
  "domain.com",
  "email.com",
  "sentry.io",
  "wixpress.com",
  "sentry-next.wixpress.com",
  "@2x",
  ".png",
  ".jpg",
  ".webp",
  "user@",
  "email@",
  "name@",
  "your@",
  "info@example",
  "no-reply",
  "noreply",
  "schema.org",
  "w3.org",
  "godaddy",
  "google.com",
  "godaddy.com",
  "@company.com",
  "@firm.com",
  "@yourdomain",
  "@yourcompany",
  "info@company",
  "you@",
  "john@",
  "contact@company",
];

const ROLE_PREFIXES = new Set([
  "info",
  "hello",
  "contact",
  "sales",
  "office",
  "support",
  "admin",
  "enquiries",
  "enquiries",
  "marketing",
  "team",
  "press",
  "media",
  "reception",
  "general",
  "mail",
  "help",
  "careers",
  "jobs",
  "hr",
  "billing",
  "accounts",
  "legal",
  "privacy",
  "webmaster",
  "postmaster",
]);

const PRICE_CONTEXT_RE = /[€$£¥]\s*\d|\d\s*[€$£¥]/;
const YEAR_CONTEXT_RE = /\b(19|20)\d{2}\b/;
const REG_NUMBER_CONTEXT_RE = /(?:co\.?\s*no\.?|company\s*no|reg\.?\s*no|registration)/i;

const SOCIAL_DOMAINS: Record<string, string[]> = {
  twitter: ["twitter.com", "x.com"],
  linkedin: ["linkedin.com"],
  github: ["github.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com"],
  youtube: ["youtube.com"],
  discord: ["discord.gg", "discord.com/invite"],
};

export const CONTACT_PATHS: Record<string, string[]> = {
  fr: ["/contact", "/contact-us", "/nous-contacter", "/contactez-nous", "/mentions-legales"],
  uk: ["/contact", "/contact-us", "/imprint"],
  ie: ["/contact", "/contact-us", "/imprint"],
  ee: ["/kontakt", "/kontakti", "/kontakt-andmed"],
  pt: ["/contacto", "/contact", "/fale-conosco"],
  de: ["/kontakt", "/impressum"],
  at: ["/kontakt", "/impressum"],
  default: ["/contact", "/contact-us", "/about", "/imprint", "/team"],
};

/**
 * Decode a Cloudflare `data-cfemail` XOR-encoded email address.
 * The encoding XORs every byte of the email with the first byte (the key).
 *
 * @param encoded - The hex-encoded string from `data-cfemail`.
 */
export function decodeCfEmail(encoded: string): string {
  if (encoded.length < 4 || encoded.length % 2 !== 0) return "";

  const key = parseInt(encoded.slice(0, 2), 16);
  if (isNaN(key)) return "";

  let decoded = "";
  for (let i = 2; i < encoded.length; i += 2) {
    const byte = parseInt(encoded.slice(i, i + 2), 16);
    if (isNaN(byte)) return "";
    decoded += String.fromCharCode(byte ^ key);
  }

  if (decoded.includes("@") && decoded.includes(".")) return decoded;
  return "";
}

function isValidEmail(email: string): boolean {
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);

  if (local.length < 2 || local.length > 40) return false;
  if (EMAIL_BLACKLIST.some((b) => email.includes(b))) return false;
  if (!TLD_RE.test(domain)) return false;
  if (/^[0-9]/.test(local)) return false;
  if (local === "example" || local === "sample" || local === "test123") return false;

  return true;
}

function classifyEmail(email: string): "role" | "personal" {
  const local = email.split("@")[0].toLowerCase();
  return ROLE_PREFIXES.has(local) ? "role" : "personal";
}

/**
 * Extract emails from HTML including mailto: links, Cloudflare data-cfemail decode,
 * and obfuscation patterns like `info [at] domain [dot] com`.
 */
export function extractEmails(html: string, text: string): string[] {
  const found = new Set<string>();

  for (const m of html.matchAll(/mailto:([^\s"'<>]+@[^\s"'<>]+)/gi)) {
    const email = decodeURIComponent(m[1]).toLowerCase().trim();
    if (isValidEmail(email)) found.add(email);
  }

  for (const m of html.matchAll(/data-cfemail=["']([^"']+)["']/gi)) {
    const decoded = decodeCfEmail(m[1]);
    if (decoded && isValidEmail(decoded.toLowerCase())) {
      found.add(decoded.toLowerCase());
    }
  }

  for (const m of `${text}\n${html}`.matchAll(EMAIL_RE)) {
    let email = m[0].toLowerCase().trim();
    const at = email.lastIndexOf("@");
    const domain = email.slice(at + 1);
    const tldM = domain.match(TLD_RE);
    if (tldM && tldM.index !== undefined) {
      email = email.slice(0, at + 1 + tldM.index + tldM[0].length);
    }
    if (isValidEmail(email)) found.add(email);
  }

  for (const m of `${text}\n${html}`.matchAll(OBFUSCATED_EMAIL_RE)) {
    const email = `${m[1]}@${m[3]}.${m[5]}`.toLowerCase();
    if (isValidEmail(email)) found.add(email);
  }

  return [...found].slice(0, 10);
}

/**
 * Extract phone numbers from HTML tel: links and text content.
 * Rejects numbers embedded in price, year, or registry-number contexts.
 */
export function extractPhones(text: string, html: string): string[] {
  const out = new Set<string>();

  for (const m of html.matchAll(/href=["']tel:([^"']+)["']/gi)) {
    const tel = m[1].trim();
    const digits = tel.replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) {
      out.add(tel);
    }
  }

  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 7 || digits.length > 15) continue;

    const before = text.slice(Math.max(0, m.index! - 20), m.index!);
    const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 20);
    const context = before + m[0] + after;

    if (PRICE_CONTEXT_RE.test(context)) continue;
    if (YEAR_CONTEXT_RE.test(context)) continue;
    if (REG_NUMBER_CONTEXT_RE.test(before)) continue;

    out.add(m[0].trim());
  }

  return [...out].slice(0, 6);
}

/**
 * Extract social media profile URLs from HTML anchor hrefs.
 */
export function extractSocials(html: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [name, domains] of Object.entries(SOCIAL_DOMAINS)) {
    const found = new Set<string>();
    for (const m of html.matchAll(/https?:\/\/[^\s"'<>]+/g)) {
      const u = m[0].replace(/\/$/, "");
      if (domains.some((d) => u.includes(d))) found.add(u);
    }
    if (found.size > 0) out[name] = [...found].slice(0, 3);
  }
  return out;
}

/**
 * Check MX records for an email domain.
 * Returns true if the domain has valid MX records, false otherwise.
 */
export async function checkMx(domain: string): Promise<boolean> {
  try {
    const records = await dns.resolveMx(domain);
    return Array.isArray(records) && records.length > 0;
  } catch {
    return false;
  }
}

/**
 * Parse sitemap.xml content and extract URLs.
 * Returns an array of URLs found in <loc> elements.
 */
export function parseSitemap(xml: string): string[] {
  const urls: string[] = [];
  for (const m of xml.matchAll(/<loc>([^<]+)<\/loc>/gi)) {
    urls.push(m[1].trim());
  }
  return urls;
}

/**
 * Find contact-related URLs from a sitemap (contact, imprint, team, about, legal).
 */
export function findContactUrls(sitemapUrls: string[]): string[] {
  const patterns = [
    /contact/i,
    /imprint/i,
    /impressum/i,
    /mentions?-legales/i,
    /team/i,
    /about/i,
    /legal/i,
    /privacy/i,
    /datenschutz/i,
    // Localized + marketing contact routes the fixed path list misses.
    /get[-_ ]?in[-_ ]?touch/i,
    /reach[-_ ]?us/i,
    /enquir/i,
    /kontakt/i,
    /contacto/i,
    /nos(?:ous)?[-_ ]?contacter/i,
    /fale[-_ ]?conosco/i,
  ];
  return sitemapUrls.filter((u) => patterns.some((p) => p.test(u)));
}

/**
 * Stage C — Contact Extraction.
 *
 * Extracts emails, phones, and social profiles from crawled page content.
 * Classifies emails as role or personal, and performs MX validation.
 *
 * @param pages - Array of page content objects with url, html, and text.
 * @param maxEmails - Maximum number of emails to return (default 10).
 * @param maxPages - Maximum pages to process (default 8).
 */
export async function extractContacts(
  pages: Array<{ url: string; html: string; text: string }>,
  maxEmails = 10,
  maxPages = 8
): Promise<ContactExtraction> {
  const allEmails = new Set<string>();
  const allPhones = new Set<string>();
  const socials: Record<string, string[]> = {};
  const pageUrls: string[] = [];

  const pagesToProcess = pages.slice(0, maxPages);

  for (const page of pagesToProcess) {
    pageUrls.push(page.url);

    const emails = extractEmails(page.html, page.text);
    for (const e of emails) allEmails.add(e);

    const phones = extractPhones(page.text, page.html);
    for (const p of phones) allPhones.add(p);

    const pageSocials = extractSocials(page.html);
    for (const [key, arr] of Object.entries(pageSocials)) {
      socials[key] = [...new Set([...(socials[key] ?? []), ...arr])];
    }
  }

  const emailAddresses = [...allEmails].slice(0, maxEmails);
  const emailResults: ExtractedEmail[] = emailAddresses.map((address) => ({
    address,
    kind: classifyEmail(address),
    mx_ok: null,
  }));

  const personalFirst = emailResults.sort((a, b) => {
    if (a.kind === "personal" && b.kind !== "personal") return -1;
    if (a.kind !== "personal" && b.kind === "personal") return 1;
    return 0;
  });

  return {
    emails: personalFirst,
    phones: [...allPhones].slice(0, 6),
    socials,
    pages: pageUrls,
  };
}

/**
 * Validate MX records for all extracted emails in-place.
 * Updates the `mx_ok` field on each email.
 */
export async function validateMxRecords(
  extraction: ContactExtraction
): Promise<ContactExtraction> {
  const domains = new Set<string>();
  for (const e of extraction.emails) {
    domains.add(e.address.split("@")[1]);
  }

  const mxResults = new Map<string, boolean>();
  await Promise.all(
    [...domains].map(async (domain) => {
      mxResults.set(domain, await checkMx(domain));
    })
  );

  for (const e of extraction.emails) {
    const domain = e.address.split("@")[1];
    e.mx_ok = mxResults.get(domain) ?? false;
  }

  return extraction;
}
