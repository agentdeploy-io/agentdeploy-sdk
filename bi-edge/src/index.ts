/// <reference types="@cloudflare/workers-types" />

export * from "./db/index.js";
export { Supervisor, COMMANDS, parseCommand, handleCommand } from "./agents/supervisor.js";
export { runQualifier, classifyBatch } from "./agents/qualifier.js";
export { runResearcher, researchBatch } from "./agents/researcher.js";
export { runWriter, writeBatch } from "./agents/writer.js";
export { runOutreach, runGateStack } from "./agents/outreach.js";
export { researchCron } from "./cron/research.js";
export { replyPollCron } from "./cron/reply-poll.js";
export { crawlCron } from "./cron/crawl.js";
export { housekeepingCron } from "./cron/housekeeping.js";
export { handleInboundSync } from "./routes/inbound-sync.js";
export { handleDataApi } from "./routes/data-api.js";
export { handleInboundWebhook } from "./routes/inbound-webhook.js";
export { CfSqlDatabase } from "./db/cf-sqlite.js";

import { createHandler } from "@agentdeploy-io/edge-sdk";
import { Supervisor, COMMANDS, parseCommand, handleCommand } from "./agents/supervisor.js";
import { handleInboundSync } from "./routes/inbound-sync.js";
import { handleDataApi } from "./routes/data-api.js";
import { handleInboundWebhook } from "./routes/inbound-webhook.js";
import { researchCron } from "./cron/research.js";
import { replyPollCron } from "./cron/reply-poll.js";
import { crawlCron } from "./cron/crawl.js";
import { housekeepingCron } from "./cron/housekeeping.js";
import { CfSqlDatabase } from "./db/cf-sqlite.js";
import { runMigrations } from "./db/migrations.js";
import {
  getAllSettings,
  setSetting,
  getSettingsWithDefaults,
  countByStage,
  countSentToday,
  isPaused,
  getSetting,
} from "./db/index.js";

// ── Env ──────────────────────────────────────────────────────────────────────

export interface Env {
  BI_EDGE: DurableObjectNamespace;
  AD_DEPLOYMENT_ID: string;
  AD_USER_ID: string;
  AD_GATEWAY_BASE_URL: string;
  AD_GATEWAY_API_KEY: string;
  AD_EDGE_CALLBACK_URL: string;
  AD_SYNC_SECRET: string;
  AD_JWT_SECRET?: string;
  AD_MODEL?: string;
  BRAND_NAME?: string;
  BRAND_SITE_URL?: string;
  BREVO_API_KEY?: string;
  BREVO_SENDER_EMAIL?: string;
  BRAVE_API_KEY?: string;
  CORE_URL?: string;
  CALENDLY_URL?: string;
  JEV_URL?: string;
  [key: string]: unknown;
}

// ── CORS ─────────────────────────────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AD-Sync, X-AD-Deployment",
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  if (response.status === 101 || response.webSocket) {
    for (const [k, v] of Object.entries(CORS_HEADERS)) response.headers.set(k, v);
    return response;
  }
  const r = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [k, v] of Object.entries(CORS_HEADERS)) r.headers.set(k, v);
  return r;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// ── Agent handler ────────────────────────────────────────────────────────────

const agentHandler = createHandler(Supervisor as any);

// ── Cron maps ────────────────────────────────────────────────────────────────

type CronHandler = (env: Record<string, unknown>, db?: any) => Promise<unknown>;

const CRON_SCHEDULE_MAP: Record<string, CronHandler> = {
  "0 1 * * *": crawlCron,
  "*/30 * * * *": researchCron,
  "*/15 * * * *": replyPollCron,
  "0 3 * * *": housekeepingCron,
};

const CRON_NAME_TO_SCHEDULE: Record<string, string> = {
  crawl: "0 1 * * *",
  research: "*/30 * * * *",
  reply_poll: "*/15 * * * *",
  housekeeping: "0 3 * * *",
};

const CRON_NAME_MAP: Record<string, CronHandler> = {
  crawl: crawlCron,
  research: researchCron,
  reply_poll: replyPollCron,
  housekeeping: housekeepingCron,
};

const SCHEDULE_MANIFEST = [
  { cron: "0 1 * * *", name: "crawl", description: "Daily crawl at 01:00 UTC" },
  { cron: "*/30 * * * *", name: "research", description: "Research pipeline every 30 min" },
  { cron: "*/15 * * * *", name: "reply_poll", description: "Reply poll every 15 min" },
  { cron: "0 3 * * *", name: "housekeeping", description: "Housekeeping at 03:00 UTC" },
];

// ── BiEdgeAgent Durable Object ──────────────────────────────────────────────

export class BiEdgeAgent {
  private state: DurableObjectState;
  private env: Env;
  private db: CfSqlDatabase | null = null;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  private getDb(): CfSqlDatabase {
    if (!this.db) {
      this.db = new CfSqlDatabase(this.state.storage.sql);
      runMigrations(this.db as any);
    }
    return this.db;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const env = this.env as Record<string, unknown>;
    const db = this.getDb();

    if (url.pathname === "/health") {
      return withCors(json({
        status: "ok",
        agent: "bi-edge",
        deploymentId: env.AD_DEPLOYMENT_ID,
        crons: Object.keys(CRON_NAME_MAP),
        version: "0.1.0",
      }));
    }

    if (url.pathname === "/endpoints") {
      return withCors(json({
        commands: COMMANDS,
        routes: [
          "POST /inbound/sync",
          "POST /inbound-webhook",
          "GET|POST /cmd/data*",
          "GET /cmd/runs",
          "GET /cmd/pipeline",
          "GET|POST /cmd/schedules",
          "GET|POST /cmd/settings",
          "GET|POST /cmd/secrets",
          "GET /cmd/wire",
          "GET /health",
          "GET /endpoints",
        ],
        crons: SCHEDULE_MANIFEST,
      }));
    }

    if (url.pathname === "/inbound/sync" && request.method === "POST") {
      return withCors(await handleInboundSync(request, env, db as any));
    }

    if ((url.pathname === "/inbound-webhook" || url.pathname === "/inbound/webhook") && request.method === "POST") {
      return withCors(await handleInboundWebhook(request, env, db as any));
    }

    if (url.pathname.startsWith("/cmd/data") || url.pathname === "/cmd/runs" || url.pathname === "/cmd/pipeline") {
      return withCors(await handleDataApi(request, env, db as any));
    }

    if (url.pathname === "/cmd/settings") {
      return withCors(await this.handleSettings(request, db));
    }

    if (url.pathname === "/cmd/secrets") {
      return withCors(await this.handleSecrets(request, env));
    }

    if (url.pathname === "/cmd/wire") {
      return withCors(json({
        topology: "bi-edge",
        agents: ["supervisor", "qualifier", "researcher", "writer", "outreach"],
        crons: Object.keys(CRON_NAME_MAP),
        routes: ["/inbound/sync", "/inbound-webhook", "/cmd/data", "/cmd/settings", "/cmd/secrets", "/cmd/wire", "/cmd/schedules"],
      }));
    }

    if (url.pathname === "/cmd/schedules") {
      return withCors(await this.handleSchedules(request, db, env));
    }

    if (url.pathname.startsWith("/_cron/")) {
      const cronName = url.pathname.replace("/_cron/", "");
      return withCors(await this.dispatchCron(cronName, db, env));
    }

    if (url.pathname.startsWith("/cmd/") && request.method === "POST") {
      return withCors(await this.handleSupervisorCommand(request, db, env));
    }

    if (url.pathname.startsWith("/agents/")) {
      try {
        const agentResponse = await agentHandler.fetch(request, env);
        return agentResponse;
      } catch {
        return withCors(json({ error: "Agent routing unavailable" }, 502));
      }
    }

    return withCors(json({
      error: "Not found",
      path: url.pathname,
      hint: "GET /endpoints for the command manifest, GET /health for status",
    }, 404));
  }

  async alarm(): Promise<void> {
    const db = this.getDb();
    const env = this.env as Record<string, unknown>;

    for (const [name, handler] of Object.entries(CRON_NAME_MAP)) {
      try {
        await handler(env, db as any);
      } catch (e) {
        console.error(`alarm cron ${name} failed:`, e);
      }
    }

    await this.rescheduleAlarms();
  }

  private async rescheduleAlarms(): Promise<void> {
    const nextAlarm = Date.now() + 15 * 60 * 1000;
    await this.state.storage.setAlarm(nextAlarm);
  }

  private async handleSettings(request: Request, db: CfSqlDatabase): Promise<Response> {
    if (request.method === "GET") {
      const all = getAllSettings(db as any);
      const defaults = getSettingsWithDefaults(db as any);
      return json({ settings: all, defaults });
    }
    if (request.method === "POST") {
      let body: Record<string, string>;
      try {
        body = await request.json() as Record<string, string>;
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const keys: string[] = [];
      for (const [k, v] of Object.entries(body)) {
        setSetting(db as any, k, String(v));
        keys.push(k);
      }
      return json({ updated: keys.length, keys });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  private async handleSecrets(request: Request, env: Record<string, unknown>): Promise<Response> {
    const secretKeys = [
      "AD_GATEWAY_API_KEY",
      "AD_SYNC_SECRET",
      "AD_JWT_SECRET",
      "BREVO_API_KEY",
      "BRAVE_API_KEY",
      "CORE_URL",
      "JEV_URL",
    ];

    if (request.method === "GET") {
      const status: Record<string, boolean> = {};
      for (const k of secretKeys) {
        status[k] = !!env[k];
      }
      return json({ secrets: status });
    }
    if (request.method === "POST") {
      return json({
        error: "Secrets must be set via `wrangler secret put` or the Cloudflare dashboard",
      }, 400);
    }
    return json({ error: "Method not allowed" }, 405);
  }

  private async handleSchedules(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    if (request.method === "GET") {
      const paused = isPaused(db as any);
      return json({ schedules: SCHEDULE_MANIFEST, paused });
    }
    if (request.method === "POST") {
      let body: { name?: string };
      try {
        body = await request.json() as { name?: string };
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const name = body.name;
      if (!name || !CRON_NAME_MAP[name]) {
        return json({
          error: `Unknown cron: ${name}`,
          available: Object.keys(CRON_NAME_MAP),
        }, 400);
      }
      try {
        const result = await CRON_NAME_MAP[name](env, db as any);
        return json({ triggered: name, result });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }
    return json({ error: "Method not allowed" }, 405);
  }

  private async dispatchCron(name: string, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    const handler = CRON_NAME_MAP[name];
    if (!handler) {
      return json({
        error: `Unknown cron: ${name}`,
        available: Object.keys(CRON_NAME_MAP),
      }, 404);
    }
    try {
      const result = await handler(env, db as any);
      return json({ ok: true, cron: name, result });
    } catch (e: any) {
      return json({ error: e.message, cron: name }, 500);
    }
  }

  private async handleSupervisorCommand(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    try {
      const body = await request.json() as { message?: string; text?: string; command?: string };
      const text = body.message ?? body.text ?? body.command ?? "";
      const { cmd, args } = parseCommand(text);
      const reply = await handleCommand(cmd, args, db as any, env);
      return json({ reply, command: cmd });
    } catch (e: any) {
      return json({ error: e.message }, 500);
    }
  }
}

// ── Worker default export ───────────────────────────────────────────────────

const CRON_EXPR_TO_NAME: Record<string, string> = {
  "0 1 * * *": "crawl",
  "*/30 * * * *": "research",
  "*/15 * * * *": "reply_poll",
  "0 3 * * *": "housekeeping",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return withCors(json({
        status: "ok",
        deploymentId: env.AD_DEPLOYMENT_ID,
        worker: "bi-edge",
        version: "0.1.0",
      }));
    }

    const id = env.BI_EDGE.idFromName("default");
    const stub = env.BI_EDGE.get(id);
    return stub.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const cronName = CRON_EXPR_TO_NAME[event.cron];
    if (!cronName) return;

    const id = env.BI_EDGE.idFromName("default");
    const stub = env.BI_EDGE.get(id);
    const req = new Request(`http://internal/_cron/${cronName}`, { method: "POST" });
    ctx.waitUntil(stub.fetch(req));
  },
};
