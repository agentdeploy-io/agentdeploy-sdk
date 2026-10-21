/**
 * Calla edge worker environment.
 *
 * Bindings declared in wrangler.jsonc:
 *  - CALLA_EDGE_AGENT      → CallaEdgeAgent   (Durable Object, new_sqlite_classes)
 *  - CALLA_ORCHESTRATOR    → CallaOrchestrator (Durable Object, new_sqlite_classes)
 *  - CALLA_EVENTS          → CallaEventHub     (Durable Object, new_sqlite_classes)
 *  - CallaVoiceAgent       → CallaVoiceAgent   (voice DO, new_sqlite_classes v2;
 *                                               binding name = class name, required by the /telnyx/stream bridge)
 *  - CALLA_APPROVAL_WORKFLOW → CallaApprovalWorkflow (Workflow)
 *  - AI                    → Workers AI binding (voice STT/TTS; remote in dev,
 *                            needs CF auth — see .dev.vars.example)
 *
 * NOTE: the imports below are `import type` only, so this module has zero
 * runtime dependencies and cannot form an import cycle with the agents.
 */

import type { CallaEdgeAgent } from "./agents/edge-agent";
import type { CallaEventHub } from "./agents/event-hub";
import type { CallaOrchestrator } from "./agents/orchestrator";
import type { CallaVoiceAgent } from "./agents/voice-agent";

/**
 * Payload the CallaApprovalWorkflow is started with. Kept here (rather than in
 * the workflow module) so `Env` never needs a value import from `workflows/`.
 */
export interface ApprovalWorkflowParams {
  /** DO name of the edge agent that owns the gate (`this.name`). */
  agentName: string;
  /** The PendingApproval.id the workflow will expire if still pending. */
  approvalId: string;
  /** Approval window in ms; the workflow caps this at 24h. */
  timeoutMs: number;
}

export interface Env {
  // ── Durable Object namespaces ──────────────────────────────────────────────
  CALLA_EDGE_AGENT: DurableObjectNamespace<CallaEdgeAgent>;
  CALLA_ORCHESTRATOR: DurableObjectNamespace<CallaOrchestrator>;
  CALLA_EVENTS: DurableObjectNamespace<CallaEventHub>;
  CallaVoiceAgent: DurableObjectNamespace<CallaVoiceAgent>;

  // ── Workflow binding ───────────────────────────────────────────────────────
  // `Workflow<T>` is the ambient binding type from @cloudflare/workers-types.
  // Start a run with `.create({ id, params })`; the params become the workflow
  // `run(event, step)` payload (event.payload).
  CALLA_APPROVAL_WORKFLOW: Workflow<ApprovalWorkflowParams>;

  // ── Workers AI (voice STT/TTS — CallaVoiceAgent) ───────────────────────────
  // Bound via "ai": {} in wrangler.jsonc (emulated by `wrangler dev`).
  AI: Ai;

  // ── Vars / secrets ─────────────────────────────────────────────────────────
  /** Public base URL of this worker (used to build absolute callback links). */
  CALLA_EDGE_URL?: string;
  /**
   * Shared secret for /events (WS `?token=`) and /events/ingest (`x-calla-token`).
   * When unset (local dev) both routes are open.
   *
   * In self-hosted (standalone) deployments this is the SERVICE token used by
   * the jev classifier / brain relays to POST /events/ingest WITHOUT a user
   * JWT. It is distinct from CALLA_JWT_SECRET below.
   */
  EVENTS_AUTH_TOKEN?: string;
  /**
   * Shared HMAC secret for the brain-issued Calla user JWTs (HS256). Set this
   * to the SAME value as the brain's CALLA_JWT_SECRET so the worker can verify
   * user tokens on protected routes (/steps, /approvals, /state, /fleet,
   * /audit*, /events, /events/recent). When unset the worker does not require a
   * user JWT (local dev / marketplace-cookie deployments).
   */
  CALLA_JWT_SECRET?: string;
  /** Deployment environment label (e.g. "production" | "staging"). */
  ENVIRONMENT?: string;
  /** "true" in local dev (see .dev.vars) — enables /d/* data-plane stubs. */
  CALLA_DEV_STUBS?: string;

  // ── Voice LLM gateway (OpenAI-compatible; default Chutes + Mistral Nemo) ──
  // Same triple the brain uses (LLM_BASE_URL/LLM_API_KEY/LLM_MODEL) so a
  // deployment's LLM config is uniform across runtimes.
  LLM_BASE_URL?: string;
  LLM_API_KEY?: string;
  LLM_MODEL?: string;
  /** Voice TTS overrides (default @cf/deepgram/aura-2-en, speaker "luna"). */
  VOICE_TTS_MODEL?: string;
  VOICE_TTS_SPEAKER?: string;
  /**
   * TTS mode. "aura-2" (default) = Workers AI Aura-2 (real spoken egress;
   * billed per 1k characters against the account's Workers AI neuron quota).
   * "noop" = NoopTTS: no audio egress, zero neurons — for local E2E/stress
   * runs so testing doesn't burn the account quota.
   */
  VOICE_TTS_MODE?: "aura-2" | "noop";
  /**
   * STT provider mode. "flux" (default) = Workers AI Flux STT (real inbound
   * speech). "noop" = NoopSTT: no remote STT, caller input via text_message —
   * for local text-driven E2E / stress runs and as a fallback when the remote
   * Flux endpoint is unavailable (the SDK otherwise ends the call on
   * stt_startup_failed).
   */
  VOICE_STT_MODE?: "flux" | "noop";

  // ── Telnyx telephony (Workstream B1; EU/UK/IE coverage — Plivo is out) ──
  /**
   * Telnyx API key (Mission Control → API keys). Used for outbound Call
   * Control dials (escalation), the escalation <speak> and hangup actions.
   */
  TELNYX_API_KEY?: string;
  /**
   * Account Ed25519 PUBLIC key (base64, 32 bytes — Mission Control → API
   * keys → public key). Verifies every Telnyx webhook and the media-stream
   * WS upgrade (signed message `${timestamp}|${body|streamUrl}`; ±300 s
   * replay window). When unset, /telnyx/* refuses all traffic (503/401).
   */
  TELNYX_PUBLIC_KEY?: string;
  /**
   * Connection (Call Control App) id for outbound dials — the practice
   * connection the number is assigned to. See scripts/provision-telnyx.mjs.
   */
  TELNYX_CONNECTION_ID?: string;
  /**
   * Practice line (E.164, e.g. "+3531...") provisioned via
   * scripts/provision-telnyx.mjs; used as the `from` number of outbound
   * escalation dials.
   */
  TELNYX_DEFAULT_NUMBER?: string;
  /**
   * On-call destination for escalations (B2). The voice DO places an
   * outbound Telnyx dial to this number when a caller is escalated;
   * /telnyx/status speaks the alert on answer. E.164. When unset,
   * escalation still fires the event + audit (UI takeover).
   */
  TELNYX_ESCALATION_NUMBER?: string;
  /**
   * Shared secret appended to the /telnyx/stream URL (?token=…) and checked
   * on the WS upgrade — defense in depth on top of the Ed25519 signature.
   * Any random string (e.g. `openssl rand -hex 32`).
   */
  TELNYX_STREAM_TOKEN?: string;
  /** TTS voice for the spoken escalation alert (default Telnyx.Natural.abbie). */
  TELNYX_TTS_VOICE?: string;

  // ── Brain integration (Workstream B2) ─────────────────────────────────
  /**
   * Base URL of the Calla brain (e.g. "http://127.0.0.1:3001" in dev,
   * "https://brain.example.com" in prod). When unset the voice DO runs on
   * the builtin persona with no live tools (availability/booking disabled).
   */
  BRAIN_URL?: string;
  /**
   * Service token sent as `Authorization: Bearer` to the brain. Must equal
   * the brain's CALLA_TOKEN (the brain's static service-token auth path).
   */
  BRAIN_SERVICE_TOKEN?: string;
  /**
   * Booking rep (calendar owner) the voice line books into by default.
   * When unset the DO uses the first enabled rep from the brain.
   */
  VOICE_BOOKING_REP_ID?: string;
  /**
   * Voice booking approval policy (B2): "always" (every booking gated),
   * "risky" (default — new patient / reschedule / cancel / outside hours),
   * "never" (direct brain call).
   */
  VOICE_BOOKING_APPROVAL?: string;
}
