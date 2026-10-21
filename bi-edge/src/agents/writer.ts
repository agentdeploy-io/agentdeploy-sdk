/// <reference types="@cloudflare/workers-types" />

import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import type Database from "better-sqlite3";
import type { Lead } from "../db/types.js";
import { updateLead } from "../db/leads.js";
import type { EvidencePack } from "./researcher.js";

export interface AiAgentRecommendation {
  agent: string;
  purpose: string;
  pain_point: string;
  priority: "high" | "medium" | "low";
  evidenceRef: string;
}

export interface WriterOutput {
  ai_agents_needed: AiAgentRecommendation[];
  pitch_angle: string;
  confidence: number;
  pitch_subject: string;
  pitch_body: string;
}

const IDENTITY_PERSONA_DEFAULT = `You are writing on behalf of a business automation consultancy that sells AI agents for:
- Intake and lead handling (phone/email)
- Quoting and proposals
- Scheduling and appointments
- Document processing
- Follow-up automation

Voice: direct, conversational, professional. No jargon. Short sentences. First person.`;

// Brand-aware persona: when BRAND_NAME / BRAND_SITE_URL / BRAND_ONE_LINER are
// set (e.g. "Agent Miles" built by gradient3.io), pitches are written in first
// person as that agent and open by identifying themselves + the one-liner.
function buildIdentityPersona(env: Record<string, unknown>): string {
  const brandName = String(env.BRAND_NAME ?? "").trim();
  const oneLiner = String(env.BRAND_ONE_LINER ?? "").trim();
  const site = String(env.BRAND_SITE_URL ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim();
  if (!brandName) return IDENTITY_PERSONA_DEFAULT;

  return `You are ${brandName}${site ? `, an AI agent built by ${site}` : ""}.
${oneLiner ? `About the company: ${oneLiner}` : ""}
You sell AI agents for: intake and lead handling (phone/email), quoting and proposals, scheduling and appointments, document processing, and follow-up automation.

Voice: direct, conversational, professional. No jargon. Short sentences. First person — always as ${brandName}. Never claim to be a human.`;
}

const WRITER_TASK = `
You analyze a business's evidence pack (services, tech stack, team size, client references) and recommend which AI agents they need most. For each recommendation, cite which evidence field supports it.

Then write a cold email pitch (subject + body, 80-120 words) that:
- Opens with ONE self-identification sentence: who you are${' '}(${`{agent name}, an AI agent built by {site}`}) and what the company builds (use the one-liner, lightly adapted)
- Then gives a specific observation about their business
- Names ONE AI agent that solves their biggest pain
- Proposes a 15-minute call
- Ends with a soft CTA

Return ONLY JSON:
{
  "ai_agents_needed": [
    {"agent": "name", "purpose": "what it does", "pain_point": "what it solves", "priority": "high|medium|low", "evidenceRef": "which evidence field"}
  ],
  "pitch_angle": "one sentence angle",
  "confidence": 0-100,
  "pitch_subject": "email subject line (max 60 chars)",
  "pitch_body": "email body (80-120 words, plain text)"
}`;

export async function runWriter(
  db: Database.Database,
  lead: Lead,
  evidence: EvidencePack,
  env: Record<string, unknown>,
): Promise<WriterOutput> {
  const brand = {
    name: String(env.BRAND_NAME ?? "").trim(),
    site: String(env.BRAND_SITE_URL ?? "").replace(/^https?:\/\//, "").replace(/\/.*$/, "").trim(),
    one_liner: String(env.BRAND_ONE_LINER ?? "").trim(),
  };
  const system = `${buildIdentityPersona(env)}${WRITER_TASK}`;
  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: JSON.stringify({
            brand,
            business: {
              name: lead.name,
              country: lead.country,
              city: lead.city ?? "",
              sic: lead.sic ?? "",
              website: lead.website ?? "",
            },
            evidence,
          }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`writer LLM ${res.status}: ${text.slice(0, 200)}`);
  }

  const raw = parseLlmJson(await res.json());

  const output: WriterOutput = {
    ai_agents_needed: Array.isArray(raw.ai_agents_needed)
      ? (raw.ai_agents_needed as AiAgentRecommendation[]).slice(0, 5)
      : [],
    pitch_angle: String(raw.pitch_angle ?? ""),
    confidence: Math.max(0, Math.min(100, Number(raw.confidence ?? 50))),
    pitch_subject: String(raw.pitch_subject ?? "").slice(0, 80),
    pitch_body: String(raw.pitch_body ?? ""),
  };

  updateLead(db, lead.key, {
    pitch_subject: output.pitch_subject,
    pitch_body: output.pitch_body,
    research: JSON.stringify({
      ...evidence as unknown as Record<string, unknown>,
      writer: output,
    }),
  });

  return output;
}

export async function writeBatch(
  db: Database.Database,
  leads: Lead[],
  evidenceMap: Map<string, EvidencePack>,
  env: Record<string, unknown>,
): Promise<WriterOutput[]> {
  const results: WriterOutput[] = [];
  for (const lead of leads) {
    const evidence = evidenceMap.get(lead.key);
    if (!evidence) continue;
    try {
      const output = await runWriter(db, lead, evidence, env);
      results.push(output);
    } catch {
      results.push({
        ai_agents_needed: [],
        pitch_angle: "",
        confidence: 0,
        pitch_subject: "",
        pitch_body: "",
      });
    }
  }
  return results;
}
