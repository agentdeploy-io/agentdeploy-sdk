/// <reference types="@cloudflare/workers-types" />

import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import type Database from "better-sqlite3";
import type { Lead } from "../db/types.js";
import { updateLead } from "../db/leads.js";
import { logLlmTrace, getSetting } from "../db/index.js";
import { validateLead, parseIcpFrontMatter, type IcpConfig, type ValidationResult } from "../icp-validator.js";
import {
  JevClient,
  buildIcpDigest,
  unclassifiedResult,
  type JevLeadInput,
  type JevClassification,
} from "../services/jev-client.js";

export interface Classification {
  key: string;
  vertical: string;
  vertical_detail: string;
  fit: number;
  tier: "HOT" | "WARM" | "COLD" | "SKIP";
  language: string;
  signals: string[];
  reasoning: string;
}

const ICP_SKILL = `---
nace_include: ["69", "70", "74", "81", "82", "85", "96"]
nace_exclude: ["62", "63", "73", "58", "59"]
age_months_max: 36
size_max: 50
countries: [uk, ie, fr]
must_have: [active_registry_status]
---`;

function parseIcpConfig(): IcpConfig {
  return parseIcpFrontMatter(ICP_SKILL);
}

/**
 * Append the operator's free-form ICP notes (set in the UI, stored as
 * `campaign:icpNotes`) to the digest so the classifier sees them. The
 * structured NACE/size/age gates in icp-validator still apply unchanged —
 * notes steer the LLM's judgment, they don't override the deterministic gate.
 */
function withIcpNotes(db: Database.Database, digest: string): string {
  const notes = (getSetting(db, "campaign:icpNotes") ?? "").trim();
  return notes ? `${digest}\n\nOperator notes on who to prioritise:\n${notes}` : digest;
}

function leadToIcpInput(lead: Lead) {
  const incorporated = lead.incorporated ? new Date(lead.incorporated) : null;
  const ageMonths = incorporated
    ? Math.round((Date.now() - incorporated.getTime()) / (30.44 * 24 * 3600 * 1000))
    : 999;

  let emails: string[] = [];
  if (lead.emails) {
    try {
      const parsed = JSON.parse(lead.emails);
      emails = Array.isArray(parsed) ? parsed.map((e: any) => e.addr ?? e) : [];
    } catch {
      emails = [lead.emails];
    }
  }

  return {
    key: lead.key,
    name: lead.name,
    country: lead.country,
    sic: lead.sic ?? undefined,
    incorporated: lead.incorporated ?? undefined,
    website: lead.website ?? undefined,
    emails,
    sic_code: lead.sic ?? "",
    age_months: ageMonths,
    employee_count: 0,
  };
}

function buildJevClient(env: Record<string, unknown>): JevClient {
  const jevUrl = (env.AD_JEV_URL ?? env.JEV_URL) as string;
  if (!jevUrl) throw new Error("AD_JEV_URL not configured");
  const gatewayKey = (env.AD_JEV_GATEWAY_KEY ?? "") as string;
  return new JevClient(jevUrl, gatewayKey);
}

function jevConfigured(env: Record<string, unknown>): boolean {
  return Boolean(env.AD_JEV_URL ?? env.JEV_URL);
}

// LLM-backed classifier used when the dedicated JEV service is not configured
// (e.g. local dev). Produces the same JevClassification shape as JEV so the
// downstream deterministic ICP / NACE-exclude gates apply unchanged.
const CLASSIFY_SYSTEM = `You classify inbound business leads for an outbound team that sells AI automation agents (24/7 phone + email reception, lead qualification, booking) to small businesses.
For each lead, judge how well it fits the ICP and how much repetitive manual work an AI agent could take over.
Tiers:
- HOT: strong ICP fit with a clear repetitive process (calls, enquiries, bookings, admin) to automate.
- WARM: plausible fit, some automation opportunity.
- COLD: weak or unclear fit.
- SKIP: not a fit (wrong vertical, web/digital agency = channel partner not customer, too large, out of target countries).
Return ONLY a JSON object: {"classifications":[{"key":"...","vertical":"...","vertical_detail":"...","fit":0-100,"tier":"HOT|WARM|COLD|SKIP","language":"en","signals":["..."],"reasoning":"..."}]}
Include one object for every input key.`;

async function llmClassifyLeads(
  leads: JevLeadInput[],
  icpDigest: string,
  env: Record<string, unknown>,
  db?: Database.Database,
): Promise<JevClassification[]> {
  if (leads.length === 0) return [];
  const t0 = Date.now();

  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFY_SYSTEM },
        {
          role: "user",
          content: JSON.stringify({
            icp: icpDigest,
            leads: leads.map((l) => ({
              key: l.key,
              name: l.name,
              sic: l.sic ?? null,
              sic_label: l.sic_label ?? null,
              country: l.country,
              city: l.city ?? null,
              website: l.website ?? null,
              incorporated: l.incorporated ?? null,
            })),
          }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`llm classify ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = parseLlmJson(await res.json());
  if (db) {
    logLlmTrace(db, {
      stage: "classify",
      leadKey: leads.length === 1 ? leads[0].key : `${leads.length} leads`,
      model: String(env.AD_MODEL ?? ""),
      promptExcerpt: JSON.stringify({ icp: icpDigest, leads: leads.map((l) => ({ key: l.key, name: l.name, sic: l.sic ?? null })) }),
      rawResponse: JSON.stringify(raw),
      latencyMs: Date.now() - t0,
    });
  }
  const arr: any[] = Array.isArray(raw.classifications)
    ? raw.classifications
    : Array.isArray(raw)
      ? raw
      : [];
  const byKey = new Map<string, any>();
  for (const c of arr) {
    if (c && c.key != null) byKey.set(String(c.key), c);
  }

  return leads.map((l) => {
    const c = byKey.get(l.key);
    if (!c) {
      return unclassifiedResult(l.key, l.country, "llm returned no classification for this key");
    }
    return {
      key: l.key,
      vertical: String(c.vertical ?? "Unknown"),
      vertical_detail: String(c.vertical_detail ?? ""),
      fit: Number(c.fit ?? 0),
      tier: ["HOT", "WARM", "COLD", "SKIP"].includes(c.tier) ? c.tier : "COLD",
      language: String(c.language ?? l.country.toLowerCase()),
      signals: Array.isArray(c.signals) ? c.signals.map((s: unknown) => String(s)) : [],
      reasoning: String(c.reasoning ?? ""),
    };
  });
}

// JEV when configured; otherwise the LLM fallback. Throws on hard failure —
// callers decide whether to fall back to COLD.
async function classifyLeads(
  leads: JevLeadInput[],
  icpDigest: string,
  env: Record<string, unknown>,
  db?: Database.Database,
): Promise<JevClassification[]> {
  if (jevConfigured(env)) {
    return buildJevClient(env).classifyBatch(leads, icpDigest);
  }
  return llmClassifyLeads(leads, icpDigest, env, db);
}

function leadToJevInput(lead: Lead): JevLeadInput {
  return {
    key: lead.key,
    name: lead.name,
    sic: lead.sic ?? null,
    sic_label: lead.sic_label ?? null,
    country: lead.country,
    city: lead.city ?? null,
    website: lead.website ?? null,
    incorporated: lead.incorporated ?? null,
    emails: [],
  };
}

function applyNaceExcludeDemotion(
  classification: Classification,
  lead: Lead,
  icpConfig: IcpConfig,
): Classification {
  if (classification.tier !== "HOT") return classification;

  const sic = (lead.sic ?? "").toString().padStart(2, "0").slice(0, 2);
  if (!sic || !icpConfig.nace_exclude.includes(sic)) return classification;

  return {
    ...classification,
    tier: "SKIP",
    signals: [`ICP exclude: SIC ${sic}`, ...classification.signals],
    reasoning: `Demoted from HOT: ICP exclude SIC ${sic} (${lead.sic_label ?? sic})`,
  };
}

export async function runQualifier(
  db: Database.Database,
  lead: Lead,
  env: Record<string, unknown>,
): Promise<Classification> {
  const icpConfig = parseIcpConfig();
  const icpInput = leadToIcpInput(lead);

  const icpResult: ValidationResult = validateLead(
    {
      sic_code: icpInput.sic_code,
      age_months: icpInput.age_months,
      employee_count: icpInput.employee_count,
      country: lead.country,
      registry_status: "active",
    },
    icpConfig,
  );

  if (!icpResult.valid) {
    const classification: Classification = {
      key: lead.key,
      vertical: "Unknown",
      vertical_detail: "",
      fit: 0,
      tier: "SKIP",
      language: lead.country.toLowerCase(),
      signals: icpResult.signals,
      reasoning: `ICP validation failed: ${icpResult.signals.join(", ")}`,
    };
    updateLead(db, lead.key, {
      stage: "classified",
      classification: JSON.stringify(classification),
    });
    return classification;
  }

  const icpDigest = withIcpNotes(db, buildIcpDigest(icpConfig));

  let raw: JevClassification | undefined;
  let classifyError: string | null = null;
  try {
    const classifications = await classifyLeads([leadToJevInput(lead)], icpDigest, env, db);
    raw = classifications[0];
  } catch (err) {
    classifyError = err instanceof Error ? err.message : "unknown";
  }

  if (!raw) {
    const fallback = unclassifiedResult(
      lead.key,
      lead.country,
      `classify unavailable: ${classifyError ?? "no classification"}`,
    );
    const classification: Classification = { ...fallback };
    updateLead(db, lead.key, {
      stage: "classified",
      classification: JSON.stringify(classification),
    });
    return classification;
  }

  const classification: Classification = { ...raw };
  const afterNace = applyNaceExcludeDemotion(classification, lead, icpConfig);

  const finalTier = icpResult.tier === "SKIP" ? "SKIP" : afterNace.tier;
  const finalClassification: Classification = {
    ...afterNace,
    tier: finalTier,
    signals: [...afterNace.signals, ...icpResult.signals],
  };

  updateLead(db, lead.key, {
    stage: "classified",
    classification: JSON.stringify(finalClassification),
  });

  return finalClassification;
}

export async function classifyBatch(
  db: Database.Database,
  leads: Lead[],
  env: Record<string, unknown>,
): Promise<Classification[]> {
  const icpConfig = parseIcpConfig();
  const icpDigest = withIcpNotes(db, buildIcpDigest(icpConfig));

  const jevInputs = leads.map(leadToJevInput);

  let rawClassifications: JevClassification[];
  try {
    rawClassifications = await classifyLeads(jevInputs, icpDigest, env, db);
  } catch (err) {
    // Classification backend unavailable (JEV down or LLM error) → mark every
    // lead COLD so the pipeline continues instead of stalling on raw.
    const msg = err instanceof Error ? err.message : "unknown";
    const results: Classification[] = [];
    for (const lead of leads) {
      const fallback = unclassifiedResult(lead.key, lead.country, `classify unavailable: ${msg}`);
      const classification: Classification = { ...fallback };
      updateLead(db, lead.key, {
        stage: "classified",
        classification: JSON.stringify(classification),
      });
      results.push(classification);
    }
    return results;
  }

  const results: Classification[] = [];
  for (const raw of rawClassifications) {
    const lead = leads.find((l) => l.key === raw.key);
    if (!lead) continue;

    const icpInput = leadToIcpInput(lead);
    const icpResult = validateLead(
      {
        sic_code: icpInput.sic_code,
        age_months: icpInput.age_months,
        employee_count: icpInput.employee_count,
        country: lead.country,
        registry_status: "active",
      },
      icpConfig,
    );

    const classification: Classification = { ...raw };
    const afterNace = applyNaceExcludeDemotion(classification, lead, icpConfig);

    const finalTier = icpResult.tier === "SKIP" ? "SKIP" : afterNace.tier;
    const final: Classification = {
      ...afterNace,
      tier: finalTier,
      signals: [...afterNace.signals, ...icpResult.signals],
    };

    updateLead(db, final.key, {
      stage: "classified",
      classification: JSON.stringify(final),
    });
    results.push(final);
  }

  return results;
}
