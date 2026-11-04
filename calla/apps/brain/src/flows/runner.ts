/**
 * Qualification-flow runner — the deterministic state machine.
 *
 * Entry points (all in-process; channels + REST import these directly):
 *   startFlow(store, {flowId, leadKey?, channel, chatRef?, initialAnswers?})
 *   answerFlow(store, runId, text)
 *   completeFlow(store, run)          (also fired automatically on the last answer)
 *   cancelFlow(store, runId, reason?)
 *   getActiveRun(store, channel, chatRef) → runId | null   (channel handoff)
 *   bookRunSlot(store, runId, slotStart, attendee?)       (post-booking confirm)
 *
 * WAVE-2 INTEGRATION (WhatsApp customer channel + Meta Lead Forms):
 *   import { getActiveRun, startFlow, answerFlow, formatPromptText } from
 *   "../flows/runner.js"; — start with channel:"whatsapp" (chatRef
 *   `whatsapp:<phone>`), channel:"leadform" (chatRef `leadform:<leadgen_id>`)
 *   or channel:"form" (chatRef `form:<session>`), then feed every
 *   inbound message to answerFlow() when getActiveRun() returns a runId. The
 *   returned prompt (or summary.message when done:true) is the text to send
 *   back on the channel. Everything else (scoring, routing, slot proposals,
 *   lead patching, audits, urgency alerts) happens inside the runner.
 *
 * Answer matching (deterministic-first; see matchAnswer):
 *   choice  → case/space/dash/€-insensitive option match, ordinal ("1"/"2)"),
 *             or UNIQUE substring containment either direction;
 *   yesno   → yes/y/yeah/yep/sure/… vs no/n/nope/nah/… (token-prefix safe);
 *   eircode → loose Irish Eircode regex ("D15 XY23") or Dublin district
 *             ("Dublin 15"); anything else is stored raw (loose by design);
 *   email   → simple full-string regex (mismatch → re-prompt);
 *   number  → €/comma/space-stripped numeric; else optional LLM extraction;
 *   text    → trimmed raw (optional fields accept "skip"/"none"/"n/a").
 * Unmatched choice/yesno/email answers re-prompt the same question
 * (FlowStepResult.matched === false) — never guessed, never dropped.
 *
 * Optional LLM extraction (FLOWS_LLM_EXTRACT=true, default OFF): when a
 * text/number answer didn't parse, resolveDynamicAgent(SOCIAL_REPLY_AGENT ||
 * "miles") is asked for a strict-JSON {"value": ...} extraction; failures
 * fall back to storing the raw text.
 *
 * Completion: deterministic score → tier → routing (booking/routing.ts) when
 * outcome.onComplete==="route" and the bookingIntent field matches → lead
 * PATCH via lib/engine-client (classification + merged research; status is
 * NEVER touched — same no-downgrade doctrine as social capture) → audits
 * flow.completed / flow.routed → best-effort calla:message relays to
 * {CALLA_EDGE_URL}/events/ingest (urgent + routed frames for the UI feed).
 */
import type { CallaStore } from "../store/types.js";
import { getLeadRow, patchLead, sendCallaMessage } from "../lib/engine-client.js";
import { resolveDynamicAgent } from "../mastra/dynamic-agents.js";
import { BookingStore, DEFAULT_TIMEZONE } from "../booking/store.js";
import { getFreshConnection, readBookingConfig } from "../booking/oauth.js";
import { googleCreateEvent } from "../booking/providers/google.js";
import { googleCalendarTemplateUrl } from "../booking/providers/shared.js";
import { msCreateEvent } from "../booking/providers/microsoft.js";
import {
  buildBookingProposalText,
  proposeSlotsForRep,
  routeLead,
  type SlotProposal,
} from "../booking/routing.js";
import type { Appointment, Attendee, Rep } from "../booking/types.js";
import { FlowStore, newRunId } from "./store.js";
import { URGENCY_KEYWORDS } from "./definitions.js";
import type {
  FlowChannel,
  FlowDefinition,
  FlowField,
  FlowPrompt,
  FlowRun,
  FlowStepResult,
  FlowSummary,
  FlowTier,
} from "./types.js";

const MAX_TEXT_ANSWER = 500;
const MAX_URGENT_TEXT = 200;

// ─── Small helpers ───────────────────────────────────────────────

function truncateText(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Comparison normalization: lowercase, unify dashes, strip currency symbols
 * and ALL whitespace so "€150-200" == "€150–€200", "<3 months" == "< 3 months",
 * "3-6 Months" == "3–6 months".
 */
export function normValue(v: unknown): string {
  return String(v ?? "")
    .toLowerCase()
    .replace(/[–—−]/g, "-")
    .replace(/[€£$]/g, "")
    .replace(/\s+/g, "");
}

function llmExtractEnabled(): boolean {
  const v = process.env.FLOWS_LLM_EXTRACT?.trim().toLowerCase();
  if (!v) return false; // default OFF — deterministic first
  return !(v === "false" || v === "0" || v === "no" || v === "off");
}

// ─── Answer matching ─────────────────────────────────────────────

const YES_TOKENS = [
  "yes", "yeah", "yep", "ya", "y", "sure", "definitely", "absolutely",
  "please", "affirmative", "interested", "ok", "okay",
];
const NO_TOKENS = ["no", "nope", "nah", "n", "notyet", "none", "negative"];
const SKIP_TOKENS = ["skip", "none", "n/a", "na", "pass", "-", "--", "nothing", "nothanks", "skipplease"];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/;
/** Loose Irish Eircode: routing key + optional locator unit ("D15 XY23"). */
const EIRCODE_RE = /[A-Za-z]\d{2}\s?\d?[A-Za-z0-9]{0,4}/;
const DUBLIN_DISTRICT_RE = /^dublin\s*\d{1,2}$/i;

export type MatchResult =
  | { ok: true; value: string | number }
  | { ok: false; llmCandidate?: boolean };

/** Deterministic answer → field-value matching (see module header). */
export function matchAnswer(field: FlowField, rawText: string): MatchResult {
  const text = String(rawText ?? "").trim();
  if (!text) return { ok: false };

  if (field.type === "choice") {
    const opts = field.options ?? [];
    // Ordinal answer: "1", "2)", "3."
    const ord = /^(\d{1,2})\s*[.)]?$/.exec(text);
    if (ord) {
      const n = Number(ord[1]);
      if (n >= 1 && n <= opts.length) return { ok: true, value: opts[n - 1] };
      return { ok: false };
    }
    const nt = normValue(text);
    const exact = opts.find((o) => normValue(o) === nt);
    if (exact) return { ok: true, value: exact };
    if (nt.length >= 2) {
      // Unique substring containment either direction ("semi" → Semi-detached,
      // "I'm a homeowner" → Homeowner).
      const contains = opts.filter((o) => normValue(o).includes(nt));
      if (contains.length === 1) return { ok: true, value: contains[0] };
      const inside = opts.filter((o) => nt.includes(normValue(o)));
      if (inside.length === 1) return { ok: true, value: inside[0] };
    }
    return { ok: false };
  }

  if (field.type === "yesno") {
    const nt = normValue(text);
    const yesHit = YES_TOKENS.find((t) => nt === t || (t.length > 1 && nt.startsWith(t)));
    const noHit = NO_TOKENS.find((t) => nt === t || (t.length > 1 && nt.startsWith(t)));
    // Prefer exact matches; on prefix conflicts the longer token wins.
    if (YES_TOKENS.includes(nt)) return { ok: true, value: "yes" };
    if (NO_TOKENS.includes(nt)) return { ok: true, value: "no" };
    if (yesHit && (!noHit || yesHit.length >= noHit.length)) return { ok: true, value: "yes" };
    if (noHit) return { ok: true, value: "no" };
    return { ok: false };
  }

  if (field.type === "eircode") {
    if (DUBLIN_DISTRICT_RE.test(text)) return { ok: true, value: text.replace(/\s+/g, " ") };
    const m = EIRCODE_RE.exec(text);
    if (m) return { ok: true, value: m[0].toUpperCase() };
    // Loose by design: store the raw answer (operators review odd inputs).
    return { ok: true, value: truncateText(text, 40) };
  }

  if (field.type === "email") {
    if (EMAIL_RE.test(text)) return { ok: true, value: text.toLowerCase() };
    return { ok: false };
  }

  if (field.type === "number") {
    const cleaned = text.replace(/[€£$,\s]/g, "");
    if (/^-?\d+(\.\d+)?$/.test(cleaned)) return { ok: true, value: Number(cleaned) };
    // Unparsed number → LLM extraction candidate (when enabled), else raw.
    return { ok: false, llmCandidate: true };
  }

  // text
  if (field.required === false && SKIP_TOKENS.includes(normValue(text))) {
    return { ok: true, value: "" }; // skipped optional
  }
  return { ok: true, value: truncateText(text, MAX_TEXT_ANSWER) };
}

/**
 * Optional LLM extraction for text/number answers that didn't parse
 * (FLOWS_LLM_EXTRACT=true). Strict-JSON prompt; any failure → null (caller
 * falls back to storing the raw text).
 */
async function llmExtractValue(field: FlowField, text: string): Promise<string | number | null> {
  if (!llmExtractEnabled()) return null;
  try {
    const agentId = process.env.SOCIAL_REPLY_AGENT?.trim() || "miles";
    const agent = await resolveDynamicAgent(agentId);
    if (!agent || typeof agent.generate !== "function") return null;
    const prompt = [
      `Extract the "${field.name}" value for a qualification flow from this customer message.`,
      `Field question: ${field.question}`,
      field.options ? `Allowed values: ${field.options.join(", ")}` : "",
      `Customer message: ${truncateText(text, 400)}`,
      "",
      'Respond with STRICT JSON only: {"value": "<extracted value or null>"}. No prose.',
    ]
      .filter(Boolean)
      .join("\n");
    const out = await agent.generate([{ role: "user", content: prompt }]);
    const rawText = typeof out === "string" ? out : String((out as any)?.text ?? "");
    const m = /\{[\s\S]*\}/.exec(rawText);
    if (!m) return null;
    const parsed = JSON.parse(m[0]) as { value?: unknown };
    if (parsed.value == null) return null;
    if (typeof parsed.value === "number" && Number.isFinite(parsed.value)) return parsed.value;
    const v = String(parsed.value).trim();
    return v ? truncateText(v, MAX_TEXT_ANSWER) : null;
  } catch (err) {
    console.warn("[flows] LLM extraction failed (storing raw):", errorMessage(err));
    return null;
  }
}

// ─── Field progression ───────────────────────────────────────────

/** First unanswered, non-skipped field (skipIf evaluated over answers). */
export function nextField(
  def: FlowDefinition,
  answers: Record<string, string | number>,
): FlowField | null {
  for (const f of def.fields) {
    const current = answers[f.name];
    if (current !== undefined && current !== "") continue;
    if (f.skipIf && normValue(answers[f.skipIf.field] ?? "") === normValue(f.skipIf.equals)) {
      continue;
    }
    return f;
  }
  return null;
}

function promptFor(field: FlowField): FlowPrompt {
  return {
    field: field.name,
    question: field.question,
    type: field.type,
    ...(field.options ? { options: field.options } : {}),
    ...(field.optionalHint ? { optionalHint: field.optionalHint } : {}),
  };
}

/** Channel-facing text for a prompt: question + numbered options + hint. */
export function formatPromptText(prompt: FlowPrompt): string {
  const lines = [prompt.question];
  if (prompt.options?.length) {
    lines.push(prompt.options.map((o, i) => `${i + 1}) ${o}`).join("\n"));
  }
  if (prompt.optionalHint) lines.push(`(${prompt.optionalHint})`);
  return lines.join("\n");
}

// ─── Scoring ─────────────────────────────────────────────────────

/** Deterministic score: sum of matching rule weights over the answers. */
export function computeScore(
  def: FlowDefinition,
  answers: Record<string, string | number>,
): number {
  let score = 0;
  for (const rule of def.scoring) {
    const answer = answers[rule.field];
    if (answer === undefined || answer === "") continue;
    if (rule.equals !== undefined) {
      if (normValue(answer) === normValue(rule.equals)) score += rule.weight;
      continue;
    }
    if (rule.in) {
      if (rule.in.some((v) => normValue(v) === normValue(answer))) score += rule.weight;
      continue;
    }
    if (rule.min !== undefined) {
      const n = Number(answer);
      if (Number.isFinite(n) && n >= rule.min) score += rule.weight;
    }
  }
  return score;
}

export function tierFor(def: FlowDefinition, score: number): FlowTier {
  if (score >= def.tiers.hot) return "hot";
  if (score >= def.tiers.warm) return "warm";
  return "cold";
}

// ─── Urgency ─────────────────────────────────────────────────────

/** Any urgency keyword in the raw answer text (leak/flooding/emergency/…). */
export function scanUrgency(text: string): string | null {
  const lower = String(text ?? "").toLowerCase();
  return URGENCY_KEYWORDS.find((k) => lower.includes(k)) ?? null;
}

async function flagUrgent(
  fs: FlowStore,
  run: FlowRun,
  fieldName: string,
  text: string,
  keyword: string,
): Promise<void> {
  if (run.priority === "high") return; // alert once per run
  run.priority = "high";
  await fs.audit("flow.urgent", {
    runId: run.id,
    flowId: run.flowId,
    leadKey: run.leadKey ?? null,
    channel: run.channel,
    field: fieldName,
    keyword,
  });
  // Best-effort human alert: a calla:message frame {urgent:true, …} on the
  // edge /events/ingest relay so the UI live feed surfaces it immediately.
  await sendCallaMessage({
    urgent: true,
    flowId: run.flowId,
    runId: run.id,
    leadKey: run.leadKey ?? null,
    channel: run.channel,
    keyword,
    text: truncateText(text, MAX_URGENT_TEXT),
  });
}

// ─── Lead sync on completion ─────────────────────────────────────

/**
 * Patch the engine lead with the flow outcome (best-effort, never throws):
 *   classification → JSON {tier, fit: score/100, flowId, vertical,
 *                          sequenceTag?, priority?, answers}
 *   research       → MERGED JSON {...existing, flowAnswers, flowCompletedAt,
 *                                  flowId, tier, score}
 *   status         → UNTOUCHED (never downgrade — social-capture doctrine).
 */
async function syncLeadOnCompletion(
  run: FlowRun,
  def: FlowDefinition,
): Promise<boolean> {
  if (!run.leadKey) return false;
  try {
    const existing = await getLeadRow(run.leadKey);
    let existingResearch: Record<string, unknown> = {};
    const rawResearch = existing?.research;
    if (typeof rawResearch === "string" && rawResearch.trim()) {
      try {
        const parsed = JSON.parse(rawResearch);
        if (parsed && typeof parsed === "object") existingResearch = parsed;
      } catch {
        existingResearch = { previousResearch: truncateText(rawResearch, 1000) };
      }
    }
    const completedAt = new Date().toISOString();
    const classification = {
      tier: run.tier ?? "cold",
      fit: Math.max(0, Math.min(1, (run.score ?? 0) / 100)),
      flowId: def.id,
      vertical: def.vertical,
      ...(def.outcome.sequenceTag ? { sequenceTag: def.outcome.sequenceTag } : {}),
      ...(run.priority === "high" ? { priority: "high" } : {}),
      answersSummary: run.answers,
    };
    const research = {
      ...existingResearch,
      flowId: def.id,
      flowAnswers: run.answers,
      flowCompletedAt: completedAt,
      tier: run.tier ?? "cold",
      score: run.score ?? 0,
    };
    const res = await patchLead(run.leadKey, {
      classification: JSON.stringify(classification),
      research: JSON.stringify(research),
    });
    if (!res.ok) {
      console.warn(
        `[flows] lead patch failed for "${run.leadKey}" (missing=${res.missing}):`,
        res.error ?? "unknown",
      );
    }
    return res.ok;
  } catch (err) {
    console.warn("[flows] lead sync failed:", errorMessage(err));
    return false;
  }
}

// ─── Start / answer / complete / cancel ──────────────────────────

export interface StartFlowInput {
  flowId: string;
  leadKey?: string;
  channel: FlowChannel;
  chatRef?: string;
  initialAnswers?: Record<string, string | number>;
}

/**
 * Create a run and return its first prompt. A previously active run on the
 * same (channel, chatRef) is cancelled as "superseded". When initialAnswers
 * pre-fill every field the run completes immediately (done:true).
 */
export async function startFlow(
  store: CallaStore,
  input: StartFlowInput,
): Promise<FlowStepResult> {
  const fs = new FlowStore(store);
  const def = await fs.getDefinition(input.flowId);
  if (!def) return { error: `unknown flow: ${input.flowId}`, status: 404 };

  // Supersede any stale active run for this conversation identity.
  if (input.chatRef) {
    const activeId = await fs.getActiveRunId(input.channel, input.chatRef);
    if (activeId) {
      const active = await fs.getRun(activeId);
      if (active && active.status === "active") {
        await cancelFlow(store, activeId, "superseded by a new run");
      } else {
        await fs.clearActive(input.channel, input.chatRef);
      }
    }
  }

  const nowIso = new Date().toISOString();
  const answers: Record<string, string | number> = {};
  if (input.initialAnswers) {
    for (const f of def.fields) {
      const v = input.initialAnswers[f.name];
      if (v === undefined || v === null) continue;
      answers[f.name] =
        typeof v === "number" ? v : truncateText(String(v), MAX_TEXT_ANSWER);
    }
  }

  const first = nextField(def, answers);
  const run: FlowRun = {
    id: newRunId(),
    flowId: def.id,
    ...(input.leadKey ? { leadKey: input.leadKey } : {}),
    channel: input.channel,
    ...(input.chatRef ? { chatRef: input.chatRef } : {}),
    status: "active",
    currentField: first ? first.name : null,
    answers,
    startedAt: nowIso,
    updatedAt: nowIso,
    priority: "normal",
  };
  await fs.saveRun(run);
  if (input.chatRef) await fs.setActive(input.channel, input.chatRef, run.id);
  await fs.audit("flow.started", {
    runId: run.id,
    flowId: def.id,
    channel: run.channel,
    leadKey: run.leadKey ?? null,
    prefilled: Object.keys(answers).length,
  });

  if (!first) return completeFlow(store, run, def);
  return { run, prompt: promptFor(first) };
}

/**
 * Feed one inbound message to an active run: match → store → urgency scan →
 * advance. Returns the next prompt, or done:true + summary on completion.
 * Unmatched answers return the SAME prompt with matched:false.
 */
export async function answerFlow(
  store: CallaStore,
  runId: string,
  text: string,
): Promise<FlowStepResult> {
  const fs = new FlowStore(store);
  const run = await fs.getRun(runId);
  if (!run) return { error: `unknown run: ${runId}`, status: 404 };
  if (run.status !== "active") {
    return { error: `run is ${run.status} — not accepting answers`, status: 409 };
  }
  const def = await fs.getDefinition(run.flowId);
  if (!def) {
    return { error: `flow definition "${run.flowId}" is missing (deleted custom flow?)`, status: 409 };
  }
  const field = def.fields.find((f) => f.name === run.currentField);
  if (!field) return completeFlow(store, run, def);

  const raw = String(text ?? "");

  // Urgency scan over EVERY answer text (roofing-style emergencies).
  const urgentKeyword = scanUrgency(raw);
  if (urgentKeyword) {
    await flagUrgent(fs, run, field.name, raw, urgentKeyword);
  }

  let matched = matchAnswer(field, raw);
  if (!matched.ok && matched.llmCandidate && (field.type === "number" || field.type === "text")) {
    const extracted = await llmExtractValue(field, raw);
    if (extracted !== null) {
      matched = { ok: true, value: extracted };
    } else if (field.type === "number") {
      // Fallback: store the raw text so the conversation never stalls.
      matched = { ok: true, value: truncateText(raw.trim(), MAX_TEXT_ANSWER) };
    }
  }
  if (!matched.ok) {
    // Re-prompt the same question (deterministic-first: never guess).
    run.updatedAt = new Date().toISOString();
    await fs.saveRun(run);
    return { run, prompt: promptFor(field), matched: false };
  }

  run.answers[field.name] = matched.value;
  run.updatedAt = new Date().toISOString();

  const next = nextField(def, run.answers);
  if (next) {
    run.currentField = next.name;
    await fs.saveRun(run);
    if (run.chatRef) await fs.setActive(run.channel, run.chatRef, run.id); // refresh TTL
    return { run, prompt: promptFor(next), matched: true };
  }

  run.currentField = null;
  const completed = await completeFlow(store, run, def);
  if (completed.error !== undefined) return completed;
  return { ...completed, matched: true };
}

/**
 * Finalize a run: deterministic score → tier → routing/booking proposal →
 * lead patch → audits. Also exported for callers that pre-fill runs.
 */
export async function completeFlow(
  store: CallaStore,
  run: FlowRun,
  def?: FlowDefinition | null,
): Promise<FlowStepResult> {
  const fs = new FlowStore(store);
  const flowDef = def ?? (await fs.getDefinition(run.flowId));
  if (!flowDef) {
    return { error: `flow definition "${run.flowId}" is missing`, status: 409 };
  }

  run.score = computeScore(flowDef, run.answers);
  run.tier = tierFor(flowDef, run.score);

  const summary: FlowSummary = {
    score: run.score,
    tier: run.tier,
    ...(flowDef.outcome.sequenceTag ? { sequenceTag: flowDef.outcome.sequenceTag } : {}),
  };

  // ── Routing + booking proposal ────────────────────────────────
  const intent = flowDef.outcome.bookingIntent;
  const intentOk =
    flowDef.outcome.onComplete === "route" &&
    (!intent || normValue(run.answers[intent.field] ?? "") === normValue(intent.equals));

  if (flowDef.outcome.onComplete === "route" && intentOk) {
    const eircodeField = flowDef.fields.find((f) => f.type === "eircode");
    const eircode = eircodeField ? String(run.answers[eircodeField.name] ?? "") : undefined;
    try {
      const routed = await routeLead(store, {
        ...(eircode ? { eircode } : {}),
        source: run.channel,
        tier: run.tier,
        vertical: flowDef.vertical,
      });
      if (routed) {
        const proposal: SlotProposal = await proposeSlotsForRep(store, routed.rep);
        const nowIso = new Date().toISOString();
        run.routing = {
          repId: routed.rep.id,
          repName: routed.rep.name,
          ...(routed.ruleId ? { ruleId: routed.ruleId } : {}),
          ...(proposal.slots.length ? { proposedSlots: proposal.slots } : {}),
          ...(proposal.link ? { link: proposal.link } : {}),
          notifiedAt: nowIso,
        };
        summary.repId = routed.rep.id;
        if (proposal.link) summary.link = proposal.link;
        if (proposal.slots.length) summary.slots = proposal.slots;
        summary.message = buildBookingProposalText(proposal, routed.rep.name);

        await fs.audit("flow.routed", {
          runId: run.id,
          flowId: run.flowId,
          leadKey: run.leadKey ?? null,
          repId: routed.rep.id,
          ruleId: routed.ruleId ?? null,
          provider: routed.rep.provider,
          tier: run.tier,
          score: run.score,
          slots: proposal.slots.length,
          link: proposal.link ?? null,
          provisional: proposal.provisional,
        });
        // Best-effort UI relay: calla:message {routed:true, …}.
        await sendCallaMessage({
          routed: true,
          runId: run.id,
          flowId: run.flowId,
          leadKey: run.leadKey ?? null,
          repId: routed.rep.id,
          repName: routed.rep.name,
          tier: run.tier,
          score: run.score,
          slots: proposal.slots,
          ...(proposal.link ? { link: proposal.link } : {}),
        });
      }
    } catch (err) {
      console.warn("[flows] routing failed (completing without a rep):", errorMessage(err));
      await fs.audit("flow.error", {
        runId: run.id,
        stage: "routing",
        error: errorMessage(err),
      });
    }
  }

  if (!summary.message) {
    summary.message =
      "Thanks — that's everything we need. We'll be in touch shortly.";
  }

  // ── Lead record sync (best-effort; status NEVER touched) ─────
  summary.leadPatched = await syncLeadOnCompletion(run, flowDef);

  run.status = "completed";
  run.completedAt = new Date().toISOString();
  run.updatedAt = run.completedAt;
  await fs.saveRun(run);
  if (run.chatRef) await fs.clearActive(run.channel, run.chatRef);

  await fs.audit("flow.completed", {
    runId: run.id,
    flowId: run.flowId,
    leadKey: run.leadKey ?? null,
    channel: run.channel,
    score: run.score,
    tier: run.tier,
    repId: run.routing?.repId ?? null,
    priority: run.priority ?? "normal",
    leadPatched: summary.leadPatched,
  });

  return { run, done: true, summary };
}

/** Cancel an active run (stale chat, operator reset, supersede). */
export async function cancelFlow(
  store: CallaStore,
  runId: string,
  reason?: string,
): Promise<FlowStepResult> {
  const fs = new FlowStore(store);
  const run = await fs.getRun(runId);
  if (!run) return { error: `unknown run: ${runId}`, status: 404 };
  if (run.status !== "active") {
    return { error: `run is already ${run.status}`, status: 409 };
  }
  run.status = "cancelled";
  run.currentField = null;
  run.updatedAt = new Date().toISOString();
  await fs.saveRun(run);
  if (run.chatRef) await fs.clearActive(run.channel, run.chatRef);
  await fs.audit("flow.abandoned", {
    runId: run.id,
    flowId: run.flowId,
    leadKey: run.leadKey ?? null,
    channel: run.channel,
    answeredFields: Object.keys(run.answers).length,
    reason: reason ?? null,
  });
  return { run, done: true };
}

/**
 * Active-run lookup used by channels BEFORE trigger/persona handling: when a
 * conversation has an in-progress run, every subsequent inbound message is
 * fed to answerFlow() instead. Self-heals (clears) stale keys.
 */
export async function getActiveRun(
  store: CallaStore,
  channel: FlowChannel | string,
  chatRef: string,
): Promise<string | null> {
  const fs = new FlowStore(store);
  const runId = await fs.getActiveRunId(channel, chatRef);
  if (!runId) return null;
  const run = await fs.getRun(runId);
  if (!run || run.status !== "active") {
    await fs.clearActive(channel, chatRef);
    return null;
  }
  return runId;
}

// ─── Post-booking confirmation ───────────────────────────────────

export type BookResult =
  | {
      ok: true;
      appointment: Appointment;
      link?: string;
      /** Google Meet join link created with the event, when the provider supports it. */
      meetingUrl?: string;
      /** One-click "Add to Google Calendar" URL for the attendee. */
      addToCalendarUrl?: string;
      run: FlowRun;
    }
  | { ok: false; error: string; status: number; link?: string };

/**
 * Convenience wrapper over the booking module's appointment creation for a
 * ROUTED run (same behavior as POST /booking/appointments, in-process):
 * confirms a proposed slot with the routed rep, attaches context.leadKey,
 * audits "flow.booked" and stamps run.routing.bookedAppointmentId.
 *
 * Calendly reps cannot be booked via API → 400 + {link} (share the
 * scheduling link; the Calendly webhook mirrors the booking back).
 */
export async function bookRunSlot(
  store: CallaStore,
  runId: string,
  slotStart: string,
  attendee?: Partial<Attendee>,
): Promise<BookResult> {
  const fs = new FlowStore(store);
  const run = await fs.getRun(runId);
  if (!run) return { ok: false, error: `unknown run: ${runId}`, status: 404 };
  const repId = run.routing?.repId;
  if (!repId) {
    return {
      ok: false,
      error: "run has no routed rep — complete the flow with booking intent first",
      status: 409,
    };
  }
  const bs = new BookingStore(store);
  const rep: Rep | null = await bs.getRep(repId);
  if (!rep) return { ok: false, error: `unknown rep: ${repId}`, status: 404 };
  if (!rep.enabled) return { ok: false, error: `rep "${rep.id}" is disabled`, status: 400 };

  if (rep.provider === "calendly") {
    return {
      ok: false,
      error:
        "calendly reps cannot be booked via this API — share the scheduling link; the webhook records the booking",
      status: 400,
      link: rep.schedulingLink ?? undefined,
    };
  }

  const startMs = Date.parse(slotStart);
  if (!Number.isFinite(startMs)) {
    return { ok: false, error: `invalid slotStart (expected ISO-8601): ${slotStart}`, status: 400 };
  }
  const policy = await bs.getPolicy();
  const slotMinutes = rep.slotMinutes ?? policy.slotMinutes;
  const startIso = new Date(startMs).toISOString();
  const endIso = new Date(startMs + slotMinutes * 60_000).toISOString();

  if (!rep.accountId) {
    return { ok: false, error: "not-connected", status: 409 };
  }
  const fresh = await getFreshConnection(bs, rep.provider as "google" | "microsoft", rep.accountId);
  if (!fresh.ok) {
    return {
      ok: false,
      error: fresh.reason === "provider-error" ? "provider-error" : "reconnect-required",
      status: fresh.reason === "provider-error" ? 502 : 409,
    };
  }

  const cfg = readBookingConfig();
  const timezone = rep.timezone ?? policy.timezone ?? DEFAULT_TIMEZONE;
  const finalAttendee: Attendee = {
    name: attendee?.name?.trim() || run.leadKey || run.chatRef || "Survey enquiry",
    ...(attendee?.email ? { email: attendee.email } : {}),
    ...(attendee?.phone ? { phone: attendee.phone } : {}),
  };
  const context = {
    ...(run.leadKey ? { leadKey: run.leadKey } : {}),
    notes: `Qualification flow ${run.flowId} — tier ${run.tier ?? "n/a"} (score ${run.score ?? 0})`,
  };

  try {
    const created =
      rep.provider === "google"
        ? await googleCreateEvent(cfg.google, fresh.conn, {
            attendee: finalAttendee,
            context,
            startIso,
            endIso,
            timezone,
            rep,
          })
        : await msCreateEvent(cfg.microsoft, fresh.conn, {
            attendee: finalAttendee,
            context,
            startIso,
            endIso,
            timezone,
            rep,
          });
    const appointment: Appointment = { ...created.appointment, context };

    run.routing = {
      ...run.routing!,
      bookedAppointmentId: appointment.id,
      bookedAt: new Date().toISOString(),
    };
    run.updatedAt = new Date().toISOString();
    await fs.saveRun(run);

    await fs.audit("flow.booked", {
      runId: run.id,
      flowId: run.flowId,
      leadKey: run.leadKey ?? null,
      appointmentId: appointment.id,
      provider: rep.provider,
      repId: rep.id,
      start: appointment.start,
      end: appointment.end,
      attendeeName: appointment.attendee.name,
    });

    const link =
      "htmlLink" in created && created.htmlLink
        ? created.htmlLink
        : "webLink" in created && created.webLink
          ? created.webLink
          : undefined;
    const meetingUrl =
      "meetingUrl" in created && created.meetingUrl ? created.meetingUrl : appointment.meetingUrl;
    const addToCalendarUrl = googleCalendarTemplateUrl({
      title: appointment.title,
      startIso: appointment.start,
      endIso: appointment.end,
      timezone,
      ...(meetingUrl
        ? { location: meetingUrl, details: `Join video call:\n${meetingUrl}` }
        : {}),
    });
    return {
      ok: true,
      appointment: meetingUrl ? { ...appointment, meetingUrl } : appointment,
      ...(link ? { link } : {}),
      ...(meetingUrl ? { meetingUrl } : {}),
      addToCalendarUrl,
      run,
    };
  } catch (err) {
    return {
      ok: false,
      error: `provider create failed: ${truncateText(errorMessage(err), 300)}`,
      status: 502,
    };
  }
}
