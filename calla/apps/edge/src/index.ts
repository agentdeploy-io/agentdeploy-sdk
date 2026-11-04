import { routeAgentRequest } from "agents";
import {
  CALLA_EVENTS,
  approvalDecisionSchema,
  callaStepSchema,
  type CallaStep,
  type CallaWsFrame,
} from "@calla/shared";
import { authorizeRequest } from "./auth";
import { CallaEdgeAgent } from "./agents/edge-agent";
import { CallaVoiceAgent } from "./agents/voice-agent";
import {
  CallaEventHub,
  type AuditKind,
  type AuditRow,
  type AuditVerifyResult,
} from "./agents/event-hub";
import { CallaOrchestrator } from "./agents/orchestrator";
import { CallaApprovalWorkflow } from "./workflows/approval-workflow";
import {
  handleTelnyxStream,
  parseTelnyxStatusEvent,
  telnyxAnswerTeXml,
  telnyxHangup,
  telnyxSpeak,
  telnyxSignatureHeaders,
  verifyTelnyxSignature,
} from "./telnyx";
import type { Env } from "./env";

// Durable Object classes and the Workflow class MUST be named exports so
// workerd can resolve them by `class_name` in wrangler.jsonc. They are also
// mirrored onto the default export below for convenience.
export { CallaEdgeAgent, CallaEventHub, CallaOrchestrator, CallaVoiceAgent, CallaApprovalWorkflow };

// ── CORS ────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization, x-calla-token",
  "Access-Control-Max-Age": "86400",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

/** Add CORS headers to a non-WebSocket response (leave 101 upgrades untouched). */
function withCors(response: Response): Response {
  if (response.status === 101 || response.webSocket) return response;
  const next = new Response(response.body, response);
  for (const [k, v] of Object.entries(CORS_HEADERS)) next.headers.set(k, v);
  return next;
}

// ── Auth ────────────────────────────────────────────────────────────────────

/**
 * SERVICE-token gate for /events/ingest ONLY. When EVENTS_AUTH_TOKEN is set,
 * require it via `x-calla-token` header or `?token=` query (WebSockets can't
 * set headers); open when unset. Machine relays (jev classifier / brain) use
 * this so they can emit events without a user JWT. User-facing routes use
 * `requireUser` → `authorizeRequest` (see ./auth.ts), which enforces the
 * CALLA_JWT_SECRET user JWT.
 */
function serviceAuthorized(request: Request, env: Env): boolean {
  const expected = env.EVENTS_AUTH_TOKEN;
  if (!expected) return true;
  const url = new URL(request.url);
  const provided =
    request.headers.get("x-calla-token") ?? url.searchParams.get("token");
  return provided === expected;
}

/**
 * USER-route gate: returns null when authorized, else a 401 JSON response
 * (CORS included). Enforces the brain-issued Calla JWT whenever
 * CALLA_JWT_SECRET is configured; open otherwise (local dev).
 */
async function requireUser(request: Request, env: Env): Promise<Response | null> {
  const auth = await authorizeRequest(request, env);
  return auth.ok ? null : json({ error: "unauthorized" }, 401);
}

async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return undefined;
  }
}

/** Query-string integer → clamped value (falls back to `fallback`). */
function clampInt(
  raw: string | null,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = raw === null ? NaN : parseInt(raw, 10);
  const value = Number.isFinite(parsed) ? parsed : fallback;
  return Math.min(Math.max(value, min), max);
}

// ── Telnyx (dental voice telephony, Workstream B1) ──────────────────────────
// Telnyx serves EU/UK/IE (Plivo does not). Inbound: TeXML answer URL →
// <Stream> into the CallaVoiceAgent DO. Escalation: outbound Call Control
// dial + dynamic <speak> on answer (see /telnyx/status).

/** Recording-consent line spoken before the audio stream opens (plan §2.6). */
const TELNYX_CONSENT_LINE =
  "This call may be recorded for quality and safety purposes. You are now " +
  "speaking with an AI assistant at our practice.";

// ── Route table (served at GET /) ───────────────────────────────────────────

const ROUTES = [
  "GET  /health",
  "GET  /                         (this index)",
  "GET  /events                   (WebSocket event bus; ?token= when secured, ?since=<id> for cursor replay)",
  "GET  /events/recent?limit=50&since=<id>  (ring-buffer tail / cursor gap-fill as JSON)",
  "POST /events/ingest            (x-calla-token; {type, agentId?, payload})",
  "GET  /audit?limit=100&agentId=&kind=  (hash-chained audit trail)",
  "GET  /audit/verify             (recompute the audit hash chain)",
  "GET  /fleet                    (orchestrator roster)",
  "POST /steps/:agentName         (CallaStep body → StepResult)",
  "GET  /state/:agentName         (CallaState for one edge agent)",
  "POST /approvals/:agentName/:approvalId/decision  ({approved, updatedArgs?})",
  "POST /voice/:callId/escalate     (transfer live call to human; {reason?})",
  "GET  /telnyx/inbound             (TeXML answer URL → consent + /telnyx/stream; Ed25519-verified)",
  "WS   /telnyx/stream              (Telnyx media-stream WebSocket → CallaVoiceAgent DO; Ed25519 + token)",
  "POST /telnyx/status              (call status callback; Ed25519; escalation speak+hangup orchestration)",
  "ANY  /agents/:binding/:name     (Agents SDK WS/RPC protocol)",
];

/** Minimal structural view of the hub stub used by the audit helper below. */
interface AuditSink {
  appendAudit(input: {
    agentId?: string | null;
    kind: string;
    entry: Record<string, unknown>;
  }): Promise<unknown> | unknown;
}

/**
 * Best-effort audit append. The audit trail must never fail the operation it is
 * describing, so every write is fire-and-log.
 */
async function audit(
  hub: AuditSink,
  kind: AuditKind,
  entry: Record<string, unknown>,
  agentId?: string,
): Promise<void> {
  try {
    await hub.appendAudit({ agentId, kind, entry });
  } catch (err) {
    console.error(`[calla] audit append failed (${kind}):`, err);
  }
}

// ── Worker ──────────────────────────────────────────────────────────────────

async function fetch(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  // CORS preflight for everything.
  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    // ── health ────────────────────────────────────────────────────────────
    if (pathname === "/health" && method === "GET") {
      return json({ ok: true, service: "calla-edge", ts: Date.now() });
    }

    // Dev-compat: the ported UI health probes use the playground's
    // /health/{port} path scheme in local dev — answer any /health/* alike.
    if (pathname.startsWith("/health/") && method === "GET") {
      return json({ ok: true, service: "calla-edge", ts: Date.now() });
    }

    // ── route index ───────────────────────────────────────────────────────
    if (pathname === "/" && method === "GET") {
      return json({
        ok: true,
        service: "calla-edge",
        environment: env.ENVIRONMENT ?? "development",
        eventsAuth: env.EVENTS_AUTH_TOKEN ? "required" : "open",
        userAuth: env.CALLA_JWT_SECRET ? "jwt" : "open",
        routes: ROUTES,
        ts: Date.now(),
      });
    }

    // ── event bus: WebSocket upgrade ──────────────────────────────────────
    if (pathname === "/events" && method === "GET") {
      const isUpgrade =
        request.headers.get("Upgrade")?.toLowerCase() === "websocket";
      // Upgrades are handed to the hub even with a bad token so the client gets
      // an actionable `4001` close frame (a 401 JSON body is invisible to a
      // browser WebSocket). The hub's authorized() accepts a user JWT
      // (CALLA_JWT_SECRET) or the service token (EVENTS_AUTH_TOKEN). Plain HTTP
      // requests keep the 401 JSON path here.
      if (!isUpgrade) {
        const denied = await requireUser(request, env);
        if (denied) return denied;
      }
      const hub = env.CALLA_EVENTS.getByName("hub");
      return withCors(await hub.fetch(request));
    }

    // ── event bus: recent frames (JSON) ───────────────────────────────────
    // `?since=<id>` switches from "last N" to cursor gap-fill (id > since).
    if (pathname === "/events/recent" && method === "GET") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const limit = clampInt(url.searchParams.get("limit"), 50, 1, 500);
      const since = url.searchParams.get("since") ?? undefined;
      const hub = env.CALLA_EVENTS.getByName("hub");
      // DO RPC stub typing collapses returns that aren't `Serializable`
      // (CallaWsFrame carries `payload?: unknown`) to `never`; the wire value is
      // the plain object, so restore the real types at the call site.
      const frames = (await (since
        ? hub.recentSince(since, limit)
        : hub.recent(limit))) as CallaWsFrame[];
      return json({ frames, since: since ?? null, count: frames.length });
    }

    // ── event bus: ingest (external emitters e.g. jev classifier) ─────────
    if (pathname === "/events/ingest" && method === "POST") {
      if (!serviceAuthorized(request, env)) return json({ error: "unauthorized" }, 401);
      const body = (await readJson(request)) as
        | { type?: unknown; agentId?: unknown; payload?: unknown }
        | undefined;
      if (!body || typeof body.type !== "string") {
        return json({ error: "body.type (string) is required" }, 400);
      }
      const frame: CallaWsFrame = {
        type: body.type as CallaWsFrame["type"],
        agentId: typeof body.agentId === "string" ? body.agentId : undefined,
        payload: body.payload,
        ts: Date.now(),
      };
      const hub = env.CALLA_EVENTS.getByName("hub");
      const published = (await hub.publish(frame)) as CallaWsFrame;
      await audit(
        hub,
        "event.ingested",
        { type: published.type, frameId: published.id },
        frame.agentId,
      );
      return json({
        ok: true,
        id: published.id,
        type: published.type,
        ts: published.ts,
      });
    }

    // ── audit trail (hash-chained, lives in the event hub DO) ─────────────
    if (pathname === "/audit" && method === "GET") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const limit = clampInt(url.searchParams.get("limit"), 100, 1, 1000);
      const agentId = url.searchParams.get("agentId") ?? undefined;
      const kind = url.searchParams.get("kind") ?? undefined;
      const hub = env.CALLA_EVENTS.getByName("hub");
      const entries = (await hub.getAudit({ limit, agentId, kind })) as AuditRow[];
      return json({ entries, count: entries.length });
    }

    if (pathname === "/audit/verify" && method === "GET") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const hub = env.CALLA_EVENTS.getByName("hub");
      return json((await hub.verifyAudit()) as AuditVerifyResult);
    }

    // ── fleet roster ──────────────────────────────────────────────────────
    if (pathname === "/fleet" && method === "GET") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const orchestrator = env.CALLA_ORCHESTRATOR.getByName("fleet");
      return json({ agents: await orchestrator.listFleet() });
    }

    // ── execute a step on an edge agent ───────────────────────────────────
    const stepsMatch = pathname.match(/^\/steps\/([^/]+)$/);
    if (stepsMatch && method === "POST") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const agentName = decodeURIComponent(stepsMatch[1]);
      const body = await readJson(request);
      const parsed = callaStepSchema.safeParse(body);
      if (!parsed.success) {
        return json(
          { error: "invalid CallaStep", issues: parsed.error.issues },
          400,
        );
      }
      const step: CallaStep = parsed.data;
      const agent = env.CALLA_EDGE_AGENT.getByName(agentName);
      return json(await agent.executeStep(step));
    }

    // ── read one edge agent's state ───────────────────────────────────────
    const stateMatch = pathname.match(/^\/state\/([^/]+)$/);
    if (stateMatch && method === "GET") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const agentName = decodeURIComponent(stateMatch[1]);
      const agent = env.CALLA_EDGE_AGENT.getByName(agentName);
      return json({ agentName, state: await agent.getState() });
    }

    // ── HTTP convenience: decide an approval ──────────────────────────────
    const decisionMatch = pathname.match(
      /^\/approvals\/([^/]+)\/([^/]+)\/decision$/,
    );
    if (decisionMatch && method === "POST") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const agentName = decodeURIComponent(decisionMatch[1]);
      const approvalId = decodeURIComponent(decisionMatch[2]);
      const body = await readJson(request);
      const parsed = approvalDecisionSchema.safeParse(body);
      if (!parsed.success) {
        return json(
          { error: "invalid ApprovalDecision", issues: parsed.error.issues },
          400,
        );
      }
      const agent = env.CALLA_EDGE_AGENT.getByName(agentName);
      const result = parsed.data.approved
        ? await agent.approvePendingAction({
            approvalId,
            updatedArgs: parsed.data.updatedArgs,
          })
        : await agent.declinePendingAction({ approvalId });
      // Never mask a no-op as success: an unknown/stale approvalId means the
      // decision did NOT change anything — the UI must roll back + toast.
      if (result.status === "failed") {
        return json(
          { error: result.error ?? "decision_failed", detail: "approval not found on this agent" },
          result.error === "unknown_approval" ? 404 : 409,
        );
      }
      if (result.status === "expired") {
        return json({ error: "approval_expired", detail: "this gate already expired" }, 409);
      }
      return json(result);
    }

    // ── Transfer a live voice call to a human (B3) ─────────────────────────
    // The Calls UI's "Transfer to human" button. DO RPC into the
    // CallaVoiceAgent instance named by the Telnyx stream id — runs the
    // same deterministic escalation as triage (audit + event + Telnyx
    // outbound dial), source "operator".
    const voiceEscalateMatch = pathname.match(/^\/voice\/([^/]+)\/escalate$/);
    if (voiceEscalateMatch && method === "POST") {
      const denied = await requireUser(request, env);
      if (denied) return denied;
      const callId = decodeURIComponent(voiceEscalateMatch[1]);
      const body = (await readJson(request)) as { reason?: unknown } | undefined;
      const reason =
        body && typeof body.reason === "string" && body.reason.trim()
          ? body.reason.trim().slice(0, 200)
          : undefined;
      const voice = env.CallaVoiceAgent.getByName(callId);
      const result = await voice.escalate(reason ? { reason } : {});
      return json(result);
    }

    // ── Dev data-plane stubs (/d/:id/cmd/*) ────────────────────────────────
    // In local dev there is no buyer BI agent behind the console proxy, so the
    // data-plane hooks (leads/pipeline/schedules/wire/settings/secrets) would
    // 404-spam. Serve honest empty payloads. Enabled only when
    // CALLA_DEV_STUBS=true (set in apps/edge/.dev.vars for `wrangler dev`;
    // never set in deployed environments).
    const cmdMatch = pathname.match(/^\/d\/([^/]+)\/(.*)$/);
    if (cmdMatch && env.CALLA_DEV_STUBS === "true") {
      const rest = `/${cmdMatch[2]}`;
      if (rest === "/health" && method === "GET") {
        return json({ ok: true, service: "calla-edge-dev", ts: Date.now() });
      }
      if (rest.startsWith("/cmd/data") && method === "GET") {
        if (rest.includes("/export")) return json({ rows: [] });
        return json({ rows: [], total: 0 });
      }
      if (rest.startsWith("/cmd/data") && method === "POST") {
        return json({ ok: true, devStub: true });
      }
      if (rest === "/cmd/pipeline" && method === "GET") {
        return json({
          data: { stages: [] },
          status: { nextRun: null, lastRun: null, cronExpression: null, lastFailure: null },
        });
      }
      if (rest.startsWith("/cmd/runs") && method === "GET") {
        return json({ runs: [] });
      }
      if (rest.startsWith("/cmd/schedules") && method === "GET") {
        return json({ schedules: [] });
      }
      if (rest.startsWith("/cmd/wire") && method === "GET") {
        return json({ agents: [], connections: [], events: [] });
      }
      if (rest.startsWith("/cmd/settings") && method === "GET") {
        return json({});
      }
      if (rest.startsWith("/cmd/secrets") && method === "GET") {
        return json({ secrets: [] });
      }
      if (rest.startsWith("/cmd/") && method === "POST") {
        // Generic slash-command RPCs (e.g. /cmd/pending, /cmd/approve-batch)
        return json({ ok: true, devStub: true, pending: [], count: 0 });
      }
    }

    // ── Telnyx: Answer URL (TeXML → consent Say + media stream) ───────────
    // Fetched by Telnyx on every inbound call to a number assigned to our
    // TeXML application. Signed like every Telnyx webhook (Ed25519 over
    // `${timestamp}|` — GET, empty body); never answer on a bad signature.
    if (pathname === "/telnyx/inbound" && method === "GET") {
      const publicKey = env.TELNYX_PUBLIC_KEY;
      if (!publicKey) {
        return json(
          { error: "telnyx public key not configured", hint: "set TELNYX_PUBLIC_KEY" },
          503,
        );
      }
      const { signature, timestamp } = telnyxSignatureHeaders(request);
      if (
        !(await verifyTelnyxSignature(
          { signature, timestamp },
          `${timestamp ?? ""}|`,
          publicKey,
        ))
      ) {
        return json({ error: "invalid telnyx signature" }, 401);
      }
      return new Response(
        telnyxAnswerTeXml(request, TELNYX_CONSENT_LINE, env.TELNYX_STREAM_TOKEN),
        { headers: { "Content-Type": "application/xml" } },
      );
    }

    // ── Telnyx: bidirectional media stream (WebSocket) ────────────────────
    // Telnyx upgrades to this URL from the <Stream> verb above (L16 16 kHz
    // RTP, bidirectional). The bridge wires it into the CallaVoiceAgent DO —
    // one instance per Telnyx stream_id. Ed25519 over the exact stream URL
    // plus the shared stream token.
    if (pathname === "/telnyx/stream" && method === "GET") {
      return handleTelnyxStream(request, env);
    }

    // ── Telnyx: status callback (Ed25519 over the exact raw body) ─────────
    // Two shapes: form-encoded (TeXML status_callback: CallSid/CallStatus/…)
    // and the v2 JSON envelope (per-call webhook_url override on escalation
    // dials). The DO's own frames remain the source of truth for the live
    // Calls UI; this route (a) audits every verified callback and (b)
    // orchestrates the escalation alert — when the outbound escalation call
    // answers, it speaks the dynamic notice and hangs up (nonce-deduped).
    if (pathname === "/telnyx/status" && method === "POST") {
      const publicKey = env.TELNYX_PUBLIC_KEY;
      if (!publicKey) {
        return json(
          { error: "telnyx public key not configured", hint: "set TELNYX_PUBLIC_KEY" },
          503,
        );
      }
      const body = await request.text();
      const { signature, timestamp } = telnyxSignatureHeaders(request);
      if (
        !(await verifyTelnyxSignature(
          { signature, timestamp },
          `${timestamp ?? ""}|${body}`,
          publicKey,
        ))
      ) {
        return json({ error: "invalid telnyx signature" }, 401);
      }
      const event = parseTelnyxStatusEvent(body);
      if (!event) return json({ ok: true, ignored: "unrecognized shape" });

      const hub = env.CALLA_EVENTS.getByName("hub");
      await audit(
        hub,
        "event.ingested",
        { telnyx: event.status, callControlId: event.callControlId ?? undefined },
        event.callControlId ?? undefined,
      );

      const state = event.clientState;
      if (
        state?.source === "calla-escalation" &&
        event.callControlId &&
        (event.status === "answered" || event.status === "in-progress")
      ) {
        // First (and only) speak+hangup for this escalation dial.
        if (await hub.checkPlivoNonce(`telnyx-esc:${event.callControlId}`)) {
          const reason =
            typeof state.reason === "string" && state.reason ? state.reason : "unspecified";
          const callId =
            typeof state.callId === "string" && state.callId ? state.callId : "unknown";
          const say = await telnyxSpeak(
            env,
            event.callControlId,
            `Urgent voice call escalated. Call id ${callId}. Reason: ${reason}. ` +
              "Call the caller back as soon as possible.",
          );
          if (say.ok) {
            await telnyxHangup(env, event.callControlId);
            await audit(
              hub,
              "telnyx.escalation_alerted",
              { callControlId: event.callControlId, callId, reason },
              event.callControlId,
            );
          } else {
            console.error("[telnyx] escalation speak failed:", say.error);
          }
        }
      }
      return json({ ok: true });
    }

    // ── Agents SDK protocol (WebSocket + HTTP RPC/state) ──────────────────
    if (pathname === "/agents" || pathname.startsWith("/agents/")) {
      const res = await routeAgentRequest(request, env, { cors: true });
      if (res) return res;
      return json({ error: "agent route not matched", path: pathname }, 404);
    }

    // ── fallback ──────────────────────────────────────────────────────────
    return json(
      { error: "not found", path: pathname, hint: "GET / for the route index" },
      404,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[calla] fetch error:", err);
    return json({ error: "internal_error", detail: message }, 500);
  }
}

export default {
  fetch,
  CallaEdgeAgent,
  CallaOrchestrator,
  CallaEventHub,
  CallaApprovalWorkflow,
};
