// Core agent: lead discovery (Crawlee) + jev classification + Brave research.
//
// Task flow (driven by the edge agent over the supervisor protocol):
//   scrape   → registries (FR/EE/PT/UK) → website discovery (Brave) → site crawl (Crawlee) → sqlite
//   research → jev classify → Brave + LLM "what AI agents does this business need" → push to edge

import { createCoreAgent, defineTaskHandler } from "@agentdeploy-io/core-sdk";
import type { TaskContext } from "@agentdeploy-io/core-sdk";
import { z } from "zod";
import { CheerioCrawler, Request } from "crawlee";
import {
  frSearch, ukSearch, eeSearchUrl, parseEeResults, ieSearch,
  ukSearchUrl, parseUkSearch, parseUkDetail,
  REGISTRY_QUERIES, sleep, type Candidate,
} from "./registries.js";
import { braveWebSearch, pickWebsite, crawlSite, webDiscover } from "./discover.js";
import { sicHint } from "./extract.js";

type LeadRow = {
  key: string;
  country: string;
  name: string;
  sic: string | null;
  sic_label: string | null;
  incorporated: string | null;
  city: string | null;
  officers: string;
  website: string | null;
  emails: string;
  phones: string;
  socials: string;
  source: string;
  source_url: string | null;
  discovered_at: string;
  stage: string;
  classification: string | null;
  research: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
  key TEXT PRIMARY KEY,
  country TEXT NOT NULL,
  name TEXT NOT NULL,
  sic TEXT, sic_label TEXT,
  incorporated TEXT,
  city TEXT,
  officers TEXT,
  website TEXT,
  emails TEXT,
  phones TEXT,
  socials TEXT,
  source TEXT,
  source_url TEXT,
  discovered_at TEXT,
  stage TEXT DEFAULT 'raw',
  classification TEXT,
  research TEXT
);
CREATE INDEX IF NOT EXISTS idx_leads_stage ON leads(stage);
CREATE INDEX IF NOT EXISTS idx_leads_country ON leads(country);
`;

const scrapeHandler = defineTaskHandler({
  description: "Discover businesses from public registries, find their websites (Brave), crawl sites for contacts (Crawlee), store enriched leads.",
  inputSchema: z.object({
    countries: z.array(z.enum(["uk", "fr", "ee", "pt", "ie"])).optional(),
    queries: z.record(z.string(), z.array(z.string())).optional(),
    limit: z.number().int().min(1).max(200).default(40),
  }),

  async execute(input, ctx) {
    const braveKey = ctx.secrets.has("BRAVE_API_KEY") ? ctx.secrets.get("BRAVE_API_KEY") : (process.env.BRAVE_API_KEY || "");
    const chKey = ctx.secrets.has("COMPANIES_HOUSE_KEY") ? ctx.secrets.get("COMPANIES_HOUSE_KEY") : (process.env.COMPANIES_HOUSE_KEY || "");
    const countries = input.countries ?? ["uk", "ie", "pt", "fr", "ee"];
    const limit = input.limit;

    const skipped: string[] = [];
    if (!chKey) skipped.push("uk:using public HTML crawl (no COMPANIES_HOUSE_KEY)");
    if (!braveKey) skipped.push("ie/pt:Brave discovery needs BRAVE_API_KEY");

    // Phase 1 — registry candidates
    const candidates = new Map<string, Candidate>();
    for (const country of countries) {
      if (country === "ie") {
        // Full-register scan — no queries; vertical + recency filters inside.
        try {
          const dataDir = process.env.DATA_DIR || "/data";
          const found = await ieSearch(dataDir, { limit: 12 });
          for (const c of found) if (!candidates.has(c.key)) candidates.set(c.key, c);
          ctx.reportProgress("registry", { country: "ie", query: "full register (NACE-filtered)", found: found.length, total: candidates.size });
        } catch (e) {
          console.warn(`[scrape] ie: ${(e as Error).message}`);
        }
        continue;
      }
      const queries = (input.queries?.[country] ?? REGISTRY_QUERIES[country] ?? []).slice(0, 3);
      if (queries.length === 0) continue;
      for (const q of queries) {
        try {
          let found: Candidate[] = [];
          if (country === "fr") {
            found = await frSearch(q, 8);
          } else if (country === "uk") {
            if (chKey) {
              found = await ukSearch(q, chKey, 8);
            } else {
              found = await ukHtmlCrawl(q); // Companies House public HTML
            }
          } else if (country === "pt") {
            // No open registry reachable — Brave discovery scoped to .pt.
            const sites = braveKey ? await webDiscover(q, country, braveKey, 5) : [];
            for (const s of sites) {
              found.push({
                key: `pt-web-${s.domain.replace(/[^a-z0-9]/gi, "").slice(0, 32)}`,
                country: "pt",
                name: s.name,
                website: `https://${s.domain}`,
                officers: [],
                source: "brave-web-discovery",
              });
            }
          } else if (country === "ee") {
            const res = await fetch(eeSearchUrl(q), { headers: { accept: "text/html" } });
            if (res.ok) found = parseEeResults(await res.text());
          }
          for (const c of found) {
            if (!candidates.has(c.key)) candidates.set(c.key, c);
          }
          ctx.reportProgress("registry", { country, query: q, found: found.length, total: candidates.size });
          await sleep(500);
        } catch (e) {
          console.warn(`[scrape] ${country} "${q}": ${(e as Error).message}`);
        }
      }
    }

    // Distribute the limit across countries that produced candidates.
    const byCountry = new Map<string, Candidate[]>();
    for (const c of candidates.values()) {
      const arr = byCountry.get(c.country) ?? [];
      arr.push(c);
      byCountry.set(c.country, arr);
    }
    const quota = Math.ceil(limit / Math.max(1, byCountry.size));
    const picked: Candidate[] = [];
    for (const arr of byCountry.values()) picked.push(...arr.slice(0, quota));
    picked.sort(() => 0.5 - Math.random()); // shuffle so one country can't dominate
    const pickedFinal = picked.slice(0, limit);

    ctx.reportProgress("discovered", { candidates: candidates.size, picked: picked.length });

    // Phase 2 — persist raw leads
    const now = new Date().toISOString();
    for (const c of pickedFinal) {
      ctx.sql.run(
        "INSERT OR IGNORE INTO leads (key, country, name, sic, sic_label, incorporated, city, officers, website, source, source_url, discovered_at, stage) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'raw')",
        c.key, c.country, c.name, c.sic ?? null, sicHint(c.sic) ?? null, c.incorporated ?? null, c.city ?? null, JSON.stringify(c.officers), c.website ?? null, c.source, c.source_url ?? null, now
      );
    }

    // Phase 3 — website discovery (Brave) + Phase 4 — site crawl (Crawlee)
    let withWebsite = 0;
    let withEmail = 0;
    if (braveKey) {
      for (const c of pickedFinal) {
        const row = ctx.sql.get<LeadRow>("SELECT * FROM leads WHERE key = ?", c.key);
        if (row?.website) {
          withWebsite += 1;
          continue;
        }
        try {
          const q = `${c.name}${c.city ? ` ${c.city}` : ""}`.slice(0, 120);
          const results = await braveWebSearch(q, { apiKey: braveKey, country: c.country }, 5);
          const website = pickWebsite(results, c.name);
          if (website) {
            ctx.sql.run("UPDATE leads SET website = ? WHERE key = ?", website, c.key);
            withWebsite += 1;
          }
          await sleep(1100); // Brave free tier pacing
        } catch (e) {
          console.warn(`[discovery] ${c.key}: ${(e as Error).message}`);
        }
      }
    } else {
      skipped.push("site-discovery:no BRAVE_API_KEY");
    }

    const toCrawl = ctx.sql
      .all<{ key: string; country: string; website: string }>(
        "SELECT key, country, website FROM leads WHERE stage = 'raw' AND website IS NOT NULL AND website != ''"
      )
      .slice(0, limit);

    for (const lead of toCrawl) {
      const contacts = await crawlSite(lead.website, lead.country);
      if (contacts && (contacts.emails.length > 0 || contacts.phones.length > 0)) {
        ctx.sql.run(
          "UPDATE leads SET emails = ?, phones = ?, socials = ?, stage = 'enriched' WHERE key = ?",
          JSON.stringify(contacts.emails), JSON.stringify(contacts.phones), JSON.stringify(contacts.socials), lead.key
        );
      } else {
        ctx.sql.run("UPDATE leads SET stage = 'enriched' WHERE key = ?", lead.key);
      }
      if (contacts?.emails.length) withEmail += 1;
      ctx.reportProgress("crawl", { done: toCrawl.indexOf(lead) + 1, total: toCrawl.length, withEmail });
    }

    // Leads without a website stay 'enriched' too (jev can still classify them).
    ctx.sql.run("UPDATE leads SET stage = 'enriched' WHERE stage = 'raw'");

    const counts = ctx.sql.get<{ raw: number; enriched: number; total: number }>(
      "SELECT COUNT(*) AS total, SUM(CASE WHEN stage = 'enriched' THEN 1 ELSE 0 END) AS enriched, SUM(CASE WHEN stage = 'raw' THEN 1 ELSE 0 END) AS raw FROM leads"
    );

    return {
      state: "succeeded",
      output: {
        discovered: pickedFinal.length,
        candidates: candidates.size,
        withWebsite,
        withEmail,
        enriched: counts?.enriched ?? 0,
        total: counts?.total ?? 0,
        skipped,
      },
    };
  },
});

const researchHandler = defineTaskHandler({
  description: "Classify enriched leads with the jev worker, then research HOT/WARM leads via Brave + LLM to determine which AI agents the business would need. Pushes results to the edge agent.",
  inputSchema: z.object({
    classifyLimit: z.number().int().min(1).max(50).default(25),
    researchLimit: z.number().int().min(1).max(25).default(10),
    tiers: z.array(z.enum(["HOT", "WARM"])).default(["HOT", "WARM"]),
  }),

  async execute(input, ctx) {
    const jevUrl = process.env.AD_JEV_URL || "";
    const braveKey = ctx.secrets.has("BRAVE_API_KEY") ? ctx.secrets.get("BRAVE_API_KEY") : (process.env.BRAVE_API_KEY || "");
    const callback = process.env.AD_EDGE_CALLBACK_URL || "";
    const syncSecret = process.env.AD_SYNC_SECRET || "";

    // Step 1 — jev classification
    let classified = 0;
    const pending = ctx.sql
      .all<LeadRow>("SELECT * FROM leads WHERE stage = 'enriched' AND classification IS NULL ORDER BY rowid DESC LIMIT ?", input.classifyLimit);
    if (pending.length > 0) {
      if (!jevUrl) {
        throw new Error("AD_JEV_URL not configured — cannot classify");
      }
      const res = await fetch(`${jevUrl.replace(/\/$/, "")}/v1/classify`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          leads: pending.map((l) => ({
            key: l.key, name: l.name, country: l.country, sic: l.sic ?? undefined,
            incorporated: l.incorporated ?? undefined,
            officers: safeJson(l.officers, []),
            website: l.website ?? undefined,
            emails: safeJson(l.emails, []),
          })),
          context: { focus: "AI agents for small business" },
        }),
      });
      if (!res.ok) throw new Error(`jev classify ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { classifications: any[] };
      for (const c of data.classifications) {
        ctx.sql.run("UPDATE leads SET classification = ?, stage = 'classified' WHERE key = ?", JSON.stringify(c), c.key);
        classified += 1;
      }
    }

    // Step 2 — Brave + LLM research for top tiers
    let researched = 0;
    const hotWarm = ctx.sql
      .all<LeadRow>(
        `SELECT * FROM leads
         WHERE stage = 'classified' AND research IS NULL
           AND json_extract(classification, '$.tier') IN (${input.tiers.map(() => "?").join(",")})
         ORDER BY json_extract(classification, '$.fit') DESC
         LIMIT ?`,
        ...input.tiers, input.researchLimit
      );

    for (const lead of hotWarm) {
      const cls = safeJson(lead.classification, {}) as any;
      const vertical = cls.vertical || sicHint(lead.sic ?? undefined) || "small business";
      let sources: Array<{ title: string; url: string; description: string }> = [];
      let snippets: string[] = [];
      if (braveKey) {
        try {
          const q = `"${lead.name}" ${vertical}`.slice(0, 150);
          sources = (await braveWebSearch(q, { apiKey: braveKey, country: lead.country }, 5)).slice(0, 4);
          snippets = sources.slice(0, 3).map((s) => `${s.title}: ${s.description}`).join("\n").slice(0, 2500);
          await sleep(1100);
        } catch (e) {
          console.warn(`[research] brave ${lead.key}: ${(e as Error).message}`);
        }
      }
      const synthesis = await synthesizeAgents(ctx, lead, cls, vertical, sources, snippets);
      ctx.sql.run(
        "UPDATE leads SET research = ?, stage = 'researched' WHERE key = ?",
        JSON.stringify(synthesis), lead.key
      );
      researched += 1;
      ctx.reportProgress("research", { done: researched, total: hotWarm.length, lead: lead.key });
    }

    // Step 3 — push classified/researched leads to the edge agent
    let pushed = 0;
    if (callback && syncSecret) {
      const rows = ctx.sql.all<LeadRow>(
        "SELECT * FROM leads WHERE stage IN ('classified', 'researched') ORDER BY rowid DESC LIMIT 200"
      );
      try {
        const pres = await fetch(`${callback.replace(/\/$/, "")}/inbound/sync`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-AD-Sync": syncSecret },
          body: JSON.stringify({
            deployment_id: ctx.deploymentId,
            pushed_at: new Date().toISOString(),
            leads: rows,
          }),
        });
        if (pres.ok) pushed = rows.length;
      } catch (e) {
        console.warn(`[sync] push failed: ${(e as Error).message}`);
      }
    }

    const stats = ctx.sql.get<{ total: number; classified: number; researched: number; hot: number; warm: number }>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN stage IN ('classified','researched') THEN 1 ELSE 0 END) AS classified,
              SUM(CASE WHEN stage = 'researched' THEN 1 ELSE 0 END) AS researched,
              SUM(CASE WHEN json_extract(classification,'$.tier') = 'HOT' THEN 1 ELSE 0 END) AS hot,
              SUM(CASE WHEN json_extract(classification,'$.tier') = 'WARM' THEN 1 ELSE 0 END) AS warm
       FROM leads`
    );

    return {
      state: "succeeded",
      output: {
        classified,
        researched,
        pushed,
        totals: {
          total: stats?.total ?? 0,
          classified: stats?.classified ?? 0,
          researched: stats?.researched ?? 0,
          hot: stats?.hot ?? 0,
          warm: stats?.warm ?? 0,
        },
      },
    };
  },
});

/**
 * UK without an API key: two-stage Crawlee run over the public
 * Companies House site — search page → company detail pages.
 */
async function ukHtmlCrawl(query: string): Promise<Candidate[]> {
  const out = new Map<string, Candidate>();

  const crawler = new CheerioCrawler({
    maxConcurrency: 3,
    maxRequestRetries: 2,
    useSessionPool: false,
    // UA set per-request (Crawlee 3 has no crawler-level header option)
    async requestHandler({ $, request, enqueueLinks }) {
      const html = $.html() || "";
      const kind = (request.userData as { kind?: string }).kind;
      if (kind === "search") {
        const detailUrls: string[] = [];
        // DOM parse (attribute order varies between raw HTML and re-serialization).
        $("li.type-company").each((_, el) => {
          const $el = $(el);
          const $a = $el.find("a").first();
          const href = $a.attr("href") ?? "";
          const num = (href.match(/\/company\/([0-9A-Z]{5,12})/) ?? [])[1];
          if (!num) return;
          const name = $a.text().trim().replace(/&amp;/g, "&");
          const meta = $el.find(".crumbtrail").last().text().trim();
          const incM = meta.match(/Incorporated on\s+(.+)/);
          const addr = $el.find("p").last().text().trim();
          const parts = addr.split(",").map((x) => x.trim()).filter(Boolean);
          const notCity = /^(England|Scotland|Wales|Northern Ireland|United Kingdom|UK)$/i;
          const isPostcode = /[A-Z]{1,2}\d|[A-Z]\d[A-Z]/i;
          const cityParts = parts.filter((p) => !notCity.test(p) && !isPostcode.test(p));
          const city = cityParts.length > 1 ? cityParts[cityParts.length - 1] : undefined;
          const c: Candidate = {
            key: `uk-${num}`,
            country: "uk",
            name,
            incorporated: incM?.[1]?.trim(),
            city,
            officers: [],
            source: "companieshouse.gov.uk (public HTML)",
            source_url: `https://find-and-update.company-information.service.gov.uk/company/${num}`,
          };
          if (!out.has(c.key)) out.set(c.key, c);
          detailUrls.push(c.source_url!);
        });
        // Enqueue only the parsed company pages (never "all" page links).
        if (detailUrls.length > 0) {
          await enqueueLinks({
            urls: detailUrls.slice(0, 6),
            userData: { kind: "detail" },
            headers: UA,
          });
        }
      } else if (kind === "detail") {
        const number = (request.url.match(/\/company\/([0-9A-Z]{5,12})/) ?? [])[1] ?? "";
        const d = parseUkDetail(html);
        const c = out.get(`uk-${number}`);
        if (c) {
          if (d.sic) c.sic = d.sic;
          if (d.incorporated && !c.incorporated) c.incorporated = d.incorporated;
          if (d.status && d.status !== "Active") out.delete(`uk-${number}`);
        }
      }
    },
  });

  const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36" };
  await crawler.run([new Request({ url: ukSearchUrl(query, 1), headers: UA, userData: { kind: "search" } })]);
  return [...out.values()].slice(0, 12);
}

function safeJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

async function synthesizeAgents(
  ctx: TaskContext,
  lead: LeadRow,
  cls: any,
  vertical: string,
  sources: Array<{ title: string; url: string; description: string }>,
  snippets: string
): Promise<Record<string, unknown>> {
  const system = `You are a business AI-opportunity analyst. Given a company record, its classification and web-search evidence,
determine which AI AGENTS (autonomous AI workers) this specific business would most likely need to save time or make money.
Be concrete and business-specific — not generic.
Respond ONLY with JSON: {"ai_agents_needed":[{"agent":string,"purpose":string,"pain_point":string,"priority":"high"|"medium"|"low"}],"pitch_angle":string,"confidence":"high"|"medium"|"low","notes":string}
- ai_agents_needed: 2-4 items. "agent" = a short agent name (e.g. "Quote-follower agent"), "purpose" = what it does, "pain_point" = the concrete problem it removes, "priority" = ranked.
- pitch_angle: one sentence a salesperson could open with, in the business's language (${cls.language || "en"}).
- Judge only from the provided evidence; if evidence is thin, say confidence "low".`;
  const user = [
    `Company: ${lead.name} (${lead.country})`,
    `Vertical: ${cls.vertical_detail || vertical}`,
    `SIC: ${lead.sic || "n/a"} ${lead.sic_label ? `(${lead.sic_label})` : ""}`,
    `Incorporated: ${lead.incorporated || "unknown"}`,
    `City: ${lead.city || "unknown"}`,
    `Website: ${lead.website || "none found"}`,
    `Officers: ${(safeJson(lead.officers, [] as string[]) as string[]).join(", ") || "n/a"}`,
    `Signals: ${(cls.signals || []).join("; ")}`,
    ``,
    `Web evidence:`,
    sources.length > 0 ? sources.map((s) => `- ${s.title} — ${s.url}`).join("\n") : "- none",
    snippets ? `Descriptions:\n${snippets}` : "",
  ].filter(Boolean).join("\n");

  try {
    const raw = await ctx.gateway.chat([
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const m = raw.match(/\{[\s\S]*\}/);
    const parsed = m ? JSON.parse(m[0]) : null;
    if (parsed && Array.isArray(parsed.ai_agents_needed)) {
      return {
        ...parsed,
        sources: sources.slice(0, 4).map((s) => s.url),
        researched_at: new Date().toISOString(),
      };
    }
    return { ai_agents_needed: [], pitch_angle: "", confidence: "low", notes: raw.slice(0, 300), sources: sources.slice(0, 4).map((s) => s.url), researched_at: new Date().toISOString() };
  } catch (e) {
    return { ai_agents_needed: [], pitch_angle: "", confidence: "low", notes: `synthesis failed: ${(e as Error).message}`.slice(0, 200), sources: sources.slice(0, 4).map((s) => s.url), researched_at: new Date().toISOString() };
  }
}

export default createCoreAgent({
  name: "lead-scraper",
  description: "Registry discovery + site crawling (Crawlee) + jev classification + Brave research pipeline for the Business Intelligence agent.",

  taskHandlers: {
    scrape: scrapeHandler,
    research: researchHandler,
  },

  async onStart(ctx) {
    ctx.sql.exec(SCHEMA);
  },
});
