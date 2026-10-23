// AI Scraper Builder service: generate scraper code with the LLM, smoke-test
// it in a sandboxed child process, and register approved scrapers.

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { llmConfigured, llmJson } from "../pipeline/llm.js";
import type { VerticalPack } from "../pipeline/types.js";
import { registerCustomSource, unregisterCustomSource, validateScraperCode, listCustomSources } from "../pipeline/custom-sources.js";

const RUNNER = fileURLToPath(new URL("./runner.js", import.meta.url));

const SCRAPER_SYSTEM = `You are a scraper generator for a lead-gen pipeline. Given a description of where to find companies, write ONE CommonJS module that discovers candidate websites.

CONTRACT (the module must be exactly this shape):
module.exports = {
  id: "kebab-case-id",           // unique, matches the source name
  description: "one line: what this finds",
  async discover(ctx) { ... }    // returns Array<{url, title, description?}>
};

ctx is provided — never invent it:
- ctx.country  — "uk" | "fr" | "ie" | "ee" | "pt" (current run country)
- ctx.limit    — max hits to return (ALWAYS respect it)
- ctx.pack     — the vertical: { name, icp, countries, dorks, cities, sicInclude, sicExclude }
- ctx.env      — API keys: BRAVE_API_KEY, COMPANIES_HOUSE_KEY (Basic auth, key as username)
- ctx.search   — (query) => Promise<{hits: [{url, title, description}], via}> — the pipeline search stack (Brave + LLM fallback); use it for web searches
- ctx.drops    — { [reason]: count } — increment it when you skip rows

RULES:
- CommonJS only: module.exports = { ... }. No imports, no require(), no process, no fs, no path.
- Globals you may use: fetch, URL, URLSearchParams, JSON, Math, Date, RegExp, AbortSignal, TextDecoder, TextEncoder, setTimeout (max 5000ms), clearTimeout, console, Array, String, Number, Object.
- Every fetch: https or http, with AbortSignal.timeout(20000), and check res.ok.
- Best-effort: on ANY error return [] (or skip the row + ctx.drops["reason"]++). NEVER throw.
- Prefer stable public APIs / CDX endpoints over scraping HTML pages.
- Return at most ctx.limit hits; each hit needs a real absolute url and a short title.

Return STRICT JSON, no markdown fences:
{"id": "...", "description": "...", "code": "complete module source as a single string"}`;

const FEW_SHOT = `Example for the request "find UK business sites that have a /web-design page archived on the Wayback Machine":
{"id":"wayback-webdesign","description":"<TLD> sites with a web-design page in the Wayback Machine CDX index","code":"module.exports = {\\n  id: 'wayback-webdesign',\\n  description: '<TLD> sites with a web-design page in the Wayback Machine CDX index',\\n  async discover(ctx) {\\n    const tld = { uk: 'co.uk', fr: 'fr', ie: 'ie', ee: 'ee', pt: 'pt' }[ctx.country] || 'com';\\n    const q = 'http://web.archive.org/cdx/search/cdx?url=*.' + tld + '*&filter=urlkey:.*web[-_]?design.*&fl=original&collapse=urlkey&limit=' + ctx.limit;\\n    try {\\n      const res = await fetch(q, { signal: AbortSignal.timeout(20000) });\\n      if (!res.ok) return [];\\n      const lines = (await res.text()).split('\\\\n').filter(Boolean);\\n      return lines.map((l) => ({ url: l, title: new URL(l).hostname, description: 'archived page with a web-design URL' }));\\n    } catch (e) { return []; }\\n  },\\n};\\n"}`;

export interface GeneratedScraper {
  id: string;
  description: string;
  code: string;
}

export async function generateScraper(prompt: string, env: Record<string, string | undefined>): Promise<GeneratedScraper> {
  const clean: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (typeof v === "string") clean[k] = v;
  if (!llmConfigured(clean)) throw new Error("LLM_API_KEY not set — cannot generate scrapers");
  const { data, error } = await llmJson<{ id?: string; description?: string; code?: string }>(
    clean,
    SCRAPER_SYSTEM,
    `${FEW_SHOT}\n\nNOW: ${prompt}\nReturn the strict JSON object.`,
  );
  if (!data || typeof data.code !== "string" || !data.code.trim()) {
    throw new Error(`LLM returned no usable code${error ? ` (${error})` : ""}`);
  }
  const check = validateScraperCode(data.code);
  if (!check.ok) throw new Error(`generated code failed validation: ${check.error}`);
  return { id: check.id, description: data.description ?? check.description, code: data.code };
}

export interface ScraperTestResult {
  ok: boolean;
  hits?: Array<{ url: string; title: string; description: string }>;
  error?: string;
}

/** Smoke-test scraper code in a separate, memory-capped, timed child process. */
export function testScraper(
  code: string,
  pack: VerticalPack,
  env: Record<string, string | undefined>,
  country?: string,
  limit = 15,
): Promise<ScraperTestResult> {
  const check = validateScraperCode(code);
  if (!check.ok) return Promise.resolve({ ok: false, error: check.error });
  const payload = {
    code,
    pack,
    country: country ?? pack.countries[0] ?? "uk",
    limit,
    env: {
      BRAVE_API_KEY: env.BRAVE_API_KEY,
      COMPANIES_HOUSE_KEY: env.COMPANIES_HOUSE_KEY,
      LLM_API_KEY: env.LLM_API_KEY,
      LLM_BASE_URL: env.LLM_BASE_URL,
      LLM_MODEL: env.LLM_MODEL,
      DATA_DIR: env.DATA_DIR,
    },
  };
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--max-old-space-size=256", RUNNER, JSON.stringify(payload)], {
      env: { PATH: process.env.PATH, DATA_DIR: env.DATA_DIR, HOME: process.env.HOME },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve({ ok: false, error: "smoke test timed out (70s)" });
    }, 70_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({ ok: false, error: `runner failed to start: ${e.message}` });
    });
    child.on("close", (codeExit) => {
      clearTimeout(timer);
      const line = stdout.split("\n").find((l) => l.startsWith("SCRAPER_OK") || l.startsWith("SCRAPER_FAIL"));
      if (!line) {
        resolve({ ok: false, error: `runner exited ${codeExit} without result: ${stderr.slice(0, 300)}` });
        return;
      }
      if (line.startsWith("SCRAPER_FAIL")) {
        resolve({ ok: false, error: line.slice("SCRAPER_FAIL ".length).slice(0, 500) });
        return;
      }
      try {
        const hits = JSON.parse(line.slice("SCRAPER_OK ".length)) as ScraperTestResult["hits"];
        resolve({ ok: true, hits });
      } catch (e) {
        resolve({ ok: false, error: `bad result payload: ${e instanceof Error ? e.message : String(e)}` });
      }
    });
  });
}

export function registerScraper(dataDir: string, id: string, description: string, code: string) {
  return registerCustomSource(dataDir, id, description, code);
}

export function removeScraper(dataDir: string, id: string): boolean {
  if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(id)) return false;
  return unregisterCustomSource(dataDir, id);
}

export function listScrapers() {
  return listCustomSources();
}
