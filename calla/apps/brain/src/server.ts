/**
 * Calla brain — Hono HTTP server over the Mastra instance (spec §3.2).
 *
 * REST contract (consumed by apps/ui/src/lib/mastra-client.ts):
 *   GET  /health
 *   GET  /
 *   POST /agents/:agentId/generate
 *   POST /agents/:agentId/stream                      → application/x-ndjson
 *   GET  /agents/:agentId/suspended-runs
 *   POST /agents/:agentId/approve-tool-call
 *   POST /agents/:agentId/decline-tool-call
 *
 * Durable Calla store routes (calla_* tables, separate from Mastra storage):
 *   GET  /audit          hash-chained audit log (limit/agentId/kind filters)
 *   GET  /audit/verify   recompute the chain → { valid, count, brokenAt? }
 *   GET  /approvals      approval history across sources (status/limit)
 *   GET  /agents         agent registry (read-only for now)
 *
 * Skills & dynamic agent configs (multi-tenant behavior, hot-swappable):
 *   GET    /skills?agentId=            list skill rows (all agents when unfiltered)
 *   POST   /skills/:agentId            create an uploaded skill
 *   PUT    /skills/:agentId/:name      upsert (version bump; builtins editable)
 *   DELETE /skills/:agentId/:name      delete uploaded skills (builtins → 400)
 *   GET    /agents/configs             list agent config rows
 *   POST   /agents/configs             create + dynamically register an agent
 *   PUT    /agents/configs/:agentId    update persona/instructions/model/enabled
 *   GET    /agents/:agentId/skills     resolved skills view (agent.listSkills)
 *
 * Self-hosted (standalone) auth routes — the brain issues its own HS256 JWTs:
 *   GET  /auth/status    { mode, initialized }
 *   POST /auth/register  one-shot admin bootstrap (only while no users exist)
 *   POST /auth/login     { email, password } → { token, user }
 *   GET  /auth/me        Bearer → verified claims
 *   POST /auth/logout    best-effort audit row
 *
 * Appointment booking (Google Calendar / Microsoft 365 / Calendly, Ireland —
 * Europe/Dublin defaults): see src/booking/routes.ts. Mounted at /booking:
 * status, reps CRUD, policy, OAuth connect (start/callback), calendly link,
 * availability (slot finder), appointments (create/list/cancel), and
 * self-verifying webhooks (/booking/webhook/{calendly,google,microsoft}).
 *
 * Qualification flows & routing (Flowly-style, Irish retrofit + property
 * verticals): see src/flows/**. Mounted at /flows: definitions (builtins
 * code-versioned + custom CRUD), runs (start/answer/cancel/book) and
 * routing rules. The social channel hands inbound DMs to the runner
 * (trigger action "flow" + active-run takeover).
 *
 * Conversation threads (operator console): see src/conversations/**. Mounted
 * at /conversations (bearer-protected): every social/WhatsApp customer
 * conversation the engine records — list + detail (messages, lead, flow run),
 * a MANUAL operator reply through the platform sender, per-thread takeover
 * (pause automation, keep capturing) and the GDPR deletion path.
 *
 * Meta Lead Forms + embeddable website form (WAVE-2): Facebook/Instagram
 * Lead-Ads webhooks at GET|POST /channels/facebook/webhook (see
 * src/channels/facebook.ts) and the PUBLIC website-form surface at
 * /forms/widget.js, /forms/definition, /forms/ingest (see
 * src/forms/widget.ts) — both feed the same qualification-flow runner
 * (channels "leadform" / "form").
 *
 * Deployment config (per-deployment module feature flags): see
 * src/config/routes.ts. Mounted at /config: GET/PUT /config/modules
 * (singleton calla_deployment_config row; `modules: null` = all enabled)
 * and GET /config/modules/presets (dental / retrofit / property).
 * Seeded at boot from CALLA_MODULE_PRESET when the row was never written.
 *
 * Auth: when CALLA_TOKEN and/or CALLA_JWT_SECRET is set, every route except
 * /health, / and /auth/* requires `Authorization: Bearer <CALLA_TOKEN | JWT>`
 * (a static CALLA_TOKEN OR a Calla JWT signed with CALLA_JWT_SECRET is
 * accepted). When neither is set the server is open (local dev).
 */
import { Hono } from "hono";
import { cors } from "hono/cors";
import { serve } from "@hono/node-server";
import { z } from "zod";
import type { MessageListInput } from "@mastra/core/agent/message-list";
import {
  MODULE_PRESETS,
  SKILL_NAME_RE,
  resolveModuleSet,
  verifyCallaToken,
  type ApprovalStatus,
} from "@calla/shared";
import { mastra, storageKind } from "./mastra/index.js";
import { DEFAULT_APPROVAL_WINDOW_MS } from "./mastra/workflows/approval-with-escalation.js";
import { describeLlmConfig } from "./mastra/agents/orchestrator.js";
import {
  invalidate as invalidateDynamicAgent,
  listDynamicAgentIds,
  resolveDynamicAgent,
} from "./mastra/dynamic-agents.js";
import { BUILTIN_AGENT_IDS, seedBuiltins } from "./mastra/skills/seed.js";
import { createNdjsonStream, type StreamObserver, type StreamSummary } from "./lib/stream-ndjson.js";
import {
  errorMessage,
  flattenSuspendedRuns,
  serializeFullOutput,
} from "./lib/serialize.js";
import { getCallaStore, initCallaStore } from "./store/index.js";
import { createAuthApp } from "./auth/routes.js";
import { createChannelsApp, startChannels, stopChannels } from "./channels/app.js";
import { buildChannelsDeps } from "./channels/config.js";
import { createBookingApp } from "./booking/routes.js";
import { handleBookingMcpRequest } from "./booking/mcp-server.js";
import { createFlowsApp, seedFlows } from "./flows/routes.js";
import { createConversationsApp } from "./conversations/routes.js";
import { createFormsApp } from "./forms/widget.js";
import { createConfigApp } from "./config/routes.js";
import {
  fireRunEvaluators,
  normalizeInputMessages,
  recordApprovalDecision,
  recordPendingApproval,
  recordSuspendedFromOutput,
  withStore,
} from "./lib/store-hooks.js";

// ─── Request schemas ─────────────────────────────────────────────

const chatMessageSchema = z.object({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system", "tool"]),
  content: z.union([z.string(), z.array(z.unknown())]),
});

const executionRequestSchema = z.object({
  messages: z.union([z.string(), z.array(chatMessageSchema).min(1)]),
  threadId: z.string().optional(),
  resourceId: z.string().optional(),
});

const approveRequestSchema = z.object({
  runId: z.string().min(1),
  toolCallId: z.string().optional(),
  /**
   * Accepted for UI contract compatibility ("Edit & Approve"). NOTE: Mastra
   * 1.74's approveToolCall resumes with the model's original args — edited
   * args are logged and ignored (see README).
   */
  updatedArgs: z.record(z.string(), z.unknown()).optional(),
});

const declineRequestSchema = z.object({
  runId: z.string().min(1),
  toolCallId: z.string().optional(),
  reason: z.string().optional(),
});

// Skills & agent configs — limits follow Mastra's skill metadata rules
// (name: SKILL_NAME_RE ≤64; description: 1-1024 chars).
const SKILL_NAME_MAX = 64;
const SKILL_DESCRIPTION_MAX = 1024;

const createSkillSchema = z.object({
  name: z.string().min(1).max(SKILL_NAME_MAX),
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX),
  instructions: z.string().min(1),
  references: z.record(z.string(), z.string()).optional(),
});

const updateSkillSchema = z.object({
  description: z.string().min(1).max(SKILL_DESCRIPTION_MAX).optional(),
  instructions: z.string().min(1),
  references: z.record(z.string(), z.string()).optional(),
});

const createAgentConfigSchema = z.object({
  agentId: z.string().min(1).max(SKILL_NAME_MAX),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  instructions: z.string().min(1),
  model: z.string().min(1).max(200).optional(),
});

const updateAgentConfigSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(500).nullish(),
  instructions: z.string().min(1).optional(),
  model: z.string().min(1).max(200).nullish(),
  enabled: z.boolean().optional(),
});

// ─── Helpers ─────────────────────────────────────────────────────

type AnyAgent = (typeof mastra extends { listAgents(): infer T } ? T[keyof T] : never) & {
  id: string;
  name: string;
};

/**
 * Resolve an agent from the STATIC mastra registry: by registration key
 * ("orchestratorAgent"), by id/name ("calla-orchestrator"), or by the UI's
 * short id ("orchestrator").
 */
function resolveStaticAgent(agentId: string): AnyAgent | undefined {
  const agents = mastra.listAgents() as Record<string, AnyAgent>;
  const direct = agents[agentId];
  if (direct) return direct;

  const entries = Object.entries(agents);
  const exact = entries.find(([, a]) => a.id === agentId || a.name === agentId);
  if (exact) return exact[1];

  const norm = (s: string) => s.toLowerCase().replace(/[-_\s]/g, "");
  const target = norm(agentId);
  if (!target) return undefined;
  const fuzzy = entries.find(([key, a]) => {
    const nKey = norm(key);
    const nId = norm(a.id ?? "");
    return nKey.includes(target) || target.includes(nKey) || nId.includes(target) || target.includes(nId);
  });
  return fuzzy?.[1];
}

/**
 * Agent resolution order (multi-tenant behavior):
 *   1. the DYNAMIC store-driven factory — wins whenever an enabled
 *      calla_agent_configs row exists (covers orchestrator/miles/custom and
 *      hot-swaps persona instructions + skills without a restart);
 *   2. the STATIC mastra registry fallback (built-in code-defined agents).
 */
async function resolveAgent(agentId: string): Promise<AnyAgent | undefined> {
  const dynamic = await resolveDynamicAgent(agentId);
  if (dynamic) return dynamic as unknown as AnyAgent;
  return resolveStaticAgent(agentId);
}

function buildExecutionOptions(body: { threadId?: string; resourceId?: string }) {
  const options: { memory?: { thread: string; resource?: string } } = {};
  if (body.threadId) {
    options.memory = {
      thread: body.threadId,
      ...(body.resourceId ? { resource: body.resourceId } : {}),
    };
  }
  return options;
}

async function parseBody<T extends z.ZodType>(schema: T, c: { req: { json(): Promise<unknown> } }) {
  const raw = await c.req.json().catch(() => null);
  return schema.safeParse(raw);
}

const ENDPOINTS = [
  "GET /health",
  "GET /",
  "GET /auth/status",
  "POST /auth/register",
  "POST /auth/login",
  "GET /auth/me",
  "POST /auth/logout",
  "POST /agents/:agentId/generate",
  "POST /agents/:agentId/stream",
  "GET /agents/:agentId/suspended-runs",
  "POST /agents/:agentId/approve-tool-call",
  "POST /agents/:agentId/decline-tool-call",
  "GET /audit",
  "GET /audit/verify",
  "GET /approvals",
  "GET /agents",
  "GET /skills",
  "POST /skills/:agentId",
  "PUT /skills/:agentId/:name",
  "DELETE /skills/:agentId/:name",
  "GET /agents/configs",
  "POST /agents/configs",
  "PUT /agents/configs/:agentId",
  "GET /agents/:agentId/skills",
  "POST /workflows/approval-gate",
  "GET /workflows/approval-gate/suspended",
  "POST /workflows/approval-gate/:runId/resume",
  "GET /channels",
  "POST /channels/bindings/code",
  "GET /channels/bindings",
  "POST /channels/telegram/webhook",
  "GET|POST /channels/whatsapp/webhook",
  "GET|POST /channels/instagram/webhook",
  "GET|POST /channels/tiktok/webhook",
  "GET|POST /channels/facebook/webhook",
  "POST /channels/instagram/exchange",
  "GET /channels/social/triggers",
  "PUT /channels/social/triggers",
  "POST /channels/social/test",
  "POST /channels/test/notify",
  "GET /forms/widget.js",
  "GET /forms/definition",
  "POST /forms/ingest",
  "GET /booking",
  "GET /booking/reps",
  "POST /booking/reps",
  "PUT /booking/reps/:repId",
  "DELETE /booking/reps/:repId",
  "GET /booking/policy",
  "PUT /booking/policy",
  "POST /booking/connect/:provider/start",
  "POST /booking/connect/calendly/link",
  "GET /booking/connect/:provider/callback",
  "GET /booking/availability",
  "POST /booking/appointments",
  "GET /booking/appointments",
  "DELETE /booking/appointments/:id",
  "POST /booking/webhook/calendly",
  "GET|POST /booking/webhook/google",
  "POST /booking/webhook/microsoft",
  "ALL /mcp/booking  (MCP Streamable HTTP — list_reps, check_availability, book_appointment, list_appointments, cancel_appointment)",
  "GET /flows/definitions",
  "POST /flows/definitions",
  "GET /flows/definitions/:id",
  "PUT /flows/definitions/:id",
  "DELETE /flows/definitions/:id",
  "POST /flows/runs",
  "GET /flows/runs",
  "GET /flows/runs/:id",
  "POST /flows/runs/:id/answer",
  "POST /flows/runs/:id/cancel",
  "POST /flows/runs/:id/book",
  "GET /flows/routing/rules",
  "POST /flows/routing/rules",
  "DELETE /flows/routing/rules/:id",
  "GET /conversations",
  "GET /conversations/:id",
  "POST /conversations/:id/message",
  "POST /conversations/:id/takeover",
  "DELETE /conversations/:id",
];

// ─── App ─────────────────────────────────────────────────────────

export const app = new Hono();

// Permissive CORS — the Manager UI is served cross-origin (Vite proxy / edge).
app.use("*", cors());

// Self-hosted (standalone) auth sub-app. Mounted BEFORE the bearer middleware
// (and also exempted inside it) so /auth/register + /auth/login stay reachable
// pre-authentication. It issues the same HS256 JWTs the edge worker verifies.
app.route("/auth", createAuthApp({ store: getCallaStore() }));

// Bearer auth: accepts EITHER the static CALLA_TOKEN (service/relay) OR a
// valid Calla JWT signed with CALLA_JWT_SECRET (standalone users). Enforced
// only when at least one secret is configured; otherwise open (local dev).
// Exempt: "/", "/health", the self-managed "/auth/*" sub-app, channel
// platform webhooks (native auth: Telegram secret header / Meta + Instagram
// verify token + X-Hub-Signature-256 HMAC / Facebook Lead-Forms verify token
// + HMAC / TikTok verify-token challenge), the PUBLIC "/forms/*" embeddable
// widget routes (rate-limited + optional CORS allowlist), and the booking
// webhooks + OAuth callback (each self-verifies: Calendly X-Signature HMAC,
// Google channel token/resource-state, Graph clientState + validationToken;
// the callback validates the single-use cached OAuth state).
const PUBLIC_PATHS = new Set(["/", "/health"]);
const CHANNEL_WEBHOOK_PATHS = new Set([
  "/channels/telegram/webhook",
  "/channels/whatsapp/webhook",
  "/channels/instagram/webhook",
  "/channels/tiktok/webhook",
  "/channels/facebook/webhook",
]);
const BOOKING_WEBHOOK_PATHS = new Set([
  "/booking/webhook/calendly",
  "/booking/webhook/google",
  "/booking/webhook/microsoft",
]);
function isAuthExempt(pathname: string): boolean {
  return (
    PUBLIC_PATHS.has(pathname) ||
    pathname === "/auth" ||
    pathname.startsWith("/auth/") ||
    CHANNEL_WEBHOOK_PATHS.has(pathname) ||
    BOOKING_WEBHOOK_PATHS.has(pathname) ||
    // Embeddable website form (widget.js / definition / ingest) — public BY
    // DESIGN (embedded on marketing sites; rate-limited + optional
    // FORMS_ALLOWED_ORIGINS CORS allowlist; see src/forms/widget.ts).
    pathname === "/forms" ||
    pathname.startsWith("/forms/") ||
    // OAuth redirect target (browser, no bearer) — CSRF-guarded by state.
    /^\/booking\/connect\/[^/]+\/callback$/.test(pathname)
  );
}
app.use("*", async (c, next) => {
  const staticToken = process.env.CALLA_TOKEN;
  const jwtSecret = process.env.CALLA_JWT_SECRET?.trim();
  if (!staticToken && !jwtSecret) return next(); // open (dev)
  const { pathname } = new URL(c.req.url);
  if (isAuthExempt(pathname)) return next();
  const header = c.req.header("Authorization") ?? "";
  const [scheme, value] = header.split(" ");
  if (scheme === "Bearer" && value) {
    if (staticToken && value === staticToken) return next();
    if (jwtSecret) {
      const claims = await verifyCallaToken(value, jwtSecret);
      if (claims) return next();
    }
  }
  return c.json({ error: "Unauthorized" }, 401);
});

// Messaging channels (Telegram / WhatsApp) — mounted AFTER the bearer
// middleware so management routes (/channels, /channels/bindings*,
// /channels/test/notify) require auth; platform webhooks are exempted by
// isAuthExempt above and use platform-native auth instead.
app.route(
  "/channels",
  createChannelsApp(buildChannelsDeps(mastra, getCallaStore())),
);

// Appointment booking (Google Calendar / Microsoft 365 / Calendly) — mounted
// AFTER the bearer middleware so management routes (/booking, /reps, /policy,
// /connect/*, /availability, /appointments) require auth; the three webhook
// paths and the OAuth callback are exempted by isAuthExempt above and
// self-verify instead. Ireland-first: Europe/Dublin default timezone.
app.route("/booking", createBookingApp({ store: getCallaStore() }));

// Calla-hosted Booking MCP server — the standard "Google Calendar MCP" surface
// (Streamable HTTP). Backed by the SAME dual backend as the /booking REST routes
// (BOOKING_BACKEND=native|mcp|both), so MCP clients (Mastra agents via
// @mastra/mcp, the voice agent, Claude Desktop, Cursor, external orchestrators)
// get identical availability/booking behaviour + audit trail. Stateless (fresh
// McpServer per request). Mounted AFTER the bearer middleware → clients auth
// with Authorization: Bearer <CALLA_TOKEN | Calla JWT>. Gated by
// BOOKING_MCP_ENABLED (default on). Tools: list_reps, check_availability,
// book_appointment, list_appointments, cancel_appointment.
if ((process.env.BOOKING_MCP_ENABLED ?? "true").trim().toLowerCase() !== "false") {
  app.all("/mcp/booking", (c) => handleBookingMcpRequest(getCallaStore(), c.req.raw));
}

// Qualification flows + lead routing (Flowly-style multi-step enquiry
// qualification for the Irish retrofit/property verticals) — mounted AFTER
// the bearer middleware so every /flows route requires auth. Runner semantics,
// scoring, routing rules and the social-channel handoff: see src/flows/** and
// the "Qualification flows & routing" section of the README.
app.route("/flows", createFlowsApp({ store: getCallaStore() }));

// Conversation threads (operator console) — the "every social/WhatsApp customer
// conversation" view recorded by the social engine + approval path
// (src/conversations/**). Mounted AFTER the bearer middleware so every route
// requires auth: list/detail, a MANUAL operator reply through the platform
// sender, per-thread takeover (pause automation), and the GDPR deletion path.
// Contract: README → "Conversations API".
app.route("/conversations", createConversationsApp({ store: getCallaStore() }));

// Per-deployment feature flags (module enable/disable) — the singleton
// calla_deployment_config row: GET/PUT /config/modules + presets. Mounted
// AFTER the bearer middleware so every route requires auth.
app.route("/config", createConfigApp({ store: getCallaStore() }));

// Embeddable website form (public by design — mounted AFTER the bearer
// middleware but exempted by isAuthExempt above): /forms/widget.js serves the
// tiny embeddable IIFE, /forms/definition the public flow shape, and
// /forms/ingest captures the lead + starts the qualification run (channel
// "form", chatRef `form:<session>`). Hardening options + API contract:
// src/forms/widget.ts and channels/README.md → "Meta Lead Forms + website widget".
app.route("/forms", createFormsApp({ store: getCallaStore() }));

app.get("/health", (c) =>
  c.json({
    ok: true,
    service: "calla-brain",
    storage: storageKind,
    model: describeLlmConfig(),
    callaStore: getCallaStore().kind,
  }),
);

app.get("/", async (c) => {
  const agents = mastra.listAgents() as Record<string, AnyAgent>;
  const listed = Object.entries(agents).map(([key, a]) => ({ key, id: a.id, name: a.name }));
  // Include store-driven agents that are not (yet) in the mastra registry so
  // GET / reflects every enabled dynamic config across restarts/instances.
  const seen = new Set(listed.flatMap((a) => [a.key, a.id]));
  const configs = (await withStore("listAgentConfigs", (s) => s.listAgentConfigs())) ?? [];
  const dynamic = configs
    .filter((cfg) => cfg.enabled && !seen.has(cfg.agentId))
    .map((cfg) => ({ key: cfg.agentId, id: cfg.agentId, name: cfg.name }));
  return c.json({
    name: "calla-brain",
    agents: [...listed, ...dynamic],
    dynamicAgents: listDynamicAgentIds(),
    endpoints: ENDPOINTS,
  });
});

app.post("/agents/:agentId/generate", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const parsed = await parseBody(executionRequestSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }

  const startedAt = Date.now();
  const output = await agent.generate(
    parsed.data.messages as MessageListInput,
    buildExecutionOptions(parsed.data),
  );
  if (output.error) {
    return c.json({ error: errorMessage(output.error), agentId: agent.id }, 502);
  }
  const serialized = serializeFullOutput(output);

  // Durable store hooks (best-effort, never break the response):
  // suspended run → pending approval rows; completed run → evaluator pipeline.
  recordSuspendedFromOutput(agent.id, serialized);
  fireRunEvaluators({
    agentId: agent.id,
    runId: serialized.runId,
    startedAt,
    input: normalizeInputMessages(parsed.data.messages),
    output: {
      text: serialized.text,
      toolCalls: serialized.toolCalls,
      finishReason: serialized.finishReason,
    },
    threadId: parsed.data.threadId,
    resourceId: parsed.data.resourceId,
  });

  return c.json({ agentId: agent.id, ...serialized });
});

app.post("/agents/:agentId/stream", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const parsed = await parseBody(executionRequestSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }

  const startedAt = Date.now();
  const input = normalizeInputMessages(parsed.data.messages);
  const modelOutput = await agent.stream(
    parsed.data.messages as MessageListInput,
    buildExecutionOptions(parsed.data),
  );

  // Durable store hooks — least-invasive point is the NDJSON serializer's
  // observer: approval chunks → pending rows; stream end → evaluator pipeline.
  const seenApprovalKeys = new Set<string>();
  const observer: StreamObserver = {
    onApprovalChunk(line) {
      const toolCallId = typeof line.toolCallId === "string" && line.toolCallId ? line.toolCallId : null;
      const toolName = typeof line.toolName === "string" ? line.toolName : "";
      const key = toolCallId || toolName;
      if (!key || seenApprovalKeys.has(key)) return;
      seenApprovalKeys.add(key);
      const runId = typeof line.runId === "string" && line.runId ? line.runId : modelOutput.runId ?? null;
      void recordPendingApproval({
        agentId: agent.id,
        toolName: toolName || "unknown",
        toolCallId,
        args: (line.args ?? {}) as Record<string, unknown>,
        runId,
      }).catch((err) => console.error("[calla-brain] recordPendingApproval failed:", err));
    },
    onFinish(summary: StreamSummary) {
      fireRunEvaluators({
        agentId: agent.id,
        runId: summary.runId ?? modelOutput.runId ?? null,
        startedAt,
        input,
        output: {
          text: summary.text,
          toolCalls: summary.toolCalls,
          finishReason: summary.finishReason,
        },
        threadId: parsed.data.threadId,
        resourceId: parsed.data.resourceId,
      });
    },
  };

  c.header("Content-Type", "application/x-ndjson");
  c.header("Cache-Control", "no-store");
  c.header("X-Accel-Buffering", "no");
  return c.body(createNdjsonStream(modelOutput, c.req.raw.signal, observer));
});

app.get("/agents/:agentId/suspended-runs", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const threadId = c.req.query("threadId") || undefined;
  const resourceId = c.req.query("resourceId") || undefined;
  const result = await agent.listSuspendedRuns({
    ...(threadId ? { threadId } : {}),
    ...(resourceId ? { resourceId } : {}),
  });

  return c.json({
    runs: flattenSuspendedRuns(result.runs, agent.id),
    total: result.total,
  });
});

app.post("/agents/:agentId/approve-tool-call", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const parsed = await parseBody(approveRequestSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const { runId, toolCallId, updatedArgs } = parsed.data;

  if (updatedArgs) {
    console.warn(
      `[calla-brain] approve-tool-call received updatedArgs for run ${runId}, but Mastra 1.74 ` +
        "resumes approvals with the model's original args; the edited args were ignored.",
    );
  }

  const startedAt = Date.now();
  const output = await agent.approveToolCallGenerate({
    runId,
    ...(toolCallId ? { toolCallId } : {}),
  });
  if (output.error) {
    return c.json({ error: errorMessage(output.error), runId }, 502);
  }

  const result = serializeFullOutput(output);

  // Durable store hooks (best-effort): decision row + audit entry, pending
  // rows when the resumed run suspends again, evaluators for the resumed run.
  void recordApprovalDecision({
    agentId: agent.id,
    decision: "approved",
    runId,
    toolCallId: toolCallId ?? null,
    ...(updatedArgs ? { updatedArgs } : {}),
    fallbackOutput: result,
  });
  recordSuspendedFromOutput(agent.id, result);
  fireRunEvaluators({
    agentId: agent.id,
    runId: result.runId ?? runId,
    startedAt,
    input: [{ role: "system", content: `approve-tool-call run ${runId}` }],
    output: { text: result.text, toolCalls: result.toolCalls, finishReason: result.finishReason },
  });

  return c.json({
    ok: true,
    approved: true,
    runId,
    toolCallId: toolCallId ?? null,
    updatedArgsApplied: false,
    result,
  });
});

app.post("/agents/:agentId/decline-tool-call", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const parsed = await parseBody(declineRequestSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const { runId, toolCallId, reason } = parsed.data;

  const startedAt = Date.now();
  const output = await agent.declineToolCallGenerate({
    runId,
    ...(toolCallId ? { toolCallId } : {}),
    ...(reason ? { reason } : {}),
  });
  if (output.error) {
    return c.json({ error: errorMessage(output.error), runId }, 502);
  }

  const result = serializeFullOutput(output);

  // Durable store hooks (best-effort): decision row + audit entry, pending
  // rows when the resumed run suspends again, evaluators for the resumed run.
  void recordApprovalDecision({
    agentId: agent.id,
    decision: "declined",
    runId,
    toolCallId: toolCallId ?? null,
    reason: reason ?? null,
    fallbackOutput: result,
  });
  recordSuspendedFromOutput(agent.id, result);
  fireRunEvaluators({
    agentId: agent.id,
    runId: result.runId ?? runId,
    startedAt,
    input: [{ role: "system", content: `decline-tool-call run ${runId}` }],
    output: { text: result.text, toolCalls: result.toolCalls, finishReason: result.finishReason },
  });

  return c.json({
    ok: true,
    approved: false,
    runId,
    toolCallId: toolCallId ?? null,
    reason: reason ?? null,
    result,
  });
});

// ─── Durable Calla store routes ──────────────────────────────────

function queryLimit(c: { req: { query(key: string): string | undefined } }, fallback: number): number {
  const raw = Number(c.req.query("limit") ?? "");
  if (!Number.isFinite(raw) || raw < 1) return fallback;
  return Math.min(Math.trunc(raw), 500);
}

app.get("/audit", async (c) => {
  const limit = queryLimit(c, 50);
  const agentId = c.req.query("agentId") || undefined;
  const kind = c.req.query("kind") || undefined;
  const entries = await withStore("getAudit", (s) => s.getAudit({ limit, agentId, kind, order: "desc" }));
  if (!entries) return c.json({ error: "calla store unavailable" }, 500);
  return c.json({ entries, count: entries.length });
});

app.get("/audit/verify", async (c) => {
  const result = await withStore("verifyAudit", (s) => s.verifyAudit());
  if (!result) return c.json({ error: "calla store unavailable" }, 500);
  return c.json(result);
});

const APPROVAL_STATUSES = new Set(["pending", "approved", "declined", "expired"]);

app.get("/approvals", async (c) => {
  const status = c.req.query("status") || undefined;
  if (status && !APPROVAL_STATUSES.has(status)) {
    return c.json({ error: `Invalid status: ${status} (expected one of ${[...APPROVAL_STATUSES].join(", ")})` }, 400);
  }
  const agentId = c.req.query("agentId") || undefined;
  const limit = queryLimit(c, 100);
  const approvals = await withStore("listApprovals", (s) =>
    s.listApprovals({ limit, agentId, ...(status ? { status: status as ApprovalStatus } : {}) }),
  );
  if (!approvals) return c.json({ error: "calla store unavailable" }, 500);
  return c.json({ approvals, total: approvals.length });
});

app.get("/agents", async (c) => {
  const agents = await withStore("listAgents", (s) => s.listAgents());
  if (!agents) return c.json({ error: "calla store unavailable" }, 500);
  return c.json({ agents, total: agents.length });
});

// ─── Skills & dynamic agent configs (multi-tenant behavior) ──────
// Persona instructions + skill markdown live in calla_agent_configs /
// calla_skills and resolve into Mastra agents via the dynamic factory
// (./mastra/dynamic-agents.ts): edits hot-swap behavior, no restart.
// Every mutation is hash-chain audited and invalidates the agent cache.

function invalidSkillName(name: string): string | null {
  if (name.length > SKILL_NAME_MAX) {
    return `Skill name must be at most ${SKILL_NAME_MAX} characters`;
  }
  if (!SKILL_NAME_RE.test(name)) {
    return `Invalid skill name "${name}": lowercase letters, numbers and hyphens only (e.g. tone-guide)`;
  }
  return null;
}

async function auditMutation(
  kind: "skill.created" | "skill.updated" | "skill.deleted" | "agent.configured",
  agentId: string,
  entry: Record<string, unknown>,
): Promise<void> {
  await withStore(`appendAudit(${kind})`, (s) => s.appendAudit({ agentId, kind, entry }));
}

app.get("/skills", async (c) => {
  const agentId = c.req.query("agentId") || undefined;
  const skills = await withStore("listSkills", (s) => s.listSkills(agentId));
  if (!skills) return c.json({ error: "calla store unavailable" }, 500);
  return c.json({ skills, total: skills.length });
});

app.post("/skills/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const parsed = await parseBody(createSkillSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const { name, description, instructions, references } = parsed.data;
  const nameError = invalidSkillName(name);
  if (nameError) return c.json({ error: nameError }, 400);

  const existing = await withStore("getSkill", (s) => s.getSkill(agentId, name));
  if (existing) {
    return c.json(
      { error: `Skill "${name}" already exists for agent "${agentId}" (PUT to update)` },
      409,
    );
  }
  const skill = await withStore("upsertSkill", (s) =>
    s.upsertSkill({ agentId, name, description, instructions, references, source: "uploaded" }),
  );
  if (!skill) return c.json({ error: "calla store unavailable" }, 500);

  invalidateDynamicAgent(agentId);
  await auditMutation("skill.created", agentId, { agentId, name, version: skill.version });
  return c.json({ skill }, 201);
});

app.put("/skills/:agentId/:name", async (c) => {
  const agentId = c.req.param("agentId");
  const name = c.req.param("name");
  const nameError = invalidSkillName(name);
  if (nameError) return c.json({ error: nameError }, 400);

  const parsed = await parseBody(updateSkillSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const existing = await withStore("getSkill", (s) => s.getSkill(agentId, name));
  const skill = await withStore("upsertSkill", (s) =>
    s.upsertSkill({
      agentId,
      name,
      description: parsed.data.description ?? existing?.description ?? name,
      instructions: parsed.data.instructions,
      references: parsed.data.references ?? existing?.references,
      ...(existing ? {} : { source: "uploaded" as const }),
    }),
  );
  if (!skill) return c.json({ error: "calla store unavailable" }, 500);

  invalidateDynamicAgent(agentId);
  await auditMutation(existing ? "skill.updated" : "skill.created", agentId, {
    agentId,
    name,
    version: skill.version,
  });
  return c.json({ skill });
});

app.delete("/skills/:agentId/:name", async (c) => {
  const agentId = c.req.param("agentId");
  const name = c.req.param("name");
  const result = await withStore("deleteSkill", (s) => s.deleteSkill(agentId, name));
  if (!result) return c.json({ error: "calla store unavailable" }, 500);
  if (!result.deleted) {
    if (result.reason === "builtin") {
      return c.json({ error: "builtin skill cannot be deleted; edit it instead" }, 400);
    }
    return c.json({ error: `Skill "${name}" not found for agent "${agentId}"` }, 404);
  }

  invalidateDynamicAgent(agentId);
  await auditMutation("skill.deleted", agentId, {
    agentId,
    name,
    version: result.skill.version,
  });
  return c.json({ ok: true, skill: result.skill });
});

app.get("/agents/configs", async (c) => {
  const configs = await withStore("listAgentConfigs", (s) => s.listAgentConfigs());
  if (!configs) return c.json({ error: "calla store unavailable" }, 500);
  return c.json({ configs, total: configs.length });
});

app.post("/agents/configs", async (c) => {
  const parsed = await parseBody(createAgentConfigSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const { agentId, name, description, instructions, model } = parsed.data;
  if (!SKILL_NAME_RE.test(agentId)) {
    return c.json(
      { error: `Invalid agentId "${agentId}": lowercase letters, numbers and hyphens only` },
      400,
    );
  }
  const existing = await withStore("getAgentConfig", (s) => s.getAgentConfig(agentId));
  if (existing) {
    return c.json({ error: `Agent config "${agentId}" already exists (PUT to update)` }, 409);
  }
  const config = await withStore("upsertAgentConfig", (s) =>
    s.upsertAgentConfig({
      agentId,
      name,
      description: description ?? null,
      instructions,
      model: model ?? null,
      source: "uploaded",
      enabled: true,
    }),
  );
  if (!config) return c.json({ error: "calla store unavailable" }, 500);

  invalidateDynamicAgent(agentId);
  // Best-effort build+register (mastra.addAgent for brand-new ids) so the
  // agent is live in GET / and Studio immediately.
  await resolveDynamicAgent(agentId);
  await auditMutation("agent.configured", agentId, { agentId, name, version: config.version });
  return c.json({ config }, 201);
});

app.put("/agents/configs/:agentId", async (c) => {
  const agentId = c.req.param("agentId");
  const parsed = await parseBody(updateAgentConfigSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
  }
  const body = parsed.data;
  if (
    body.name === undefined &&
    body.description === undefined &&
    body.instructions === undefined &&
    body.model === undefined &&
    body.enabled === undefined
  ) {
    return c.json({ error: "Nothing to update: provide name, description, instructions, model or enabled" }, 400);
  }
  const existing = await withStore("getAgentConfig", (s) => s.getAgentConfig(agentId));
  if (!existing) return c.json({ error: `Unknown agent config: ${agentId}` }, 404);

  const config = await withStore("upsertAgentConfig", (s) =>
    s.upsertAgentConfig({
      agentId,
      name: body.name ?? existing.name,
      description: body.description !== undefined ? body.description : existing.description,
      instructions: body.instructions ?? existing.instructions,
      model: body.model !== undefined ? body.model : existing.model,
      source: existing.source,
      enabled: body.enabled ?? existing.enabled,
    }),
  );
  if (!config) return c.json({ error: "calla store unavailable" }, 500);

  invalidateDynamicAgent(agentId);
  // Warm the rebuilt agent (skipped when disabled — resolution then falls
  // back to the static registry / 404).
  if (config.enabled) await resolveDynamicAgent(agentId);
  await auditMutation("agent.configured", agentId, {
    agentId,
    name: config.name,
    version: config.version,
  });
  return c.json({ config });
});

app.get("/agents/:agentId/skills", async (c) => {
  const agentId = c.req.param("agentId");
  const agent = await resolveAgent(agentId);
  if (!agent) return c.json({ error: `Unknown agent: ${agentId}` }, 404);

  const [config, storeSkills] = await Promise.all([
    withStore("getAgentConfig", (s) => s.getAgentConfig(agentId)),
    withStore("listSkills", (s) => s.listSkills(agentId)),
  ]);
  const sourceByName = new Map((storeSkills ?? []).map((s) => [s.name, s.source] as const));
  let skills: { name: string; description: string; source: string }[];
  try {
    const meta = await agent.listSkills();
    skills = meta.map((m) => ({
      name: m.name,
      description: m.description,
      source: sourceByName.get(m.name) ?? "uploaded",
    }));
  } catch (err) {
    console.warn(
      `[calla-brain] agent.listSkills() failed for "${agentId}" — falling back to the store view:`,
      errorMessage(err),
    );
    skills = (storeSkills ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      source: s.source,
    }));
  }
  return c.json({ agentId, skills, instructionsVersion: config?.version ?? null });
});

// ─── Workflow-level HITL gates ───────────────────────────────────
// Pattern adopted from chrislema/mastra-builder (deliveryDeploymentWorkflow):
// long-running, multi-stage actions pause on a Mastra workflow suspend() with
// a resumeLabel; the decision captures the APPROVER identity and persists to
// storage (survives restarts) + the hash-chained audit log. Complements the
// tool-level requireApproval gates used by the orchestrator agent.

const GATE_TOOL_NAME = "approval-gate";

const approvalGateStartSchema = z.object({
  approvalId: z.string().min(1).optional(),
  reason: z.string().min(1),
  summary: z.string().optional(),
  risk: z.enum(["low", "medium", "high", "critical"]).default("medium"),
  agentId: z.string().optional(),
  timeoutMs: z.number().int().positive().optional(),
});

const approvalGateResumeSchema = z.object({
  approved: z.boolean(),
  approver: z.string().optional(),
  notes: z.string().optional(),
});

/** Start a gated approval workflow run; returns once it suspends. */
app.post("/workflows/approval-gate", async (c) => {
  const parsed = await parseBody(approvalGateStartSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);
  }
  const input = parsed.data;
  const approvalId = input.approvalId ?? crypto.randomUUID();

  const wf = mastra.getWorkflow("approvalWithEscalation");
  if (!wf) return c.json({ error: "approval workflow not registered" }, 500);

  const run = await wf.createRun({
    ...(input.agentId ? { resourceId: input.agentId } : {}),
  });
  const result = await run.start({
    inputData: {
      approvalId,
      reason: input.reason,
      ...(input.summary ? { summary: input.summary } : {}),
      risk: input.risk,
      ...(input.agentId ? { agentId: input.agentId } : {}),
      timeoutMs: input.timeoutMs ?? DEFAULT_APPROVAL_WINDOW_MS,
    },
  });

  // Track the gate as a pending approval row so the suspended list (and the
  // unified inbox history) survives restarts — workflow snapshots alone are
  // not queryable by status.
  await withStore("recordApproval(gate-pending)", (s) =>
    s.recordApproval({
      source: "mastra",
      agentId: input.agentId ?? "calla-orchestrator",
      toolName: GATE_TOOL_NAME,
      args: { reason: input.reason, ...(input.summary ? { summary: input.summary } : {}) },
      risk: input.risk,
      summary: input.summary ?? input.reason,
      status: "pending",
      runId: run.runId,
    }),
  );

  return c.json({
    runId: run.runId,
    approvalId,
    status: result.status,
    resumeLabel: "approve-calla-gate",
    suspended: result.status === "suspended",
  });
});

/** List gate runs currently awaiting a human decision. */
app.get("/workflows/approval-gate/suspended", async (c) => {
  const rows = await withStore("listApprovals(gates)", (s) =>
    s.listApprovals({ status: "pending", limit: 200 }),
  );
  if (!rows) return c.json({ error: "calla store unavailable" }, 500);
  const gates = rows.filter((r) => r.toolName === GATE_TOOL_NAME);
  return c.json({ gates, total: gates.length });
});

/** Resume a suspended gate with the decision + approver identity. */
app.post("/workflows/approval-gate/:runId/resume", async (c) => {
  const runId = c.req.param("runId");
  const parsed = await parseBody(approvalGateResumeSchema, c);
  if (!parsed.success) {
    return c.json({ error: "Invalid body", details: parsed.error.issues }, 400);
  }
  const { approved, approver, notes } = parsed.data;

  const wf = mastra.getWorkflow("approvalWithEscalation");
  if (!wf) return c.json({ error: "approval workflow not registered" }, 500);

  try {
    const run = await wf.createRun({ runId });
    const result = await run.resume({
      step: "request-approval",
      resumeData: {
        approved,
        ...(approver ? { approver } : {}),
        ...(notes ? { notes } : {}),
      },
    });

    // Append the decision to approval history (audit chain already captured
    // gate.decided with the approver inside the workflow step).
    await recordApprovalDecision({
      agentId: "calla-orchestrator",
      runId,
      decision: approved ? "approved" : "declined",
      ...(notes ? { reason: notes } : {}),
    });

    return c.json({
      runId,
      status: result.status,
      ...(result.status === "success" ? { result: result.result } : {}),
      ...(result.status === "failed" ? { error: errorMessage(result.error) } : {}),
    });
  } catch (err) {
    return c.json({ error: `resume failed: ${errorMessage(err)}` }, 500);
  }
});

app.notFound((c) => {
  const { pathname } = new URL(c.req.url);
  return c.json({ error: `Not found: ${c.req.method} ${pathname}` }, 404);
});

app.onError((err, c) => {
  console.error("[calla-brain] request failed:", err);
  return c.json({ error: errorMessage(err) }, 500);
});

// ─── Bootstrap ───────────────────────────────────────────────────

export const port = Number(process.env.PORT) || 3000;

/**
 * Bootstrap the durable Calla store (idempotent calla_* DDL) before serving.
 * A failing backend is logged, NOT fatal: LLM routes must keep working even
 * when the store is down (store hooks are best-effort everywhere).
 */
async function bootstrap(): Promise<void> {
  const store = getCallaStore();
  try {
    await initCallaStore();
    console.log(`[calla-brain] calla store ready (${store.kind}: ${store.target})`);
    // Seed the gradient3.io builtin stack (idempotent — never overwrites
    // tenant edits) and warm the store-driven agents so the dynamic builds
    // are live from boot. Best-effort: seeding failures must not block.
    try {
      const seeded = await seedBuiltins(store);
      if (seeded.configsSeeded.length > 0 || Object.keys(seeded.skillsSeeded).length > 0) {
        console.log(
          `[calla-brain] seeded builtins: configs=[${seeded.configsSeeded.join(", ")}] ` +
            `skills=${JSON.stringify(seeded.skillsSeeded)}`,
        );
      }
      for (const agentId of BUILTIN_AGENT_IDS) {
        await resolveDynamicAgent(agentId);
      }
    } catch (err) {
      console.error("[calla-brain] builtin seeding failed (continuing):", errorMessage(err));
    }
    // Seed the qualification-flow module (idempotent): the custom-definitions
    // cache key (builtins are code-versioned and merged on read) + an empty
    // routing-rules list. Best-effort, like the builtin seeding above.
    try {
      await seedFlows(store);
    } catch (err) {
      console.error("[calla-brain] flows seeding failed (continuing):", errorMessage(err));
    }
    // Seed deployment module flags from CALLA_MODULE_PRESET (dental|retrofit|
    // property) — ONLY when the singleton row was never written, so a
    // founder's runtime toggles in the UI always win over the deploy env.
    try {
      const presetName = process.env.CALLA_MODULE_PRESET?.trim();
      if (presetName) {
        const existing = await store.getDeploymentConfig();
        if (!existing) {
          const preset = MODULE_PRESETS[presetName];
          if (preset) {
            await store.setDeploymentConfig({
              modules: resolveModuleSet([...preset.modules]),
              preset: presetName,
              updatedBy: "deploy",
            });
            console.log(
              `[calla-brain] deployment config seeded from preset "${presetName}"`,
            );
          } else {
            console.error(
              `[calla-brain] unknown CALLA_MODULE_PRESET "${presetName}" ` +
                `(known: ${Object.keys(MODULE_PRESETS).join(", ")})`,
            );
          }
        }
      }
    } catch (err) {
      console.error("[calla-brain] deployment config seeding failed (continuing):", errorMessage(err));
    }
  } catch (err) {
    console.error(
      `[calla-brain] calla store bootstrap FAILED (${store.kind}: ${store.target}) — ` +
        "audit/approval persistence will retry per call but may error:",
      errorMessage(err),
    );
  }

  serve({ fetch: app.fetch, port }, (info) => {
    const llm = describeLlmConfig();
    console.log(
      `[calla-brain] listening on http://0.0.0.0:${info.port} (storage: ${storageKind}, ` +
        `callaStore: ${store.kind}, ` +
        `model: ${llm === "not-configured" ? "not configured — set LLM_BASE_URL/LLM_API_KEY (OpenAI-compatible) or ANTHROPIC_API_KEY; LLM calls disabled" : llm})`,
    );
    // Telegram polling/webhook + approval notifier (no-op when unconfigured).
    try {
      startChannels();
    } catch (err) {
      console.error("[calla-brain] channels start failed:", errorMessage(err));
    }
  });
}

// Graceful shutdown: stop channel polling + notifier sockets.
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    try {
      stopChannels();
    } catch {
      // best-effort
    }
    process.exit(0);
  });
}

void bootstrap();

export default { port, app };
