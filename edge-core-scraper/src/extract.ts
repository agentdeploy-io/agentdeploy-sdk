// Contact extraction (regex-based, from the proven agent-recon contact-probe)
// and SIC/NAF → vertical label hints.

export const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
export const PHONE_RE = /(?:\+?\d{1,3}[-.\s]?)?\(?\d{1,4}\)?[-.\s]?\d{1,4}[-.\s]?\d{1,9}/g;

const EMAIL_BLACKLIST = [
  "example.com", "test.com", "domain.com", "email.com", "sentry.io",
  "wixpress.com", "sentry-next.wixpress.com", "@2x", ".png", ".jpg", ".webp",
  "user@", "email@", "name@", "your@", "info@example", "no-reply", "noreply",
  "schema.org", "w3.org", "godaddy", "google.com", "godaddy.com",
  "@company.com", "@firm.com", "@yourdomain", "@yourcompany", "info@company", "you@", "john@", "contact@company",
];

const TLD_RE = /\.(com|co\.uk|org\.uk|ie|pt|fr|ee|de|es|it|com|net|org|eu|io|dev|app|studio|agency|digital|online|site|shop|biz|info|me|ca|us|uk|co|ac\.uk|sch\.ie|edu\.pt|edu\.ie)$/i;

const SOCIAL_DOMAINS: Record<string, string[]> = {
  twitter: ["twitter.com", "x.com"],
  linkedin: ["linkedin.com"],
  github: ["github.com"],
  instagram: ["instagram.com"],
  facebook: ["facebook.com"],
  youtube: ["youtube.com"],
  discord: ["discord.gg", "discord.com/invite"],
};

export function extractEmails(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    let e = m[0].toLowerCase().trim();
    // The greedy domain match can swallow trailing text ("x@foo.ptsecretaria")
    // — trim the domain to a plausible TLD boundary.
    const at = e.lastIndexOf("@");
    const domain = e.slice(at + 1);
    const tldM = domain.match(TLD_RE);
    if (tldM && tldM.index !== undefined) {
      e = e.slice(0, at + 1 + tldM.index + tldM[0].length);
    }
    if (EMAIL_BLACKLIST.some((b) => e.includes(b))) continue;
    const local = e.split("@")[0];
    if (local.length < 2 || local.length > 40) continue;
    if (!TLD_RE.test(e.slice(at + 1))) continue;
    if (/^[0-9]/.test(local)) continue; // concatenated digit noise
    if (local === "example" || local === "sample" || local === "test123") continue;
    found.add(e);
  }
  return [...found].slice(0, 6);
}

export function extractPhones(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length >= 7 && digits.length <= 15) out.add(m[0].trim());
  }
  return [...out].slice(0, 4);
}

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

/** Contact paths to try per country, after the homepage. */
export const CONTACT_PATHS: Record<string, string[]> = {
  fr: ["/contact", "/contact-us", "/nous-contacter", "/contactez-nous", "/mentions-legales"],
  uk: ["/contact", "/contact-us", "/imprint"],
  ee: ["/kontakt", "/kontakti", "/kontakt-andmed"],
  pt: ["/contacto", "/contact", "/fale-conosco"],
  default: ["/contact", "/contact-us", "/about", "/imprint"],
};

/**
 * Coarse NAF/SIC → label hints used when jev's classification is unavailable.
 * jev produces the final vertical; these are fallbacks + context for prompts.
 */
const NAF_HINTS: Array<[RegExp, string]> = [
  [/^62\./, "IT & software"],
  [/^63\./, "Data & information services"],
  [/^69\./, "Legal & accounting"],
  [/^70\./, "Management consultancy"],
  [/^71\./, "Engineering, design & R&D"],
  [/^72\./, "Research & development"],
  [/^73\./, "Marketing & advertising"],
  [/^74\./, "Specialist professional services"],
  [/^77\./, "Rental & leasing"],
  [/^79\./, "Travel & booking"],
  [/^81\./, "Facility & building services"],
  [/^82\./, "Office & business support"],
  [/^85\./, "Education & training"],
  [/^86\./, "Healthcare"],
  [/^95\./, "Computer & phone repair"],
  [/^46\./, "Wholesale"],
  [/^47\./, "Retail & e-commerce"],
  [/^49\./, "Transport"],
  [/^52\./, "Warehousing & courier"],
  [/^55\./, "Hotels & accommodation"],
  [/^56\./, "Food & beverage service"],
  [/^68\./, "Real estate"],
  [/^41\./, "Construction"],
  [/^43\./, "Construction & renovation"],
  [/^45\./, "Auto repair & sales"],
  [/^64\./, "Financial holding"],
  [/^66\./, "Financial services"],
];

export function sicHint(code?: string): string | undefined {
  if (!code) return undefined;
  for (const [re, label] of NAF_HINTS) {
    if (re.test(code)) return label;
  }
  return undefined;
}
