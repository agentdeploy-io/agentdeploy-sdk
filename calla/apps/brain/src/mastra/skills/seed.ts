/**
 * Builtin seeding — the gradient3.io default stack, idempotent.
 *
 * seedBuiltins(store) inserts builtin skill files (bi-edge/skills/*.md,
 * copied verbatim into ./builtin/) and builtin agent configs ONLY where the
 * store has nothing yet for that agent: skills seed when calla_skills holds
 * zero rows for the agentId, configs seed when no calla_agent_configs row
 * exists. User edits are therefore NEVER overwritten by a restart.
 *
 * Builtin agents:
 *  - "orchestrator" — store-driven mirror of the static calla-orchestrator
 *    (instructions from builtin/orchestrator-instructions.md);
 *  - "miles"        — Gradient3 outreach sender persona
 *    (agent.miles@gradient3.io) embedding the identity defaults.
 */
import type { CallaStore } from "../../store/index.js";
import { loadBuiltinOrchestratorInstructions, loadBuiltinSkills } from "./loader.js";

/** Agent ids that receive the builtin skill stack + a builtin config. */
export const BUILTIN_AGENT_IDS = [
  "orchestrator",
  "miles",
  "dental-receptionist",
] as const;

export interface BuiltinAgentSeed {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
}

const MILES_INSTRUCTIONS = `You are Miles, Gradient3's outreach sender agent. You write and send outbound
email as agent.miles@gradient3.io.

Identity (gradient3.io defaults):
- Sender: agent.miles@gradient3.io — Gradient3 (https://gradient3.io)
- Brand: Gradient3 — AI agents for intake, quoting, scheduling and document processing.
- Voice: direct, conversational, respectful — a trusted advisor, not a salesperson
  (per the outreach-style skill). Short sentences, short paragraphs, first person,
  no hype, no buzzwords.

Working rules:
- Follow your skills at all times: identity (persona), outreach-style (tone + cadence),
  icp (who to target), objection-handling (rebuttals), compliance (GDPR / EU AI Act / opt-out).
- Only contact leads that match the ICP. Never fabricate credentials, titles, or claims
  about the recipient or about Gradient3.
- Lead with a single Calendly link; no attachments, no multi-link emails; subject lines
  at most 7 words.
- Every email carries the AI-disclosure line, the physical address, and "Reply STOP to
  opt out". Opt-outs are immediate and permanent — never re-engage an opted-out lead.
- All external email is gated by human approval: a suspended run is normal. Report the
  approvalId, stop, and wait for the decision — never retry or route around the gate.`;

/** The dental-receptionist voice persona (Workstream B). */
const DENTAL_RECEPTIONIST_INSTRUCTIONS = `You are the front-desk receptionist of a dental practice, answering the
practice's main phone line by voice. You are heard, not read — keep every
reply to one or two short, natural sentences; never use lists, bullets,
markdown, abbreviations, or stage directions.

How you work:
- Warm, calm, professional. Confirm one thing at a time; ask a single
  question per turn.
- Follow your skills at all times: greeting, practice-hours, services-menu,
  insurance-info, emergency-triage, booking-rules, compliance.
- Use your tools: check_availability for open times, book_appointment to
  book (it may pause for a human approval — that is normal, relay the
  confirmation when it lands), faq_lookup for practice facts, and
  escalate_to_human to hand a caller to a person.

Hard rules (never violate):
- NEVER diagnose, give medical advice, or interpret symptoms.
- A medical emergency (severe pain, swelling, knocked-out tooth, heavy
  bleeding) is ALWAYS escalated to a human immediately — never "handle" it.
- Never confirm or discuss another patient's details (privacy).
- If you do not know an answer, say the team will follow up by phone —
  never invent hours, prices, or availability.
- You are an AI assistant; say so plainly if the caller asks.

If the caller is rude or off-topic, stay courteous and steer back to
booking and practice information.`;

/** The builtin agent configs (instructions loaded from ./builtin/*.md). */
export function builtinAgentConfigs(): BuiltinAgentSeed[] {
  return [
    {
      agentId: "orchestrator",
      name: "Calla Orchestrator",
      description:
        "Calla brain orchestrator — coordinates the Cloudflare edge fleet, dispatches step tasks, and enforces human-in-the-loop approval gates.",
      instructions: loadBuiltinOrchestratorInstructions(),
    },
    {
      agentId: "miles",
      name: "Miles — Gradient3 Outreach",
      description:
        "Gradient3 outreach sender persona (agent.miles@gradient3.io) — direct conversational voice, ICP-scoped, compliance-gated.",
      instructions: MILES_INSTRUCTIONS,
    },
    {
      agentId: "dental-receptionist",
      name: "Dental Receptionist (Voice)",
      description:
        "AI front-desk receptionist for the dental practice phone line — bookings, hours, services, insurance, and emergency triage with human escalation.",
      instructions: DENTAL_RECEPTIONIST_INSTRUCTIONS,
    },
  ];
}

export interface SeedBuiltinsResult {
  /** Agent ids whose calla_agent_configs row was inserted by this run. */
  configsSeeded: string[];
  /** agentId → number of builtin skills inserted by this run. */
  skillsSeeded: Record<string, number>;
}

/**
 * Idempotent seed: insert builtins ONLY when empty for the agent, so restarts
 * never clobber tenant edits. Throws only on store failure (callers wrap it
 * best-effort).
 */
export async function seedBuiltins(store: CallaStore): Promise<SeedBuiltinsResult> {
  const result: SeedBuiltinsResult = { configsSeeded: [], skillsSeeded: {} };

  for (const seed of builtinAgentConfigs()) {
    const existingConfig = await store.getAgentConfig(seed.agentId);
    if (!existingConfig) {
      await store.upsertAgentConfig({
        agentId: seed.agentId,
        name: seed.name,
        description: seed.description,
        instructions: seed.instructions,
        source: "builtin",
        enabled: true,
      });
      result.configsSeeded.push(seed.agentId);
    }

    // Per-agent stack: builtin/<agentId>/ if present, else the shared stack.
    const skillFiles = loadBuiltinSkills(seed.agentId);
    const existingSkills = await store.listSkills(seed.agentId);
    if (existingSkills.length === 0 && skillFiles.length > 0) {
      for (const file of skillFiles) {
        await store.upsertSkill({
          agentId: seed.agentId,
          name: file.name,
          description: file.description,
          instructions: file.instructions,
          references: file.references,
          source: "builtin",
        });
      }
      result.skillsSeeded[seed.agentId] = skillFiles.length;
    }
  }

  return result;
}
