/// <reference types="@cloudflare/workers-types" />

import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import type Database from "better-sqlite3";
import type { Lead } from "../db/types.js";
import { updateLead } from "../db/leads.js";

export interface EvidencePack {
  services: string[];
  team: string[];
  techStack: string[];
  clients: string[];
  news: string[];
  snippets: string[];
}

const EMPTY_EVIDENCE: EvidencePack = {
  services: [],
  team: [],
  techStack: [],
  clients: [],
  news: [],
  snippets: [],
};

async function braveSearch(
  query: string,
  env: Record<string, unknown>,
): Promise<string[]> {
  const apiKey = env.BRAVE_API_KEY as string;
  if (!apiKey) return [];

  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          "Accept": "application/json",
          "Accept-Encoding": "gzip",
          "X-Subscription-Token": apiKey,
        },
      },
    );

    if (res.status === 429) return [];
    if (!res.ok) return [];

    const data = (await res.json()) as {
      web?: { results?: Array<{ title?: string; description?: string; url?: string }> };
    };

    return (data.web?.results ?? []).map((r) =>
      `${r.title ?? ""} — ${r.description ?? ""} (${r.url ?? ""})`
    );
  } catch {
    return [];
  }
}

async function crawlWebsite(
  url: string,
  env: Record<string, unknown>,
): Promise<string> {
  try {
    const normalizedUrl = url.startsWith("http") ? url : `https://${url}`;
    const res = await fetch(normalizedUrl, {
      headers: { "User-Agent": "bi-edge-crawler/1.0" },
      redirect: "follow",
    });

    if (!res.ok) return "";

    const html = await res.text();
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return text.slice(0, 8000);
  } catch {
    return "";
  }
}

function extractEvidence(text: string): EvidencePack {
  const lower = text.toLowerCase();
  const evidence: EvidencePack = { ...EMPTY_EVIDENCE };

  const servicePatterns = [
    /\b(web design|website development|seo|marketing|consulting|accounting|legal|plumbing|electrical|cleaning|landscaping)\b/gi,
  ];
  for (const pattern of servicePatterns) {
    const matches = text.match(pattern);
    if (matches) evidence.services.push(...matches.slice(0, 5));
  }

  const techPatterns = [
    /\b(wordpress|shopify|wix|squarespace|react|vue|angular|node|python|php|mysql|aws|azure|google cloud)\b/gi,
  ];
  for (const pattern of techPatterns) {
    const matches = text.match(pattern);
    if (matches) evidence.techStack.push(...matches.slice(0, 5));
  }

  if (lower.includes("team") || lower.includes("staff") || lower.includes("employees")) {
    evidence.team.push("Team mentioned on website");
  }

  if (lower.includes("client") || lower.includes("customer") || lower.includes("testimonial")) {
    evidence.clients.push("Client references found");
  }

  evidence.snippets.push(text.slice(0, 300));

  return evidence;
}

export async function runResearcher(
  db: Database.Database,
  lead: Lead,
  env: Record<string, unknown>,
): Promise<EvidencePack> {
  let pageText = "";
  if (lead.website) {
    pageText = await crawlWebsite(lead.website, env);
  }

  const searchQuery = `${lead.name} ${lead.city ?? ""} ${lead.country}`;
  const searchResults = await braveSearch(searchQuery, env);

  let evidence = pageText ? extractEvidence(pageText) : { ...EMPTY_EVIDENCE };

  for (const result of searchResults) {
    evidence.snippets.push(result);
  }

  const unique = <T>(arr: T[]): T[] => [...new Set(arr)];
  evidence.services = unique(evidence.services);
  evidence.team = unique(evidence.team);
  evidence.techStack = unique(evidence.techStack);
  evidence.clients = unique(evidence.clients);
  evidence.news = unique(evidence.news);
  evidence.snippets = unique(evidence.snippets).slice(0, 10);

  updateLead(db, lead.key, {
    stage: "researched",
    research: JSON.stringify(evidence),
  });

  return evidence;
}

export async function researchBatch(
  db: Database.Database,
  leads: Lead[],
  env: Record<string, unknown>,
): Promise<Map<string, EvidencePack>> {
  const results = new Map<string, EvidencePack>();

  for (const lead of leads) {
    try {
      const evidence = await runResearcher(db, lead, env);
      results.set(lead.key, evidence);
    } catch {
      results.set(lead.key, { ...EMPTY_EVIDENCE });
    }
  }

  return results;
}
