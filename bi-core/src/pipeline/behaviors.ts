// Pipeline behaviors — each is a small, named, swappable unit.
// A vertical pack (data, stored in the engine) decides which ones run and
// with what parameters. New scraping behavior = new function + registry
// entry in run.ts; new vertical = new config, no pipeline code.

import { verify, type PageContent, type RegistryInfo } from "../verification.js";
import { extractContacts, validateMxRecords, CONTACT_PATHS, ROLE_PREFIXES } from "../extraction.js";
import { fetchPageContent, fetchContactPages, discoverSitemapContactUrls } from "./page.js";
import { probeMonetization, smartFetch, type SmartFetchResult } from "./renderer.js";
import { probeList, probeTechStack } from "./sources.js";
import { llmJson, llmConfigured } from "./llm.js";
import type { ExtractedEmail } from "../types.js";
import type {
  Candidate,
  DiscoverCtx,
  EnrichCtx,
  EnrichResult,
  PipelineStats,
  SyncedLead,
  VerifyCtx,
  VerifyResult,
} from "./types.js";

// ── discover: dorking through the search-provider stack ────────────────────

export async function discoverDorks(ctx: DiscoverCtx, stats: PipelineStats): Promise<Candidate[]> {
  const { pack, country, env, search, limit } = ctx;
  const cities = pack.cities ?? [];
  const queries: string[] = [];
  for (const dork of pack.dorks) {
    if (cities.length > 0) {
      for (const city of cities) queries.push(`${dork} ${city}`);
    } else {
      queries.push(dork);
    }
  }

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    if (candidates.length >= limit) break;
    const outcome = await search(query);
    if (outcome.via === "brave") stats.searchVia.brave += 1;
    else stats.searchVia.serpLlm += 1;

    for (const hit of outcome.hits) {
      if (candidates.length >= limit) break;
      let host = "";
      try {
        host = new URL(hit.url).hostname.replace(/^www\./, "").toLowerCase();
      } catch {
        continue;
      }
      const key = `${country}-${hash(host)}`;
      if (seen.has(key)) {
        ctx.drops.duplicate += 1;
        continue;
      }
      seen.add(key);
      candidates.push({
        key,
        country,
        name: (hit.name ?? hit.title ?? host).slice(0, 120),
        website: hit.url,
        source: `dork:${outcome.via}`,
        source_url: hit.url,
        via: query,
      });
    }
  }
  return candidates;
}

function hash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

// ── verify: Companies House lookup (UK) — SIC gate + registry facts ───────

interface ChCompany {
  title: string;
  company_number: string;
  company_status: string;
  sic_codes?: string[];
  date_of_creation?: string;
  registered_office_address?: { locality?: string };
}

async function chSearchCompanies(name: string, apiKey: string): Promise<ChCompany[]> {
  const basic = Buffer.from(`${apiKey}:`).toString("base64");
  const res = await fetch(
    `https://api.companieshouse.gov.uk/search/companies?q=${encodeURIComponent(name)}&size=10`,
    { headers: { Accept: "application/json", Authorization: `Basic ${basic}` } },
  );
  if (!res.ok) return [];
  const data = (await res.json()) as { items?: ChCompany[] };
  return data.items ?? [];
}

function nameMatchScore(a: string, b: string): number {
  const norm = (s: string) =>
    s.toLowerCase().replace(/limited|ltd|llp|plc|inc|co|company|group/g, "").replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();
  const na = norm(a);
  const nb = norm(b);
  if (!na || !nb) return 0;
  if (na === nb) return 100;
  const ta = new Set(na.split(" "));
  const tb = new Set(nb.split(" "));
  let overlap = 0;
  for (const t of ta) if (t.length > 2 && tb.has(t)) overlap += 1;
  return Math.round((overlap / Math.max(ta.size, tb.size)) * 80);
}

export async function verifyRegistry(ctx: VerifyCtx): Promise<VerifyResult> {
  const { pack, country, env, candidate } = ctx;
  if (!pack.useRegistry || country !== "uk") return { ok: true };
  const key = env.COMPANIES_HOUSE_KEY ?? "";
  if (!key) return { ok: true };

  let items: ChCompany[];
  try {
    items = await chSearchCompanies(candidate.name, key);
  } catch {
    return { ok: true }; // registry unavailable — soft pass
  }

  let best: { item: ChCompany; score: number } | null = null;
  for (const item of items) {
    const s = nameMatchScore(candidate.name, item.title);
    if (s >= 60 && (!best || s > best.score)) best = { item, score: s };
  }
  if (!best) return { ok: true }; // no registry match — keep, it's unconfirmed

  const { item } = best;
  if (item.company_status === "dissolved") return { ok: false, reason: "registry_sic" };

  const sics = item.sic_codes ?? [];
  const excluded = (pack.sicExclude ?? []).some((p) => sics.some((s) => s.startsWith(p)));
  if (excluded) return { ok: false, reason: "registry_sic" };

  return {
    ok: true,
    patch: {
      reg_number: item.company_number,
      sic: sics[0],
      incorporated: item.date_of_creation,
      city: item.registered_office_address?.locality ?? candidate.city,
    },
  };
}

// ── verify: website name-match ─────────────────────────────────────────────

export type WebsiteCheckResult =
  | { verdict: "verified" | "flagged" | "rejected"; score: number; signals: string[]; page: PageContent; rendered: boolean }
  | { reason: "no_website" | "fetch_failed" };

export async function checkWebsite(ctx: VerifyCtx): Promise<WebsiteCheckResult> {
  const { pack, candidate } = ctx;
  if (!candidate.website) {
    if (!pack.requireWebsite) {
      return { verdict: "flagged", score: 0, signals: ["no website found"], page: { url: "", html: "", text: "" }, rendered: false };
    }
    return { reason: "no_website" };
  }
  // Plain fetch first; JS-shell sites are re-fetched in headless chromium so
  // the rendered DOM (where SPA content + payment scripts actually live) is
  // what gets verified and enriched.
  const fetched = await smartFetch(candidate.website);
  if (!fetched) return { reason: "fetch_failed" };
  const { page, rendered } = fetched;
  const registry: RegistryInfo = {
    name: candidate.name,
    city: candidate.city,
    regNumber: candidate.reg_number,
  };
  const result = verify([page], registry, candidate.website);

  // URL-discovered candidates (dorks, Common Crawl, GitHub, URLScan, …): the
  // website IS the entity, and `candidate.name` is a guess — so a name-match
  // miss is expected, not disqualifying. Downgrade "rejected" to "flagged"
  // and let the LLM ICP-relevance gate (run.ts) do the real filtering. Only
  // candidates the registry already confirmed (reg_number set by
  // verifyRegistry) keep the strict name-match verdict.
  const nameConfirmed = Boolean(candidate.reg_number);
  let verdict = result.verdict;
  const signals = result.signals.filter((s) => s.fired).map((s) => s.name);
  if (verdict === "rejected" && !nameConfirmed) {
    verdict = "flagged";
    signals.push("name-unconfirmed (search source)");
  }
  if (rendered) signals.push("rendered-dom");
  const probes = probeList(pack);
  if (probes.includes("monetization")) signals.push(...probeMonetization(page.html, candidate.website));
  if (probes.includes("techstack")) signals.push(...probeTechStack(page.html));

  return { verdict, score: result.score, signals, page, rendered };
}

// ── enrich: contacts (regex + MX-gated guessing) ───────────────────────────

const GUESSED_LOCALS = ["info@", "hello@", "contact@", "support@"];

export async function enrichContacts(ctx: EnrichCtx, candidate: Candidate, home?: SmartFetchResult): Promise<SyncedLead> {
  const { pack, country } = ctx;
  const lead: SyncedLead = {
    ...candidate,
    score: 0,
    stage: "raw",
  };
  if (!candidate.website) return lead;

  const paths = (CONTACT_PATHS[country] ?? CONTACT_PATHS["default"] ?? []).slice(0, 3);
  const base = candidate.website.replace(/\/$/, "");
  let pages: PageContent[];
  if (home) {
    // Reuse the page the verify stage already fetched. SPAs get their
    // contact subpages rendered too — the shell would otherwise be empty.
    pages = [home.page];
    for (const p of paths) {
      const sub = home.rendered ? (await smartFetch(`${base}${p}`))?.page : await fetchPageContent(`${base}${p}`, 60_000, { retries: 1 });
      if (sub) pages.push(sub);
    }
  } else {
    pages = await fetchContactPages(candidate.website, paths);
  }

  // Sitemap-discovered contact pages (team, legal, localized contact routes)
  // — where personal emails usually live, beyond the fixed path list.
  const sitemapUrls = await discoverSitemapContactUrls(base, paths);
  for (const u of sitemapUrls) {
    const sub = home?.rendered ? (await smartFetch(u))?.page : await fetchPageContent(u, 60_000, { retries: 1 });
    if (sub && !pages.some((x) => x.url === sub.url)) pages.push(sub);
  }
  if (pages.length > 0) {
    const extraction = await extractContacts(
      pages.map((p) => ({ url: p.url, html: p.html, text: p.text })),
      10,
      8,
    );
    // LLM contact pass (before MX validation so LLM-found addresses get MX
    // too): catches obfuscated/JS-assembled emails and names the person
    // behind them — data regex cannot recover.
    if (pack.llmEnrich && llmConfigured(ctx.env)) {
      const llm = await extractContactsLlm(ctx.env, pages);
      if (llm) {
        const merged = mergeLlmContacts(extraction.emails, llm);
        extraction.emails = sortPersonalFirst(merged.emails).slice(0, 10);
        const phoneSet = new Set(extraction.phones);
        for (const p of llm.phones ?? []) if (!phoneSet.has(p)) extraction.phones.push(p);
        extraction.phones = extraction.phones.slice(0, 6);
        // A named personal email wins; otherwise fall back to the named
        // person on the page (e.g. the only doctor at a dental practice).
        if (merged.contactName) {
          lead.contact_name = merged.contactName;
          lead.contact_role = merged.contactRole;
        } else if (llm.contact?.name) {
          lead.contact_name = llm.contact.name;
          lead.contact_role = llm.contact.role;
        }
      }
    }
    await validateMxRecords(extraction);
    lead.emails = extraction.emails.map((e) => ({ address: e.address, kind: e.kind, mx_ok: e.mx_ok }));
    lead.phones = extraction.phones;
    lead.socials = extraction.socials;
  }

  if (pack.mxGuess && !(lead.emails ?? []).some((e) => e.mx_ok)) {
    const domain = safeDomain(candidate.website);
    if (domain && await mxOk(domain)) {
      lead.emails = [
        { address: GUESSED_LOCALS[0] + domain, kind: "guessed", mx_ok: true },
        { address: GUESSED_LOCALS[1] + domain, kind: "guessed", mx_ok: true },
      ];
    }
  }
  return lead;
}

function safeDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function mxOk(domain: string): Promise<boolean> {
  try {
    const { resolveMx } = await import("node:dns/promises");
    const mx = await resolveMx(domain);
    return Array.isArray(mx) && mx.length > 0;
  } catch {
    return false;
  }
}

// ── enrich: LLM contact extraction (obfuscated emails + named people) ──────

interface LlmContact {
  address: string;
  name?: string;
  role?: string;
}

interface LlmContactsOut {
  emails?: LlmContact[];
  phones?: string[];
  /** Person most worth addressing (named on the page), even without a named email. */
  contact?: { name?: string; role?: string };
}

const CONTACT_ADDR_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;

/**
 * Ask the LLM to read the rendered contact-page text and return the contact
 * details it can find. The model is explicitly forbidden from inventing
 * addresses — it may only report (or decode) what is present.
 */
export async function extractContactsLlm(env: Record<string, string>, pages: PageContent[]): Promise<LlmContactsOut | null> {
  const text = pages
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 4_000);
  if (text.trim().length < 80) return null;
  const out = await llmJson<LlmContactsOut>(
    env,
    "You extract contact details from a business website's pages. " +
      "Return STRICT JSON: {\"emails\":[{\"address\":string,\"name\":string?,\"role\":string?}],\"phones\":[string],\"contact\":{\"name\":string?,\"role\":string?}}. " +
      "Rules: include ONLY email addresses actually present in the text (decode obfuscated forms like " +
      "'tom (at) firm (dot) co uk' when unambiguous) — never invent, guess or complete addresses. " +
      "Set name/role on an email only when the text ties that person's name to the address. " +
      "Include phone numbers only with their country code if one is shown. " +
      "Set contact.name/role to the single most senior named person on the page (e.g. a named " +
      "doctor, owner or director) — only if a real name is printed, never from an initial or a title alone. " +
      "Omit any key you find nothing for.",
    `Pages:\n${text}`,
  );
  if (!out.data) return null;
  const d = out.data;
  const emails: LlmContact[] = [];
  for (const raw of Array.isArray(d.emails) ? d.emails : []) {
    if (!raw || typeof raw.address !== "string") continue;
    const address = raw.address.trim().toLowerCase().replace(/^(?:%[0-9a-f]{2})+/, "");
    if (!CONTACT_ADDR_RE.test(address)) continue;
    emails.push({
      address,
      name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 80) : undefined,
      role: typeof raw.role === "string" && raw.role.trim() ? raw.role.trim().slice(0, 80) : undefined,
    });
    if (emails.length >= 8) break;
  }
  const phones = (Array.isArray(d.phones) ? d.phones : [])
    .filter((p) => typeof p === "string" && p.replace(/\D/g, "").length >= 7)
    .slice(0, 6);
  const contact =
    d.contact && typeof d.contact.name === "string" && d.contact.name.trim()
      ? { name: d.contact.name.trim().slice(0, 80), role: typeof d.contact.role === "string" && d.contact.role.trim() ? d.contact.role.trim().slice(0, 80) : undefined }
      : undefined;
  if (emails.length === 0 && phones.length === 0 && !contact) return null;
  return { emails, phones, contact };
}

function sortPersonalFirst(emails: ExtractedEmail[]): ExtractedEmail[] {
  return [...emails].sort((a, b) =>
    a.kind === "personal" && b.kind !== "personal" ? -1 : a.kind !== "personal" && b.kind === "personal" ? 1 : 0,
  );
}

/**
 * Merge LLM-found contacts into the regex extraction (pure, for tests).
 * LLM adds addresses the regex missed; existing regex entries win on
 * duplicates. A named, non-role address becomes the lead's contact person.
 */
export function mergeLlmContacts(
  base: ExtractedEmail[],
  llm: LlmContactsOut,
): { emails: ExtractedEmail[]; contactName?: string; contactRole?: string } {
  const emails = [...base];
  const seen = new Set(base.map((e) => e.address.toLowerCase()));
  let contactName: string | undefined;
  let contactRole: string | undefined;
  for (const e of llm.emails ?? []) {
    const addr = e.address.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    const local = addr.split("@")[0] ?? "";
    const isRoleLocal = ROLE_PREFIXES.has(local);
    const kind: "role" | "personal" = e.name && !isRoleLocal ? "personal" : "role";
    emails.push({ address: e.address, kind, mx_ok: null });
    if (kind === "personal" && !contactName) {
      contactName = e.name;
      contactRole = e.role;
    }
  }
  return { emails, contactName, contactRole };
}

// ── enrich: LLM (ICP relevance + pitch-ready summary + contact sanity) ─────

interface LlmEnrichOut {
  relevant: number;
  reason: string;
  summary: string;
  bestEmail?: string;
}

export async function enrichLlm(ctx: EnrichCtx, candidate: Candidate, homeText: string): Promise<{
  relevant: number;
  reason: string;
  summary: string;
  patch: Partial<SyncedLead>;
  bestEmail?: string;
}> {
  const { pack, env } = ctx;
  const neutral = { relevant: 50, reason: "LLM unavailable", summary: "", patch: {} };
  if (!llmConfigured(env)) return neutral;

  const out = await llmJson<LlmEnrichOut>(
    env,
    "You are a B2B lead qualifier. Given a company's ICP profile and its website text, decide how well the company fits the ICP, and write a one- or two-sentence summary of what the company does (for a sales pitch). STRICT JSON: {\"relevant\":0-100,\"reason\":string,\"summary\":string,\"bestEmail\":string?}. bestEmail only if clearly present in the text and not a placeholder.",
    `ICP: ${pack.icp}\n\nCompany: ${candidate.name}${candidate.city ? ` (${candidate.city})` : ""}\nWebsite: ${candidate.website ?? "n/a"}\n\nWebsite text:\n${homeText.slice(0, 3000)}`,
  );

  if (!out.data) return neutral;
  const d = out.data;
  const relevant = Math.max(0, Math.min(100, Number(d.relevant ?? 50)));
  const bestEmail =
    d.bestEmail && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.bestEmail)
      ? d.bestEmail
      : undefined;
  return { relevant, reason: String(d.reason ?? ""), summary: String(d.summary ?? ""), patch: {}, bestEmail };
}
