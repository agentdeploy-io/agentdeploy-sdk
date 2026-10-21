/**
 * brain-client — the edge → brain REST surface (Workstream B2).
 * ─────────────────────────────────────────────────────────────────
 * Thin fetch helpers for the voice DO (and the edge-agent's post-approval
 * booking dispatch) to reach the Calla brain:
 *
 *   - persona:      GET /agents/configs + GET /skills?agentId=
 *   - conversations: POST /conversations/:id/transcript
 *   - booking:      GET /booking/reps, GET /booking/availability,
 *                   POST /booking/appointments
 *
 * Auth: `Authorization: Bearer BRAIN_SERVICE_TOKEN` — the brain's static
 * service-token path (its CALLA_TOKEN). No token (local dev) → no header,
 * matching the brain's "open when CALLA_TOKEN is unset" behavior.
 *
 * Every helper is best-effort shaped: callers get a typed result or a
 * `{ ok: false, status, error }` — never an unhandled throw.
 */
import type { Env } from "../env";

export interface BrainConfig {
  url: string;
  token?: string;
}

export interface BrainError {
  ok: false;
  status: number;
  error: string;
}

export function brainConfigFromEnv(env: Env): BrainConfig | null {
  const url = env.BRAIN_URL?.trim();
  if (!url) return null;
  const token = env.BRAIN_SERVICE_TOKEN?.trim();
  return { url: url.replace(/\/+$/, ""), ...(token ? { token } : {}) };
}

export async function brainFetch(
  cfg: BrainConfig,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (cfg.token) headers.set("Authorization", `Bearer ${cfg.token}`);
  headers.set("Content-Type", "application/json");
  return fetch(`${cfg.url}${path}`, { ...init, headers });
}

async function parseError(res: Response): Promise<BrainError> {
  let error = `brain ${res.status}`;
  try {
    const body = (await res.json()) as { error?: unknown; details?: unknown };
    if (typeof body.error === "string") error = body.error;
    else if (body.details) error = JSON.stringify(body.details).slice(0, 200);
  } catch {
    // non-JSON error body — keep the status line
  }
  return { ok: false, status: res.status, error };
}

// ── Persona (agent config + skills) ─────────────────────────────────

export interface BrainAgentConfigRow {
  agentId: string;
  name: string;
  description?: string | null;
  instructions: string;
  version?: number;
  source?: string;
  enabled?: boolean;
}

export interface BrainSkillRow {
  agentId: string;
  name: string;
  description: string;
  instructions: string;
  /** e.g. { "frontmatter.json": "<json>" } when the skill has frontmatter. */
  references: Record<string, string> | null;
  source?: string;
}

export type AgentPersonaResult =
  | { ok: true; config: BrainAgentConfigRow; skills: BrainSkillRow[] }
  | BrainError;

export async function getAgentPersona(
  cfg: BrainConfig,
  agentId: string,
): Promise<AgentPersonaResult> {
  try {
    const [configsRes, skillsRes] = await Promise.all([
      brainFetch(cfg, "/agents/configs"),
      brainFetch(cfg, `/skills?agentId=${encodeURIComponent(agentId)}`),
    ]);
    if (!configsRes.ok) return await parseError(configsRes);
    if (!skillsRes.ok) return await parseError(skillsRes);
    const configsBody = (await configsRes.json()) as {
      configs?: BrainAgentConfigRow[];
    };
    const skillsBody = (await skillsRes.json()) as { skills?: BrainSkillRow[] };
    const config = (configsBody.configs ?? []).find(
      (c) => c.agentId === agentId,
    );
    if (!config) {
      return { ok: false, status: 404, error: `agent config not found: ${agentId}` };
    }
    return { ok: true, config, skills: skillsBody.skills ?? [] };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Conversations (voice thread transcript) ─────────────────────────

export type TranscriptDir = "inbound" | "outbound";

/**
 * Append one transcript line to the `voice:<callId>` thread. Fire-and-forget
 * safe: never throws; failures are logged by the caller (or silently dropped).
 */
export async function recordVoiceTranscript(
  cfg: BrainConfig,
  callId: string,
  input: { dir: TranscriptDir; text: string; kind?: string; phone?: string },
): Promise<void> {
  const id = `voice:${encodeURIComponent(callId)}`;
  try {
    const res = await brainFetch(cfg, `/conversations/${id}/transcript`, {
      method: "POST",
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      console.warn(`[calla-voice] transcript record ${res.status}: ${detail.slice(0, 160)}`);
    }
  } catch (err) {
    console.warn("[calla-voice] transcript record failed:", err);
  }
}

// ── Booking ─────────────────────────────────────────────────────────

export interface BrainRepRow {
  repId: string;
  name: string;
  provider: string;
  enabled: boolean;
}

export type BookingRepsResult =
  | { ok: true; reps: BrainRepRow[] }
  | BrainError;

export async function listBookingReps(cfg: BrainConfig): Promise<BookingRepsResult> {
  try {
    const res = await brainFetch(cfg, "/booking/reps");
    if (!res.ok) return await parseError(res);
    const body = (await res.json()) as { reps?: BrainRepRow[] };
    return { ok: true, reps: body.reps ?? [] };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface AvailabilitySlot {
  start: string;
  end?: string;
}

export type AvailabilityResult =
  | { ok: true; kind: "slots"; slots: AvailabilitySlot[] }
  | { ok: true; kind: "link"; link: string }
  | BrainError;

export async function getBookingAvailability(
  cfg: BrainConfig,
  repId: string,
  fromMs: number,
  toMs: number,
): Promise<AvailabilityResult> {
  try {
    const qs = new URLSearchParams({
      repId,
      from: new Date(fromMs).toISOString(),
      to: new Date(toMs).toISOString(),
    });
    const res = await brainFetch(cfg, `/booking/availability?${qs.toString()}`);
    if (!res.ok) return await parseError(res);
    const body = (await res.json()) as {
      slots?: AvailabilitySlot[];
      link?: string;
      provider?: string;
    };
    if (body.link) return { ok: true, kind: "link", link: body.link };
    return { ok: true, kind: "slots", slots: body.slots ?? [] };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

export interface BookingAppointmentInput {
  repId: string;
  start: string;
  end?: string;
  attendee: { name: string; email?: string; phone?: string };
  context?: { leadKey?: string; notes?: string };
}

export type BookingAppointmentResult =
  | { ok: true; kind: "booked"; appointmentId: string | null; raw: Record<string, unknown> }
  | { ok: true; kind: "handoff"; link: string | null }
  | BrainError;

export async function bookAppointment(
  cfg: BrainConfig,
  input: BookingAppointmentInput,
): Promise<BookingAppointmentResult> {
  try {
    const res = await brainFetch(cfg, "/booking/appointments", {
      method: "POST",
      body: JSON.stringify(input),
    });
    const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (res.ok) {
      const appointmentId =
        typeof raw.appointmentId === "string"
          ? raw.appointmentId
          : typeof raw.id === "string"
            ? raw.id
            : null;
      return { ok: true, kind: "booked", appointmentId, raw };
    }
    // Calendly hand-off: the brain answers 400 + scheduling link — there is
    // no server-side event to create, the link IS the booking surface.
    if (res.status === 400 && typeof raw.link === "string") {
      return { ok: true, kind: "handoff", link: raw.link };
    }
    let error = `brain ${res.status}`;
    if (typeof raw.error === "string") error = raw.error;
    else if (raw.details) error = JSON.stringify(raw.details).slice(0, 200);
    return { ok: false, status: res.status, error };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  }
}
