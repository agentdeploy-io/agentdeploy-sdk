import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import { createReadStream } from "node:fs";
import { braveSearch } from "../../discovery.js";
import type { BraveSearchResult } from "../../types.js";

export interface RegistryCandidate {
  key: string;
  country: string;
  name: string;
  reg_number?: string;
  sic?: string;
  sic_label?: string;
  incorporated?: string;
  address?: string;
  city?: string;
  source: string;
  source_url?: string;
  website?: string;
}

interface HarvestOpts {
  query?: string;
  apiKey?: string;
  dataDir?: string;
  braveApiKey?: string;
  limit?: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type FrApiResponse = {
  results?: Array<{
    siren: string;
    nom_complet?: string;
    nom_raison_sociale?: string;
    sigle?: string;
    activite_principale?: string;
    libelle_activite_principale?: string;
    date_creation?: string;
    date_fermeture?: string | null;
    siege?: {
      adresse?: string;
      code_postal?: string;
      libelle_commune?: string;
    };
  }>;
};

type UkApiResponse = {
  items?: Array<{
    company_number: string;
    company_name?: string;
    registered_office_address?: { premises?: string; address_line_1?: string; locality?: string };
    company_status?: string;
    sic_codes?: string[];
    date_of_creation?: string;
  }>;
};

export async function harvestFR(opts: HarvestOpts): Promise<RegistryCandidate[]> {
  const { query = "agence web", limit = 20 } = opts;
  const url = `https://recherche-entreprises.api.gouv.fr/search?q=${encodeURIComponent(query)}&per_page=${limit}&etat_administratif=A`;

  const res = await fetch(url, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`FR registry ${res.status}`);

  const data = (await res.json()) as FrApiResponse;
  return (data.results ?? [])
    .filter((r) => r.date_fermeture == null)
    .map((r) => ({
      key: `fr-${r.siren}`,
      country: "fr",
      name: r.nom_complet || r.nom_raison_sociale || r.sigle || `SIREN ${r.siren}`,
      reg_number: r.siren,
      sic: r.activite_principale,
      sic_label: r.libelle_activite_principale,
      incorporated: r.date_creation,
      address: r.siege?.adresse,
      city: r.siege?.libelle_commune,
      source: "recherche-entreprises.api.gouv.fr",
      source_url: `https://www.insee.fr/fr/recherche/sirene/${r.siren}`,
    }));
}

export async function harvestUK(opts: HarvestOpts): Promise<RegistryCandidate[]> {
  const { query = "web development", apiKey, limit = 20 } = opts;

  if (!apiKey) {
    throw new Error("UK: COMPANIES_HOUSE_KEY required for API access");
  }

  const url = `https://api.companieshouse.gov.uk/advanced-search/companies?q=${encodeURIComponent(query)}&items_per_page=${limit}&include_officers=false`;
  let res = await fetch(url, {
    headers: { Accept: "application/json", Authorization: `Bearer ${apiKey}` },
  });

  if (res.status === 401 || res.status === 403) {
    // Some API keys are only accepted as basic auth (key as username, empty password).
    const basic = Buffer.from(`${apiKey}:`).toString("base64");
    res = await fetch(url, {
      headers: { Accept: "application/json", Authorization: `Basic ${basic}` },
    });
  }

  if (res.status === 401 || res.status === 403) {
    throw new Error("UK: COMPANIES_HOUSE_KEY invalid");
  }
  if (!res.ok) throw new Error(`UK registry ${res.status}`);

  const data = (await res.json()) as UkApiResponse;
  return (data.items ?? [])
    .filter((r) => (r.company_status ?? "") !== "dissolved")
    .map((r) => {
      const addr = r.registered_office_address;
      const addressParts = [addr?.premises, addr?.address_line_1].filter(Boolean);
      return {
        key: `uk-${r.company_number}`,
        country: "uk",
        name: r.company_name || `Company ${r.company_number}`,
        reg_number: r.company_number,
        sic: r.sic_codes?.[0],
        incorporated: r.date_of_creation,
        address: addressParts.join(", ") || undefined,
        city: addr?.locality,
        source: "companieshouse.gov.uk",
        source_url: `https://find-and-update.company-information.service.gov.uk/company/${r.company_number}`,
      };
    });
}

const IE_TARGET_NACE = new Set(["58", "59", "61", "62", "63", "73", "74"]);
const CRO_CSV_URL =
  "https://opendata.cro.ie/dataset/bf6f837d-0946-4c14-9a99-82cd6980c121/resource/3fef41bc-b8f4-4b10-8434-ce51c29b1bba/download/companies.csv.zip";

async function ensureCroCsv(dataDir: string, maxAgeDays = 7): Promise<string> {
  const csvPath = path.join(dataDir, "cro-companies.csv");
  const fresh =
    fs.existsSync(csvPath) &&
    Date.now() - (fs.statSync(csvPath).mtimeMs ?? 0) < maxAgeDays * 86_400_000;

  if (fresh) return csvPath;

  const zipPath = path.join(dataDir, "cro-companies.csv.zip");
  const res = await fetch(CRO_CSV_URL);
  if (!res.ok) throw new Error(`CRO download ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(zipPath, buf);

  const AdmZip = (await import("adm-zip")).default;
  const zip = new AdmZip(zipPath);
  const entry = zip.getEntries().find((e: { entryName: string }) => e.entryName.endsWith(".csv"));
  if (!entry) throw new Error("CRO zip missing CSV entry");
  fs.writeFileSync(csvPath, entry.getData());

  return csvPath;
}

function parseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
      } else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { cells.push(cur); cur = ""; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

export async function harvestIE(opts: HarvestOpts): Promise<RegistryCandidate[]> {
  const { dataDir = "/data", limit = 20 } = opts;

  const csvPath = await ensureCroCsv(dataDir);
  const yearsCutoff = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString().slice(0, 10);

  const picked: RegistryCandidate[] = [];
  const seenNace = new Map<string, number>();
  const perNaceLimit = Math.ceil(limit / 4);

  const stream = createReadStream(csvPath, { encoding: "utf8" });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

  let headerLine = true;
  let header: string[] = [];
  const col = (name: string) => header.indexOf(name);

  for await (const line of rl) {
    if (headerLine) {
      header = line.split(",").map((h) => h.trim());
      headerLine = false;
      continue;
    }

    if (picked.length >= limit) break;

    const cells = parseCsvLine(line);
    const cNum = col("company_num");
    const cName = col("company_name");
    const cStatus = col("company_status");
    const cReg = col("company_reg_date");
    const cAddr4 = col("company_address_4");
    const cNace = col("nace_v2_code");

    const status = (cells[cStatus] ?? "").trim();
    if (status !== "Normal") continue;

    const reg = cells[cReg] ?? "";
    if (!reg || reg < yearsCutoff) continue;

    const nace = (cells[cNace] ?? "").slice(0, 2);
    if (!IE_TARGET_NACE.has(nace)) continue;

    const perNace = seenNace.get(nace) ?? 0;
    if (perNace >= perNaceLimit) continue;
    seenNace.set(nace, perNace + 1);

    const name = (cells[cName] ?? "").trim();
    const num = cells[cNum] ?? "";
    if (!name || name.length < 4) continue;

    picked.push({
      key: `ie-${num}`,
      country: "ie",
      name,
      reg_number: num,
      sic: nace,
      incorporated: reg,
      city: (cells[cAddr4] ?? "").split(",")[0]?.trim() || undefined,
      source: "opendata.cro.ie (CRO register)",
      source_url: `https://www.cro.ie/company-details/${num}`,
    });
  }

  rl.close();
  stream.destroy();

  return picked.slice(0, limit);
}

export async function harvestEE(opts: HarvestOpts): Promise<RegistryCandidate[]> {
  const { query = "tarkvara", limit = 10 } = opts;
  const url = `https://ariregister.rik.ee/eng/company_search?phrase=${encodeURIComponent(query)}`;

  const res = await fetch(url, {
    headers: { Accept: "text/html" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`EE registry ${res.status}`);

  const html = await res.text();
  const out: RegistryCandidate[] = [];
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
      reg_number: regM[1],
      source: "ariregister.rik.ee",
      source_url: `https://ariregister.rik.ee/eng/company/${regM[1]}`,
    });
    if (out.length >= limit) break;
  }

  return out;
}

const PT_QUERIES = [
  "agência web site:.pt",
  "desenvolvimento de software site:.pt",
  "agência digital marketing site:.pt",
];

function domainToName(host: string, titleHint?: string): string {
  if (titleHint) {
    const first = titleHint.split(/\s*[|–—•]\s*/)[0].trim();
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

export async function harvestPT(opts: HarvestOpts): Promise<RegistryCandidate[]> {
  const { braveApiKey, limit = 15 } = opts;
  if (!braveApiKey) {
    throw new Error("PT: braveApiKey required for web discovery");
  }

  const allResults: BraveSearchResult[] = [];
  for (const q of PT_QUERIES) {
    try {
      const results = await braveSearch(q, { apiKey: braveApiKey, country: "pt" }, 5);
      allResults.push(...results);
    } catch {
      continue;
    }
    await sleep(600);
  }

  const seen = new Set<string>();
  const candidates: RegistryCandidate[] = [];

  for (const r of allResults) {
    let u: URL;
    try { u = new URL(r.url); } catch { continue; }
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (seen.has(host)) continue;
    if (!host.endsWith(".pt")) continue;
    seen.add(host);

    candidates.push({
      key: `pt-${host}`,
      country: "pt",
      name: domainToName(host, r.title),
      website: `https://${host}`,
      source: "brave-search (pt web discovery)",
      source_url: r.url,
    });

    if (candidates.length >= limit) break;
  }

  return candidates;
}
