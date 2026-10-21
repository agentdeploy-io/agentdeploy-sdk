// Registry clients. No-key registries first; each returns normalized candidates.

export type Candidate = {
  key: string;
  country: string;
  name: string;
  sic?: string;
  incorporated?: string;
  city?: string;
  officers: string[];
  source: string;
  source_url?: string;
  website?: string;
  status_note?: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ── France: recherche-entreprises.api.gouv.fr (open JSON API) ──────────────

type FrResult = {
  siren: string;
  nom_complet?: string;
  nom_raison_sociale?: string;
  sigle?: string;
  activite_principale?: string;
  date_creation?: string;
  date_fermeture?: string | null;
  dirigeants?: Array<{ nom?: string; prenoms?: string; quality?: string }>;
  siege?: { code_postal?: string; libelle_commune?: string };
};

export async function frSearch(
  query: string,
  perPage = 10
): Promise<Candidate[]> {
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=${perPage}`;
  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`FR search ${res.status}`);
  const data = (await res.json()) as { results?: FrResult[] };
  return (data.results ?? [])
    .filter((r) => r.date_fermeture == null)
    .map((r) => ({
      key: `fr-${r.siren}`,
      country: "fr",
      name: r.nom_complet || r.nom_raison_sociale || r.sigle || `SIREN ${r.siren}`,
      sic: r.activite_principale,
      incorporated: r.date_creation,
      city: r.siege?.libelle_commune,
      officers: (r.dirigeants ?? [])
        .map((d) => [d.prenoms, d.nom].filter(Boolean).join(" "))
        .filter(Boolean)
        .slice(0, 5),
      source: "recherche-entreprises.api.gouv.fr",
      source_url: `https://www.insee.fr/fr/recherche/sirene/${r.siren}`,
    }));
}

// ── UK: Companies House advanced search (needs COMPANIES_HOUSE_KEY) ────────

type UkResult = {
  company_number: string;
  title?: string;
  registered_office_address?: { locality?: string; premises?: string };
  company_status?: string;
  sic_codes?: string[];
  incorporated_on?: string;
};

export async function ukSearch(
  query: string,
  apiKey: string,
  limit = 10
): Promise<Candidate[]> {
  const url = `https://api.companieshouse.gov.uk/advanced-search/companies?q=${encodeURIComponent(query)}&items_per_page=${limit}&include_officers=false`;
  const res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error("UK: COMPANIES_HOUSE_KEY invalid");
  }
  if (!res.ok) throw new Error(`UK search ${res.status}`);
  const data = (await res.json()) as { items?: UkResult[] };
  return (data.items ?? [])
    .filter((r) => (r.company_status ?? "") !== "dissolved")
    .map((r) => ({
      key: `uk-${r.company_number}`,
      country: "uk",
      name: r.title || `Company ${r.company_number}`,
      sic: r.sic_codes?.[0],
      incorporated: r.incorporated_on,
      city: r.registered_office_address?.locality,
      officers: [],
      source: "companieshouse.gov.uk",
      source_url: `https://find-and-update.company-information.service.gov.uk/company/${r.company_number}`,
    }));
}

// ── Estonia: e-Äriregister HTML search (crawled with Cheerio) ───────────────

export function eeSearchUrl(query: string): string {
  return `https://ariregister.rik.ee/eng/company_search?phrase=${encodeURIComponent(query)}`;
}

export function parseEeResults(html: string): Candidate[] {
  const out: Candidate[] = [];
  const rowRe = /<tr[^>]*>[\s\S]*?<\/tr>/g;
  let m: RegExpExecArray | null;
  while ((m = rowRe.exec(html)) !== null) {
    const row = m[0];
    const nameM = row.match(/class="[^"]*name[^"]*"[^>]*>([^<]{3,120})/i) || row.match(/>([A-ZÄÖÜ0-9][^<]{3,119})</);
    const regM = row.match(/(\d{7})/);
    if (!nameM || !regM) continue;
    const name = nameM[1].trim();
    if (!name || name.toLowerCase().startsWith("search")) continue;
    out.push({
      key: `ee-${regM[1]}`,
      country: "ee",
      name,
      officers: [],
      source: "ariregister.rik.ee",
      source_url: `https://ariregister.rik.ee/eng/company/${regM[1]}`,
    });
    if (out.length >= 10) break;
  }
  return out;
}

// ── UK (no key): Companies House public HTML, two-stage crawl ──────────────
// Stage 1: search results page (server-rendered) → company numbers + names.
// Stage 2: company detail page → status / SIC / incorporation date.

export function ukSearchUrl(query: string, page = 1): string {
  return `https://find-and-update.company-information.service.gov.uk/search?q=${encodeURIComponent(query)}${page > 1 ? `&starting=${page * 20}` : ""}`;
}

export type UkCard = {
  number: string;
  name: string;
  incorporated?: string;
  city?: string;
};

export function parseUkSearch(html: string): UkCard[] {
  const out: UkCard[] = [];
  const blocks = html.split('<li class="type-company">').slice(1);
  for (const b of blocks) {
    const linkM = b.match(/href="\/company\/([0-9A-Z]{5,12})"[\s\S]*?<a[^>]*>([^<]{3,120})<\/a>/) || b.match(/<a class="govuk-link" href="\/company\/([0-9A-Z]{5,12})"[^>]*>\s*([^<]+?)\s*<\/a>/);
    if (!linkM) continue;
    const number = linkM[1];
    const name = linkM[2].trim();
    const metaM = b.match(/meta crumbtrail[^>]*>\s*([0-9A-Z]{5,12})\s*-\s*Incorporated on\s*([^<]+?)\s*</);
    const addrM = b.match(/<p>([^<]{5,120})<\/p>/);
    out.push({
      number,
      name,
      incorporated: metaM?.[2]?.trim(),
      city: addrM?.[1]?.split(",").slice(-2, -1)[0]?.trim(),
    });
    if (out.length >= 20) break;
  }
  return out;
}

export type UkDetail = { status: string; sic: string | null; incorporated: string | null };

export function parseUkDetail(html: string): UkDetail {
  const statusBlock = html.match(/id="company-status"[\s\S]{0,200}?>([A-Za-z][A-Za-z ]{2,40})</);
  const sicBlock = html.match(/id="sic0"[\s\S]{0,100}?>([0-9]{5})\s*-\s*([^<]{3,80})</);
  const incBlock = html.match(/Incorporated on[\s\S]{0,400}?>([0-9]{1,2}\s+[A-Z][a-z]+ \d{4})</);
  return {
    status: statusBlock ? statusBlock[1].trim() : "",
    sic: sicBlock ? sicBlock[1] : null,
    incorporated: incBlock ? incBlock[1].trim() : null,
  };
}

// ── Ireland: CRO open-data register (opendata.cro.ie, refreshed monthly) ───
// 180k+ companies with status, registration date, county and NACE code.
// The official cro.ie search UI is Cloudflare-walled; the open-data CSV is
// the sanctioned bulk source.

import AdmZip from "adm-zip";

const CRO_CSV_URL =
  "https://opendata.cro.ie/dataset/bf6f837d-0946-4c14-9a99-82cd6980c121/resource/3fef41bc-b8f4-4b10-8434-ce51c29b1bba/download/companies.csv.zip";

// NACE 2-digit sections that match small businesses with automation surface.
const IE_TARGET_NACE = new Set(["58", "59", "61", "62", "63", "73", "74"]);

type CsvRow = Record<string, string>;

/** Minimal streaming RFC-4180 row parser (handles quoted commas). */
export function csvRows(line: string): CsvRow | null {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells.length > 1 ? (Object.fromEntries(cells.map((c, i) => [String(i), c])) as CsvRow) : null;
}

export async function ieSearch(
  dataDir: string,
  opts: { maxAgeDays?: number; limit?: number } = {}
): Promise<Candidate[]> {
  const { maxAgeDays = 7, limit = 12 } = opts;
  const fs = await import("node:fs");
  const path = await import("node:path");
  const csvPath = path.join(dataDir, "cro-companies.csv");

  // Cache the extracted CSV on the volume (rootfs is ephemeral).
  const fresh =
    fs.existsSync(csvPath) &&
    Date.now() - (fs.statSync(csvPath).mtimeMs ?? 0) < maxAgeDays * 86400_000;
  if (!fresh) {
    const zipPath = path.join(dataDir, "cro-companies.csv.zip");
    const res = await fetch(CRO_CSV_URL);
    if (!res.ok) throw new Error(`CRO download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!fresh) fs.writeFileSync(zipPath, buf);
    const zip = new AdmZip(zipPath);
    const entry = zip.getEntries().find((e) => e.entryName.endsWith(".csv"));
    if (!entry) throw new Error("CRO zip missing csv");
    fs.writeFileSync(csvPath, entry.getData());
  }

  const yearsCutoff = `${new Date(Date.now() - 3 * 365 * 86400_000).toISOString().slice(0, 10)}`;
  const picked: Candidate[] = [];
  const seenNace = new Map<string, number>();
  let i = 0;
  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  const header = lines[0].split(",").map((h) => h.trim());
  const col = (name: string) => header.indexOf(name);
  const cNum = col("company_num"), cName = col("company_name"), cStatus = col("company_status");
  const cType = col("company_type"), cReg = col("company_reg_date"), cAddr4 = col("company_address_4");
  const cNace = col("nace_v2_code");
  for (let li = 1; li < lines.length && picked.length < limit * 4; li++) {
    const line = lines[li];
    if (!line) continue;
    const cells: string[] = [];
    let cur = "";
    let inQ = false;
    for (let ci = 0; ci < line.length; ci++) {
      const ch = line[ci];
      if (inQ) {
        if (ch === '"') { if (line[ci + 1] === '"') { cur += '"'; ci++; } else inQ = false; } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === ",") { cells.push(cur); cur = ""; }
      else cur += ch;
    }
    cells.push(cur);
    const status = (cells[cStatus] ?? "").trim();
    if (status !== "Normal") continue;
    const reg = cells[cReg] ?? "";
    if (!reg || reg < yearsCutoff) continue;
    const nace = (cells[cNace] ?? "").slice(0, 2);
    if (!IE_TARGET_NACE.has(nace)) continue;
    const perNace = seenNace.get(nace) ?? 0;
    if (perNace >= Math.ceil(limit / 4)) continue; // spread across verticals
    seenNace.set(nace, perNace + 1);
    const name = (cells[cName] ?? "").trim();
    const num = cells[cNum] ?? String(i);
    if (!name || name.length < 4) continue;
    i += 1;
    picked.push({
      key: `ie-${num}`,
      country: "ie",
      name,
      sic: nace,
      incorporated: reg,
      city: (cells[cAddr4] ?? "").split(",")[0]?.trim() || undefined,
      officers: [],
      source: "opendata.cro.ie (CRO register)",
      source_url: `https://www.cro.ie/company-details/${num}`,
    });
    if (picked.length >= limit * 4) break;
  }
  return picked.slice(0, limit);
}

// ── PT: no open registry reachable (data.gov.pt unreachable from this ──────
// network, DR JS-rendered, OpenCorporates paywalled) → Brave web discovery
// scoped to .pt, followed by the shared site-crawl phase for contacts.

export function domainToName(host: string, titleHint?: string): string {
  if (titleHint) {
    const first = titleHint.split(/\s*[|–—•]\s*/)[0].trim();
    // Only trust short, plain title fragments as names.
    if (first.length >= 4 && first.length <= 40 && /\s/.test(first) && !/\d{4}/.test(first)) {
      return first;
    }
  }
  const base = host.replace(/^www\./, "").split(".")[0] || host;
  const tldWords = ["co", "uk", "ie", "pt", "com", "org", "net"];
  const parts = host.replace(/^www\./, "").split(".").filter((p) => !tldWords.includes(p.toLowerCase()));
  const raw = (parts.join(" ") || base)
    .replace(/[-_+]/g, " ")
    .replace(/\d{2,}/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!raw) return host;
  return raw
    .split(" ")
    .map((w) => (w.length > 2 ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

export const REGISTRY_QUERIES: Record<string, string[]> = {
  fr: ["agence web", "développement web", "consultant digital", "studio création", "agence marketing digital"],
  uk: ["web development agency", "digital marketing agency", "software consultancy"],
  ee: ["võrguarendus", "tarkvara", "digital agency"],
  ie: ["web design agency site:.ie", "software company Dublin site:.ie", "digital marketing agency site:.ie"],
  pt: ["agência web site:.pt", "desenvolvimento de software site:.pt", "agência digital marketing site:.pt"],
};

export { sleep };
