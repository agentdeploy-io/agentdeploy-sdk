/**
 * CallaVoiceAgent — the dental-receptionist voice DO (Workstream B).
 * ─────────────────────────────────────────────────────────────────
 * Extends the Agents SDK `Agent` with the `withVoice` mixin (agents/voice):
 * a Durable Object that manages a live audio session over the Agents
 * WebSocket protocol (`/agents/calla-voice-agent/:name`) and, over Telnyx
 * telephony, the /telnyx/stream bridge (B1).
 *
 *   inbound audio → Workers AI Flux STT (env.AI, per-call session)
 *                → onTurn():
 *                    1. deterministic emergency triage (keyword → immediate
 *                       escalation; the LLM never "handles" an emergency)
 *                    2. persona from the BRAIN skills store (dental-
 *                       receptionist config + skills; 5-min TTL cache;
 *                       builtin fallback) + live tool loop
 *                → Workers AI Aura-2 TTS (env.AI, linear16 16 kHz PCM)
 *
 * Tools (B2): the Chutes shared endpoint does not do native tool_calls —
 * the model emits a text marker line
 *   [TOOL_CALLS][{"name":"<tool>","arguments":{...}}]
 * which this DO parses, executes, feeds back as a
 *   [TOOL_RESULT <name>] <json>
 * user message, and re-prompts (bounded to MAX_TOOL_STEPS). A tool reply
 * is recognized by its FIRST characters (the verified endpoint behavior:
 * the marker is the whole reply), so ordinary replies still stream
 * word-level into the TTS sentence chunker.
 *
 *   - check_availability   → brain GET /booking/availability
 *   - book_appointment     → brain POST /booking/appointments, gated via the
 *                            edge HITL stack (CallaEdgeAgent "voice-gates")
 *                            for risky bookings (default policy "risky")
 *   - faq_lookup           → the fetched skill bodies (no extra round trip)
 *   - escalate_to_human    → audit + event + Telnyx outbound Call Control
 *                            dial to the on-call number (/telnyx/status
 *                            speaks the alert on answer)
 *
 * Recording: every turn appends to the brain's `voice:<callId>`
 * conversation thread (transcripts only — no audio retained). Every tool
 * call, booking, escalation and call boundary is appended to the hub's
 * hash-chained audit log.
 *
 * Self-disable doctrine: no LLM_API_KEY → echo mode; no BRAIN_URL → builtin
 * persona with booking tools disabled; no Telnyx creds → escalation still
 * fires the event + audit (UI takeover).
 */
import { Agent, callable } from "agents";
import { withVoice, WorkersAIFluxSTT } from "agents/voice";
import type {
  TTSProvider,
  Transcriber,
  TranscriberSession,
  TranscriberSessionOptions,
  VoiceTurnContext,
} from "agents/voice";
import {
  CALLA_EVENTS,
  callaFrame,
  type CallaStep,
} from "@calla/shared";
import type { Env } from "../env";
import type { CallaEventHub } from "./event-hub";
import {
  bookAppointment,
  brainConfigFromEnv,
  getAgentPersona,
  getBookingAvailability,
  listBookingReps,
  recordVoiceTranscript,
  type BrainConfig,
  type BrainRepRow,
} from "./brain-client";
import { telnyxOutboundCall } from "../telnyx";

const VoiceAgentBase = withVoice(Agent, {
  // Raw PCM16 on the wire (16 kHz): the browser client plays pcm16 natively
  // and the Telnyx L16 (16-bit linear 16 kHz) bidirectional stream consumes
  // raw PCM. MP3 is NOT decodable in the Workers runtime, so it cannot serve
  // the telephony path.
  audioFormat: "pcm16",
  sampleRate: 16000,
});

const DEFAULT_LLM_BASE_URL = "https://llm.chutes.ai/v1";
const DEFAULT_LLM_MODEL = "unsloth/Mistral-Nemo-Instruct-2407-TEE";
/** Chutes default sampling is 0.7 — a receptionist wants tighter output. */
const DEFAULT_LLM_TEMPERATURE = 0.3;
/** How much rolling history (messages) to send per turn. */
const HISTORY_LIMIT = 10;
/** Max tool round-trips per turn before a polite fallback. */
const MAX_TOOL_STEPS = 3;
const TOOL_MARKER = "[TOOL_CALLS]";
/** Brain persona refresh interval. */
const PERSONA_TTL_MS = 5 * 60_000;
/** CallaEdgeAgent instance that owns voice booking gates. */
const VOICE_GATE_AGENT_NAME = "voice-gates";
/** A phone call cannot wait 24h — gates expire after an hour. */
const VOICE_BOOKING_GATE_MS = 60 * 60_000;
/** The brain agent id whose config + skills form the persona. */
const DENTAL_AGENT_ID = "dental-receptionist";

/**
 * Builtin dental-receptionist fallback — used when BRAIN_URL is unset or the
 * brain is unreachable. Mirrors the brain's builtin/dental-receptionist/
 * seed (the store version is the source of truth once connected).
 */
const FALLBACK_PERSONA_PROMPT = `You are the friendly front-desk receptionist of Brightside Dental,
answering the practice's main phone line by voice.

How you speak:
- Short, natural sentences. You are heard, not read — never use lists,
  bullets, markdown, abbreviations, or stage directions.
- Warm, calm, professional. Confirm one thing at a time; ask a single
  question per turn.
- Keep answers under two sentences unless the caller asks for detail.

Practice facts (seeded defaults):
- Hours: Mon–Thu 8:00 AM – 6:00 PM, Fri 8:00 AM – 3:00 PM, Sat 9:00 AM –
  1:00 PM, closed Sundays. 120 Harbor Avenue, Suite 4, Portland, OR.
- Services: cleanings and exams, whitening, fillings and crowns, root
  canals, extractions, implant consultations, same-day emergencies.
- Insurance: most PPO plans (Delta, Cigna, MetLife, Aetna, Guardian); the
  office verifies coverage before the visit — never quote copays.

What you must NOT do:
- Never diagnose, give medical advice, or interpret symptoms.
- Never confirm or discuss another patient's details (privacy).
- If you do not know an answer, say you will have the team follow up by
  phone — never invent hours, prices or availability.
- You are an AI assistant; say so plainly if the caller asks.

If the caller is rude or off-topic, stay courteous and steer back to
booking and practice information.`;

/** Deterministic triage fallback when the skill frontmatter is missing. */
const FALLBACK_EMERGENCY_KEYWORDS = [
  "severe pain",
  "too much pain",
  "swelling",
  "swollen",
  "knocked out",
  "knocked-out",
  "tooth out",
  "heavy bleeding",
  "lots of blood",
  "can't breathe",
  "difficulty breathing",
];

const EMERGENCY_SCRIPT_FIRST =
  "I'm connecting you with our on-call team right now. They will call you back on this number very soon. If this is a life-threatening emergency, please call 911 now.";
const EMERGENCY_SCRIPT_REPEATED =
  "I've already alerted our on-call team — they will call you right back on this number.";
const POST_ESCALATION_TURN =
  "Our on-call team is handling this and will call you right back. If your situation is getting worse, please call 911.";
const TOOL_FALLBACK_TEXT =
  "I'm having trouble reaching my scheduling system. Could you give me the details again, or I can have the team call you back.";
// Spoken deterministically the moment a call connects (after the Telnyx consent
// line), so the caller is never left in silence and their first real input is
// always a request the agent can answer directly — no LLM-dependent greeting.
const CALL_OPENING_GREETING =
  "Thank you for calling Brightside Dental, this is the automated front desk. How can I help you today?";

/**
 * Aura-2 TTS as raw linear16 PCM (16 kHz, no container) — the format both
 * downstream consumers need:
 *  - Telnyx telephony: the /telnyx/stream bridge sends raw PCM as L16
 *    16 kHz (MP3 is not decodable in the Workers runtime).
 *  - Browser client: played as pcm16 (audioFormat "pcm16", 16 kHz).
 * Returning null on failure keeps the call alive (silence, logged).
 */
class CallaPCMTTS implements TTSProvider {
  constructor(
    private readonly ai: Ai,
    private readonly model: string,
    private readonly speaker: string,
  ) {}

  async synthesize(text: string, signal?: AbortSignal): Promise<ArrayBuffer | null> {
    try {
      const response = (await this.ai.run(
        this.model,
        { text, speaker: this.speaker, encoding: "linear16", sample_rate: 16000, container: "none" },
        { returnRawResponse: true, ...(signal ? { signal } : {}) },
      )) as unknown as Response;
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        // Full body + headers so we can read the REAL internalCode (3036 quota
        // vs 3040 out-of-capacity vs other) and any Retry-After hint.
        const headers = Object.fromEntries(
          response.headers ? Array.from(response.headers.entries()) : [],
        );
        console.error(
          `[calla-voice] TTS ${response.status} FULL: ${detail} | headers=${JSON.stringify(headers)}`,
        );
        return null;
      }
      return await response.arrayBuffer();
    } catch (err) {
      console.error("[calla-voice] TTS failed:", err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      return null;
    }
  }
}

/**
 * No-op TTS — used when `VOICE_TTS_MODE=noop` (local dev / stress runs).
 * Returns no audio so the account's Workers AI neuron quota is NOT consumed
 * by local testing (Aura-2 is billed per 1k characters). The agent still
 * produces correct transcripts + tools + audit; only the spoken egress is
 * skipped. Flip to the default ("aura-2") to exercise real TTS.
 */
class NoopTTS implements TTSProvider {
  async synthesize(_text: string, _signal?: AbortSignal): Promise<ArrayBuffer | null> {
    return null;
  }
}

// ── Persona ────────────────────────────────────────────────────────────────

interface VoicePersona {
  systemPrompt: string;
  emergencyKeywords: string[];
  /** name → skill body (faq_lookup material). */
  skillBodies: Map<string, string>;
  fetchedAt: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ParsedToolCall {
  name: string;
  args: Record<string, unknown>;
}

interface ToolOutcome {
  /** JSON fed back to the LLM as the tool result. */
  result: string;
  /** When set, the turn ends by speaking THIS text (deterministic). */
  spoken?: string;
}

interface LlmStepOutcome {
  /** Full content of the step (spoken text or tool marker). */
  text: string;
  isToolCall: boolean;
}

/**
 * Extract the balanced JSON value (array or object) starting at `start` in
 * `text`. Returns the JSON substring, "pending" when the value is still
 * open (stream not finished), or null when `text[start]` is not an opener.
 * String-aware (brackets inside "..." don't count).
 */
function extractBalancedJson(text: string, start: number): string | "pending" | null {
  const opener = text[start];
  if (opener !== "[" && opener !== "{") return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "[" || ch === "{") depth += 1;
    else if (ch === "]" || ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return "pending";
}

function tryParseTool(raw: string): ParsedToolCall | null {
  try {
    let parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) parsed = [parsed];
    for (const item of parsed as Array<Record<string, unknown>>) {
      if (item && typeof item.name === "string") {
        const args = item.arguments;
        return {
          name: item.name,
          args:
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
        };
      }
    }
  } catch {
    // not (yet) valid JSON
  }
  return null;
}

/**
 * Parse a tool call out of a reply. Handles every shape observed on the
 * Chutes shared endpoint:
 *   1. [TOOL_CALLS][{"name":...,"arguments":{...}}]   (documented form)
 *   2. [{"name":...,"arguments":{...}}]               (bare leading array)
 *   3. <json> + trailing prose in the same completion (model quirk — the
 *      prose is dropped; the re-prompt step regenerates the spoken reply)
 */
function parseToolCall(text: string): ParsedToolCall | null {
  const t = text.trim();
  const markerIdx = t.indexOf(TOOL_MARKER);
  if (markerIdx >= 0) {
    const rest = t.slice(markerIdx + TOOL_MARKER.length).trimStart();
    if (rest.startsWith("[") || rest.startsWith("{")) {
      const ex = extractBalancedJson(rest, 0);
      if (ex !== "pending" && ex) return tryParseTool(ex);
    }
    return null;
  }
  if (t.startsWith("[")) {
    const ex = extractBalancedJson(t, 0);
    if (ex !== "pending" && ex) return tryParseTool(ex);
  }
  return null;
}

/**
 * Live classification of a still-streaming reply: "tool" (swallow — it must
 * never be spoken), "spoken" (release to TTS), or "watch" (leading bracket
 * not yet closed — keep holding).
 */
function classifyStreaming(full: string): "tool" | "spoken" | "watch" {
  const t = full.trimStart();
  if (t.startsWith(TOOL_MARKER)) return "tool";
  if (t.startsWith("[")) {
    if (t.includes("\n") || t.length > 600) return "spoken"; // prose, not JSON
    const ex = extractBalancedJson(t, 0);
    if (ex === "pending") return "watch";
    if (ex) return tryParseTool(ex) ? "tool" : "spoken";
  }
  return "spoken";
}

/**
 * Force strict user/assistant alternation (Chutes requires it after the
 * system message). The SDK persists turn history in cf_voice_messages, but an
 * assistant reply is only saved when it completes without an abort/TTS
 * failure — so the history can contain consecutive same-role messages. Merge
 * any consecutive same-role messages (keeping their content) so the request
 * is always valid.
 */
function normalizeAlternation(msgs: ChatMessage[]): ChatMessage[] {
  const out: ChatMessage[] = [];
  for (const m of msgs) {
    const last = out[out.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n${m.content}`.trim();
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/** Render a URL in a phone-friendly spoken form: "calendly dot com slash …". */
function speakableUrl(url: string): string {
  return url
    .replace(/^https?:\/\//i, "")
    .replace(/\/+/g, " slash ")
    .replace(/\./g, " dot ")
    .replace(/-/g, " dash ");
}

function buildToolProtocolPrompt(personaBlock: string, todayLabel: string, callId: string): string {
  return `${personaBlock}

# Current context
- Today is ${todayLabel}.
- Your call id is ${callId} (refer to it only if asked).
- You ALREADY greeted the caller the moment the call connected. Do NOT greet
  again or repeat "how can I help" — respond directly and warmly to what they
  just said.

# Tools
When you need live data or an action, your ENTIRE reply must be a single tool
call — no other words, no prose before or after it:
[TOOL_CALLS][{"name":"<tool>","arguments":{...}}]

Example: the caller asks for tomorrow's cleaning slots →
[TOOL_CALLS][{"name":"check_availability","arguments":{"date":"2026-10-09","reason":"cleaning"}}]
The result arrives as your next user message; then answer in spoken form.

Available tools:
- check_availability {"date"?: "YYYY-MM-DD", "reason"?: "string"}
  Real open slots from the practice calendar. ALWAYS check before offering
  times; never invent availability. Calendly practices return a scheduling
  link instead — share it with the caller.
- book_appointment {"start": "YYYY-MM-DDTHH:MM", "name": "string",
  "phone"?: "string", "reason"?: "string", "newPatient"?: boolean}
  Books the slot the caller picked. It may pause for a human approval —
  that is normal; relay the awaiting-approval message when it happens.
  Calendly practices return a scheduling link instead: share the link,
  then confirm the time by phone.
- faq_lookup {"topic": "string"}
  Practice facts (hours, services, insurance, policies).
- escalate_to_human {"reason": "string"}
  Hands the caller to a person. REQUIRED for any medical/dental emergency.`;
}

/**
 * No-op STT — a valid Transcriber that never touches the remote Workers AI
 * endpoint. Used when `VOICE_STT_MODE=noop` (local dev / text-driven E2E, or
 * as a fallback when the remote Flux endpoint is unavailable): the call never
 * dies on `stt_startup_failed`, and caller input is supplied via
 * `text_message`. Caller audio is ignored (feed() is a no-op).
 */
class NoopSTT implements Transcriber {
  createSession(_options?: TranscriberSessionOptions): TranscriberSession {
    return {
      feed(_chunk: ArrayBuffer) {},
      waitUntilReady: async () => {},
      close() {},
    };
  }
}

export class CallaVoiceAgent extends VoiceAgentBase<Env> {
  // ── Voice pipeline providers (Workers AI) ───────────────────────
  // Flux: conversational STT with built-in end-of-turn detection — one
  // session per call, no client-side silence signaling. The /telnyx/stream
  // bridge converts the 8 kHz PCMU inbound track to 16 kHz PCM before this
  // provider (L16 16 kHz inbound is passed through).
  // VOICE_STT_MODE=noop swaps in NoopSTT (text-only; no remote Flux) so local
  // E2E + stress runs survive even when the remote Flux STT endpoint is down.
  transcriber: Transcriber =
    this.env.VOICE_STT_MODE === "noop"
      ? new NoopSTT()
      : new WorkersAIFluxSTT(this.env.AI, { eotThreshold: 0.7 });
  // Aura-2 TTS, raw linear16 PCM (see CallaPCMTTS). Default speaker "luna".
  // VOICE_TTS_MODE=noop swaps in NoopTTS (no audio egress, zero neurons) so
  // local E2E/stress runs don't burn the account's Workers AI quota.
  tts: TTSProvider =
    this.env.VOICE_TTS_MODE === "noop"
      ? new NoopTTS()
      : new CallaPCMTTS(
          this.env.AI,
          this.env.VOICE_TTS_MODEL ?? "@cf/deepgram/aura-2-en",
          this.env.VOICE_TTS_SPEAKER ?? "luna",
        );

  // ── B2 state ─────────────────────────────────────────────────────────
  private callStartedAt: number | null = null;
  private personaCache: VoicePersona | null = null;
  private personaInFlight: Promise<VoicePersona> | null = null;
  private repIdCache: { value: string | null; fetchedAt: number } | null = null;
  private escalated = false;

  // ── Lifecycle hooks (B2: /events frames + audit chain) ────────────

  async onCallStart(connection: VoiceTurnContext["connection"]): Promise<void> {
    this.callStartedAt = Date.now();
    console.log(`[calla-voice] call started (instance=${this.name})`);
    if (!this.env.AI) {
      console.warn(
        "[calla-voice] env.AI missing — STT/TTS disabled for this call (add the `ai` binding; local dev needs `wrangler login` so the AI proxy can start).",
      );
    }
    this.publishEvent(CALLA_EVENTS.voiceCallStart, { callId: this.name, source: "do" });
    await this.appendAudit("voice.call_start", { callId: this.name });
    // Prefetch the persona so the first turn doesn't pay the round trip.
    void this.getPersona().catch(() => {});
    // Deterministic opening greeting (fire-and-forget): a TTS hiccup must never
    // block call start — the call stays fully usable if the greeting fails.
    void this.speakOpeningGreeting(connection);
  }

  private async speakOpeningGreeting(
    connection: VoiceTurnContext["connection"],
  ): Promise<void> {
    try {
      // Let the connection + audio path settle before the first TTS.
      await new Promise((r) => setTimeout(r, 600));
      this.recordTranscript("outbound", CALL_OPENING_GREETING, "system");
      await this.speak(connection, CALL_OPENING_GREETING);
    } catch (err) {
      console.error(`[calla-voice] opening greeting failed:`, err);
    }
  }

  async onCallEnd(connection: VoiceTurnContext["connection"]): Promise<void> {
    const durationMs = this.callStartedAt ? Date.now() - this.callStartedAt : null;
    console.log(`[calla-voice] call ended (instance=${this.name})`);
    this.publishEvent(CALLA_EVENTS.voiceCallEnd, {
      callId: this.name,
      durationSec: durationMs != null ? Math.round(durationMs / 1000) : undefined,
      escalated: this.escalated || undefined,
    });
    await this.appendAudit("voice.call_end", {
      callId: this.name,
      durationMs,
      escalated: this.escalated,
    });
  }

  async onInterrupt(connection: VoiceTurnContext["connection"]): Promise<void> {
    console.log(`[calla-voice] barge-in interrupt (instance=${this.name})`);
  }

  /**
    * Operator transfer (B3): the Calls UI's "Transfer to human" button calls
    * this over DO RPC (`POST /voice/:callId/escalate`). Runs the same
    * deterministic escalation as triage — audit + event + thread record +
    * Telnyx outbound dial — with source "operator". Idempotent per call.
   */
  @callable()
  async escalate(input: { reason?: string }): Promise<{
    status: "escalated";
    firstTime: boolean;
    spoken: string;
  }> {
    const { spoken, firstTime } = await this.doEscalate(
      input.reason?.trim() || "operator transfer",
      "operator",
    );
    return { status: "escalated", firstTime, spoken };
  }

  // ── The turn: transcript → triage → (tools →) LLM → spoken text ─────

  async onTurn(
    transcript: string,
    context: VoiceTurnContext,
  ): Promise<AsyncIterable<unknown> | string> {
    const persona = await this.getPersona();

    // Transcript persistence (brain `voice:<callId>` thread) + live frame.
    this.recordTranscript("inbound", transcript);
    this.publishEvent(CALLA_EVENTS.voiceTranscript, {
      callId: this.name,
      dir: "inbound",
      text: transcript,
    });

    // Post-escalation turns: deterministic, no LLM.
    if (this.escalated) {
      this.recordTranscript("outbound", POST_ESCALATION_TURN);
      return POST_ESCALATION_TURN;
    }

    // Deterministic emergency triage — the LLM never "handles" an emergency.
    const emergencyKeyword = this.matchEmergency(transcript, persona.emergencyKeywords);
    if (emergencyKeyword) {
      const { spoken } = await this.doEscalate(`emergency: ${emergencyKeyword}`, "triage");
      this.recordTranscript("outbound", spoken);
      return spoken;
    }

    const apiKey = this.env.LLM_API_KEY?.trim();
    if (!apiKey) {
      // Echo mode — proves the STT→TTS loop with no LLM credentials.
      const spoken = `Echo mode, no LLM key configured. I heard you say: ${transcript}.`;
      this.recordTranscript("outbound", spoken);
      return spoken;
    }

    try {
      return this.trackSpoken(this.runTurnLoop(transcript, context, persona));
    } catch (err) {
      console.error(`[calla-voice] LLM turn failed:`, err);
      const spoken = "Sorry, I had a problem connecting to my notes. Could you say that again, please?";
      this.recordTranscript("outbound", spoken);
      return spoken;
    }
  }

  // ── Tool loop ──────────────────────────────────────────────────────────

  /**
   * Bounded tool loop. Ordinary replies stream live (deltas yielded as they
   * arrive); a reply that STARTS with the tool marker is swallowed, the tool
   * runs, and the result is fed back as a user message before re-prompting.
   */
  private async *runTurnLoop(
    transcript: string,
    context: VoiceTurnContext,
    persona: VoicePersona,
  ): AsyncGenerator<string> {
    // The deterministic opening greeting is spoken via speak() and thus lands
    // in the SDK history as a leading "assistant" message. Chutes requires
    // roles to alternate user/assistant after the system message, so a leading
    // assistant (the canned greeting, which the LLM doesn't need in context)
    // would break the first turn — drop history up to the first real user turn.
    const recent = context.messages.slice(-HISTORY_LIMIT);
    const firstUser = recent.findIndex((m) => m.role === "user");
    const history = (firstUser === -1 ? [] : recent.slice(firstUser)).map((m) => ({
      role: m.role as ChatMessage["role"],
      content: m.content,
    }));
    const baseMessages: ChatMessage[] = [
      { role: "system", content: this.buildSystemPrompt(persona) },
      ...history,
    ];
    const messages: ChatMessage[] = normalizeAlternation([
      ...baseMessages,
      { role: "user", content: transcript },
    ]);

    for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
      const outcome = yield* this.streamLlmStep(messages, context);
      const parsed = outcome.isToolCall ? parseToolCall(outcome.text) : null;
      if (!parsed) return; // spoken reply fully streamed

      const toolOut = await this.runTool(parsed, persona);
      messages.push({ role: "assistant", content: outcome.text });
      messages.push({
        role: "user",
        content: `[TOOL_RESULT ${parsed.name}] ${toolOut.result}`,
      });
      if (toolOut.spoken) {
        yield toolOut.spoken;
        return;
      }
    }
    yield TOOL_FALLBACK_TEXT;
  }

  /**
   * One LLM step over the OpenAI-compatible SSE stream. Yields content
   * deltas for spoken replies; when the reply starts with the tool marker
   * it yields nothing (the marker must never be spoken) and reports the
   * step as a tool call.
   */
  private async *streamLlmStep(
    messages: ChatMessage[],
    context: VoiceTurnContext,
  ): AsyncGenerator<string, LlmStepOutcome> {
    const baseUrl = (this.env.LLM_BASE_URL ?? DEFAULT_LLM_BASE_URL).replace(/\/+$/, "");
    const model = this.env.LLM_MODEL ?? DEFAULT_LLM_MODEL;
    const body = {
      model,
      temperature: DEFAULT_LLM_TEMPERATURE,
      stream: true,
      max_tokens: 220,
      messages,
    };

    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.env.LLM_API_KEY!.trim()}`,
      },
      body: JSON.stringify(body),
      signal: context.signal,
    });
    if (!res.ok || !res.body) {
      const detail = await res.text().catch(() => "");
      throw new Error(`LLM ${res.status}: ${detail.slice(0, 200)}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let full = "";
    let released = false;
    let toolMode = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") break;
        let delta: unknown;
        try {
          delta = (JSON.parse(data) as { choices?: Array<{ delta?: { content?: unknown } }> })
            .choices?.[0]?.delta?.content;
        } catch {
          continue; // keep-alive / partial line
        }
        if (typeof delta !== "string" || delta.length === 0) continue;
        full += delta;
        if (toolMode) continue; // swallowed — a tool call is never spoken
        if (!released) {
          const cls = classifyStreaming(full);
          if (cls === "tool") {
            toolMode = true;
            continue;
          }
          if (cls === "watch") continue; // leading bracket, not closed yet
          released = true;
          yield full;
          continue;
        }
        yield delta;
      }
    }
    // Short spoken reply that was never released (under the window or still
    // being bracket-watched at stream end): release it now.
    if (!released && !toolMode) yield full;

    return {
      text: full,
      isToolCall: toolMode || parseToolCall(full) !== null,
    };
  }

  // ── Tools ──────────────────────────────────────────────────────────────

  private async runTool(call: ParsedToolCall, persona: VoicePersona): Promise<ToolOutcome> {
    const args = call.args ?? {};
    let outcome: ToolOutcome;
    try {
      switch (call.name) {
        case "check_availability":
          outcome = await this.toolCheckAvailability(args);
          break;
        case "book_appointment":
          outcome = await this.toolBookAppointment(args);
          break;
        case "faq_lookup":
          outcome = this.toolFaqLookup(args, persona);
          break;
        case "escalate_to_human":
          outcome = {
            result: JSON.stringify({ status: "escalated" }),
            spoken: (
              await this.doEscalate(
                typeof args.reason === "string" && args.reason.trim()
                  ? args.reason.trim()
                  : "caller requested a person",
                "tool",
              )
            ).spoken,
          };
          break;
        default:
          outcome = { result: JSON.stringify({ error: `unknown tool: ${call.name}` }) };
      }
    } catch (err) {
      console.error(`[calla-voice] tool ${call.name} failed:`, err);
      outcome = { result: JSON.stringify({ error: "tool failed — offer to take a message" }) };
    }
    await this.appendAudit(`voice.tool.${call.name}`, {
      callId: this.name,
      args: this.scrubArgs(args),
    });
    return outcome;
  }

  private async toolCheckAvailability(args: Record<string, unknown>): Promise<ToolOutcome> {
    const cfg = brainConfigFromEnv(this.env);
    if (!cfg) {
      return { result: JSON.stringify({ error: "booking system not connected — offer to take a message" }) };
    }
    const repId = await this.resolveRepId(cfg);
    if (!repId) {
      return { result: JSON.stringify({ error: "no booking calendar configured" }) };
    }
    let fromMs = Date.now();
    if (typeof args.date === "string") {
      const parsed = Date.parse(args.date);
      if (Number.isFinite(parsed)) fromMs = parsed;
    }
    const avail = await getBookingAvailability(cfg, repId, fromMs, fromMs + 7 * 86_400_000);
    if (!avail.ok) {
      return { result: JSON.stringify({ error: avail.error, status: avail.status }) };
    }
    if (avail.kind === "link") {
      // Calendly: no real slots exist to offer — a weak model will invent them.
      // Speak the hand-off deterministically (never LLM-composed).
      return {
        result: JSON.stringify({ schedulingLink: avail.link, status: "calendly_handoff" }),
        spoken: this.calendlyHandoffSpoken(avail.link),
      };
    }
    return {
      result: JSON.stringify({
        slots: avail.slots.slice(0, 5),
        note: "Offer at most two of these to the caller.",
      }),
    };
  }

  private async toolBookAppointment(args: Record<string, unknown>): Promise<ToolOutcome> {
    const cfg = brainConfigFromEnv(this.env);
    if (!cfg) {
      return { result: JSON.stringify({ error: "booking system not connected — offer to take a message" }) };
    }
    const start = typeof args.start === "string" ? args.start.trim() : "";
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!start || !name) {
      return { result: JSON.stringify({ error: "start (ISO) and name are required" }) };
    }
    const repId = await this.resolveRepId(cfg);
    if (!repId) {
      return { result: JSON.stringify({ error: "no booking calendar configured" }) };
    }
    const phone = typeof args.phone === "string" && args.phone.trim() ? args.phone.trim() : undefined;
    const email =
      typeof args.email === "string" && args.email.trim() ? args.email.trim() : undefined;
    const reason = typeof args.reason === "string" ? args.reason.trim() : undefined;
    const newPatient = args.newPatient === true;

    // Calendly reps have no server-side event — booking is a scheduling-link
    // hand-off, so there is nothing to approval-gate.
    const startMs = Date.parse(start);
    const anchor = Number.isFinite(startMs) ? startMs : Date.now();
    const avail = await getBookingAvailability(cfg, repId, anchor, anchor + 86_400_000);
    if (avail.ok && avail.kind === "link") {
      this.recordTranscript(
        "outbound",
        `Booking link shared: ${name}, ${start}.`,
        "system",
      );
      return this.bookingHandoffResult(avail.link, start, name);
    }

    const attendee = { name, ...(phone ? { phone } : {}), ...(email ? { email } : {}) };
    const context = { leadKey: `voice:${this.name}`, notes: reason ?? "voice booking" };

    // Approval policy (VOICE_BOOKING_APPROVAL): always | risky | never.
    const policy = (this.env.VOICE_BOOKING_APPROVAL ?? "risky").toLowerCase();
    const risky =
      newPatient ||
      !phone ||
      /reschedul|cancel|change|move/i.test(reason ?? "");
    const gated = policy === "always" || (policy === "risky" && risky);

    if (gated) {
      const step: CallaStep = {
        id: `voice-book-${Date.now()}`,
        action: "voice.book_appointment",
        params: { repId, start, attendee, context, callId: this.name },
        requiresApproval: true,
        risk: "high",
        timeoutMs: VOICE_BOOKING_GATE_MS,
      };
      const result = await this.env.CALLA_EDGE_AGENT.getByName(
        VOICE_GATE_AGENT_NAME,
      ).executeStep(step);
      if (result.status === "awaiting_approval") {
        this.recordTranscript(
          "outbound",
          `Booking request sent for approval: ${name}, ${start}.`,
          "system",
        );
        return {
          result: JSON.stringify({
            status: "awaiting_approval",
            approvalId: result.approvalId,
            message:
              "A human team member must confirm this booking before it is made.",
          }),
        };
      }
      return {
        result: JSON.stringify({
          status: result.status,
          ...(result.status === "failed" ? { error: result.error } : {}),
        }),
      };
    }

    const out = await bookAppointment(cfg, { repId, start, attendee, context });
    if (!out.ok) {
      this.publishEvent(CALLA_EVENTS.voiceBooking, {
        callId: this.name,
        status: "failed",
        detail: out.error,
      });
      await this.appendAudit("voice.booking_failed", {
        callId: this.name,
        start,
        status: out.status,
        error: out.error,
      });
      return { result: JSON.stringify({ error: out.error, status: out.status }) };
    }
    if (out.kind === "handoff") {
      this.recordTranscript("outbound", `Booking link shared: ${name}, ${start}.`, "system");
      return this.bookingHandoffResult(out.link, start, name);
    }
    this.publishEvent(CALLA_EVENTS.voiceBooking, {
      callId: this.name,
      status: "booked",
      detail: out.appointmentId ?? undefined,
    });
    await this.appendAudit("voice.booking_created", {
      callId: this.name,
      appointmentId: out.appointmentId,
      start,
    });
    this.recordTranscript("outbound", `Appointment booked: ${name}, ${start}.`, "system");
    return { result: JSON.stringify({ status: "booked", appointmentId: out.appointmentId }) };
  }

  /** Shared result for a Calendly scheduling-link hand-off (no server-side event). */
  private bookingHandoffResult(
    link: string | null,
    start: string,
    name: string,
  ): ToolOutcome {
    this.publishEvent(CALLA_EVENTS.voiceBooking, {
      callId: this.name,
      status: "handoff",
      detail: link ?? undefined,
    });
    void this.appendAudit("voice.booking_handoff", {
      callId: this.name,
      start,
      name,
      link: link ?? null,
    });
    return {
      result: JSON.stringify({ status: "calendly_handoff", schedulingLink: link ?? null }),
      spoken: this.calendlyHandoffSpoken(link),
    };
  }

  /** Deterministic Calendly hand-off line — spoken verbatim, never LLM-composed. */
  private calendlyHandoffSpoken(link: string | null): string {
    const spoken = link ? speakableUrl(link) : "our online booking page";
    return (
      "I can get you booked. You can pick a time online at " +
      `${spoken} — just open that on your phone. ` +
      "What day and time suits you best, and I'll have our team confirm your appointment?"
    );
  }

  private toolFaqLookup(
    args: Record<string, unknown>,
    persona: VoicePersona,
  ): ToolOutcome {
    const topic = typeof args.topic === "string" ? args.topic.toLowerCase() : "";
    const tokens = topic.split(/[^a-z0-9]+/).filter((t) => t.length > 3);
    let best: { name: string; body: string } | null = null;
    let bestScore = 0;
    for (const [name, body] of persona.skillBodies) {
      const bodyLower = body.toLowerCase();
      const nameHits = name
        .split("-")
        .filter((part) => part.length > 3 && tokens.some((t) => t.includes(part) || part.includes(t)))
        .length;
      const bodyHits = tokens.filter((t) => bodyLower.includes(t)).length;
      const score = nameHits * 2 + bodyHits;
      if (score > bestScore) {
        bestScore = score;
        best = { name, body };
      }
    }
    if (!best) {
      return {
        result: JSON.stringify({
          found: false,
          note: "Not in the practice facts. Say the team will follow up by phone, or offer to take a message.",
        }),
      };
    }
    return {
      result: JSON.stringify({ found: true, topic: best.name, facts: best.body.slice(0, 1500) }),
    };
  }

  // ── Escalation ─────────────────────────────────────────────────────────

  /**
   * Deterministic escalation: audit + event + conversation record + Telnyx
   * outbound dial to the on-call number (best-effort). Idempotent per call —
   * a second escalation (triage AND tool AND operator) only re-announces.
   */
  private async doEscalate(
    reason: string,
    source: "triage" | "tool" | "operator",
  ): Promise<{ spoken: string; firstTime: boolean }> {
    const firstTime = !this.escalated;
    this.escalated = true;
    await this.appendAudit("voice.escalation", {
      callId: this.name,
      reason,
      source,
      firstTime,
    });
    this.publishEvent(CALLA_EVENTS.voiceEscalation, {
      callId: this.name,
      reason,
      source,
      firstTime,
    });
    this.recordTranscript(
      "outbound",
      `Call escalated to a human (${source}): ${reason}.`,
      "system",
    );

    if (firstTime) {
      const edgeUrl = this.env.CALLA_EDGE_URL?.replace(/\/+$/, "");
      const to = this.env.TELNYX_ESCALATION_NUMBER?.trim();
      if (edgeUrl && to) {
        // Outbound Call Control dial; /telnyx/status speaks the dynamic
        // alert when the on-call person answers (client_state carries the
        // escalated call id + reason).
        const dial = await telnyxOutboundCall(this.env, {
          to,
          callId: this.name,
          reason: reason.slice(0, 120),
        });
        if (!dial.ok) {
          console.warn(`[calla-voice] escalation dial failed: ${dial.error}`);
        } else {
          console.log(`[calla-voice] escalation dial placed (telnyx call ${dial.callId})`);
        }
      } else {
        console.warn(
          "[calla-voice] escalation event fired but no Telnyx outbound configured (set TELNYX_ESCALATION_NUMBER + CALLA_EDGE_URL) — UI takeover only.",
        );
      }
    }
    return {
      spoken: firstTime ? EMERGENCY_SCRIPT_FIRST : EMERGENCY_SCRIPT_REPEATED,
      firstTime,
    };
  }

  /** Deterministic emergency triage: first keyword hit wins. */
  private matchEmergency(
    transcript: string,
    keywords: string[],
  ): string | null {
    const lower = transcript.toLowerCase();
    for (const kw of keywords) {
      if (kw.length > 0 && lower.includes(kw)) return kw;
    }
    return null;
  }

  // ── Persona (brain skills store, 5-min TTL, builtin fallback) ─────────

  private async getPersona(): Promise<VoicePersona> {
    if (this.personaCache && Date.now() - this.personaCache.fetchedAt < PERSONA_TTL_MS) {
      return this.personaCache;
    }
    if (!this.personaInFlight) {
      this.personaInFlight = this.fetchPersona().finally(() => {
        this.personaInFlight = null;
      });
    }
    return this.personaInFlight;
  }

  private async fetchPersona(): Promise<VoicePersona> {
    const cfg = brainConfigFromEnv(this.env);
    if (cfg) {
      const result = await getAgentPersona(cfg, DENTAL_AGENT_ID);
      if (result.ok) {
        const skillBodies = new Map<string, string>();
        let emergencyKeywords = FALLBACK_EMERGENCY_KEYWORDS;
        for (const skill of result.skills) {
          skillBodies.set(skill.name, skill.instructions);
          if (skill.name === "emergency-triage" && skill.references) {
            try {
              const fm = JSON.parse(skill.references["frontmatter.json"] ?? "{}") as {
                emergency_keywords?: unknown;
              };
              if (
                Array.isArray(fm.emergency_keywords) &&
                fm.emergency_keywords.length > 0
              ) {
                emergencyKeywords = fm.emergency_keywords.filter(
                  (k): k is string => typeof k === "string" && k.trim().length > 0,
                );
              }
            } catch {
              // keep the fallback list
            }
          }
        }
        const persona: VoicePersona = {
          systemPrompt: result.config.instructions,
          emergencyKeywords,
          skillBodies,
          fetchedAt: Date.now(),
        };
        this.personaCache = persona;
        console.log(
          `[calla-voice] persona loaded from brain (${result.skills.length} skills)`,
        );
        return persona;
      }
      console.warn(`[calla-voice] persona fetch failed (${result.status}): ${result.error}`);
    }
    const fallback: VoicePersona = {
      systemPrompt: FALLBACK_PERSONA_PROMPT,
      emergencyKeywords: FALLBACK_EMERGENCY_KEYWORDS,
      skillBodies: new Map(),
      fetchedAt: Date.now(),
    };
    this.personaCache = fallback;
    return fallback;
  }

  private buildSystemPrompt(persona: VoicePersona): string {
    const todayLabel = new Date().toLocaleDateString("en-US", {
      weekday: "long",
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const skillsBlock = [...persona.skillBodies.entries()]
      .map(([name, body]) => `## ${name}\n${body}`)
      .join("\n\n");
    const personaBlock = skillsBlock
      ? `${persona.systemPrompt}\n\n# Skills (the practice's knowledge — answer from these)\n${skillsBlock}`
      : persona.systemPrompt;
    return buildToolProtocolPrompt(personaBlock, todayLabel, this.name);
  }

  // ── Booking rep resolution ─────────────────────────────────────────────

  private async resolveRepId(cfg: BrainConfig): Promise<string | null> {
    const configured = this.env.VOICE_BOOKING_REP_ID?.trim();
    if (configured) return configured;
    if (this.repIdCache && Date.now() - this.repIdCache.fetchedAt < PERSONA_TTL_MS) {
      return this.repIdCache.value;
    }
    const result = await listBookingReps(cfg);
    const value =
      result.ok && result.reps.length > 0
        ? (result.reps.find((r: BrainRepRow) => r.enabled) ?? result.reps[0]).repId
        : null;
    this.repIdCache = { value, fetchedAt: Date.now() };
    return value;
  }

  // ── Recording / events / audit (best-effort — never fail the call) ─────

  /** Pass-through that records the full spoken reply once at turn end. */
  private async *trackSpoken(inner: AsyncGenerator<string>): AsyncGenerator<string> {
    let full = "";
    for await (const chunk of inner) {
      full += chunk;
      yield chunk;
    }
    const text = full.trim();
    if (text) {
      this.recordTranscript("outbound", text);
      this.publishEvent(CALLA_EVENTS.voiceTranscript, {
        callId: this.name,
        dir: "outbound",
        text,
      });
    }
  }

  /** Append one line to the brain's `voice:<callId>` thread (fire-and-forget). */
  private recordTranscript(dir: "inbound" | "outbound", text: string, kind?: string): void {
    const cfg = brainConfigFromEnv(this.env);
    if (!cfg || !text.trim()) return;
    void recordVoiceTranscript(cfg, this.name, {
      dir,
      text,
      ...(kind ? { kind } : {}),
    });
  }

  /** Best-effort publish of a frame to the CallaEventHub DO ("hub"). */
  private publishEvent(type: string, payload: Record<string, unknown>): void {
    try {
      const hub = this.env.CALLA_EVENTS.getByName("hub");
      void this.publishToHub(hub, callaFrame(
        type as (typeof CALLA_EVENTS)[keyof typeof CALLA_EVENTS],
        payload,
        { agentId: `voice:${this.name}` },
      ));
    } catch (err) {
      console.error("[calla-voice] event hub lookup failed:", err);
    }
  }

  private async publishToHub(
    hub: DurableObjectStub<CallaEventHub>,
    frame: ReturnType<typeof callaFrame>,
  ): Promise<void> {
    try {
      await hub.publish(frame);
    } catch (err) {
      console.error("[calla-voice] event publish failed:", err);
    }
  }

  /** Best-effort append to the hub's hash-chained audit trail. */
  private async appendAudit(kind: string, entry: Record<string, unknown>): Promise<void> {
    try {
      const hub = this.env.CALLA_EVENTS.getByName("hub");
      await hub.appendAudit({ agentId: `voice:${this.name}`, kind, entry });
    } catch (err) {
      console.error(`[calla-voice] audit append failed (${kind}):`, err);
    }
  }

  /** Drop potentially sensitive fields before they land in the audit log. */
  private scrubArgs(args: Record<string, unknown>): Record<string, unknown> {
    const { phone, email, ...rest } = args;
    return { ...rest };
  }
}
