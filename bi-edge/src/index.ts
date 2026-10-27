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
export { handleManychatWebhook } from "./routes/inbound-manchat.js";
export { CfSqlDatabase } from "./db/cf-sqlite.js";

import { createHandler } from "@agentdeploy-io/edge-sdk";
import { Supervisor, COMMANDS, parseCommand, handleCommand } from "./agents/supervisor.js";
import { handleInboundSync } from "./routes/inbound-sync.js";
import { handleRunComplete } from "./routes/inbound-run-complete.js";
import { handleDataApi } from "./routes/data-api.js";
import { handleInboundWebhook } from "./routes/inbound-webhook.js";
import { handleManychatWebhook } from "./routes/inbound-manchat.js";
import { manychatPageInfo, ManyChatError } from "./manychat/client.js";
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
  isDmDryRun,
  isDmEnabled,
  getDmDailyCap,
  listTraces,
  getLead,
  isTestMode,
  getTestRecipient,
  listVerticals,
  getVertical,
  upsertVertical,
  deleteVertical,
  type Vertical,
} from "./db/index.js";
import { getFirstEmail, sendViaBrevo } from "./agents/outreach.js";
import { cronWasDue, isValidCron } from "./services/cron-match.js";
import { resolveCampaign, updateCampaign, campaignEnvOverrides } from "./services/campaign.js";

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// ── Agent handler ────────────────────────────────────────────────────────────

const agentHandler = createHandler(Supervisor as any);

// ── Cron maps ────────────────────────────────────────────────────────────────

type CronHandler = (env: Record<string, unknown>, db?: any) => Promise<unknown>;

const CRON_DEFAULTS: Record<string, string> = {
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

/**
 * Scheduler model: a single self-perpetuating DO alarm ticks every
 * SCHEDULE_TICK_MS. On each tick, every enabled schedule whose stored cron
 * expression was due since its last run fires exactly once (cronWasDue over
 * the (lastRun, now] window). Crons are stored in the settings table
 * (cron:<name>, cron_enabled:<name>, cron_last_run:<name>), so the UI can
 * edit them at runtime with no restart and no redeploy. The first alarm is
 * bootstrapped on the first request (alarms are self-perpetuating, so
 * nothing else ever needs to start them). A schedule with no recorded
 * lastRun fires once on the first tick (bootstrap), then on its cron.
 */
const SCHEDULE_TICK_MS = 5 * 60 * 1000;

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
      this.db = new CfSqlDatabase(this.state.storage.sql, (callback) => this.state.storage.transactionSync(callback));
      runMigrations(this.db as any);
    }
    return this.db;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const baseEnv = this.env as Record<string, unknown>;
    const db = this.getDb();
    // Campaign fields edited in the UI (settings table) override env so the
    // writer / outreach / reply-drafter pick them up without a redeploy.
    const env = { ...baseEnv, ...campaignEnvOverrides(db as any, baseEnv) };

    await this.ensureAlarmArmed();

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
          "POST /inbound/run-complete",
          "POST /inbound-webhook",
          "POST /inbound/manychat",
          "GET|POST /cmd/data*",
          "GET /cmd/runs",
          "GET /cmd/pipeline",
          "GET /cmd/crawl-status",
          "GET|POST|DELETE /cmd/verticals",
          "POST /cmd/sources/test · GET /cmd/sources/test/:id",
          "GET|POST|DELETE /cmd/scrapers · POST /cmd/scrapers/generate|test · GET /cmd/scrapers/generate/:id|test/:id",
          "GET /cmd/replies",
          "GET /cmd/sent",
          "GET|POST /cmd/schedules",
          "POST /cmd/schedules/:name/run",
          "GET|POST /cmd/settings",
          "GET|POST /cmd/secrets",
          "GET /cmd/wire",
          "GET|POST /cmd/campaign",
          "GET /cmd/manychat",
          "POST /cmd/simulate-reply",
          "GET /cmd/traces",
          "GET /health",
          "GET /endpoints",
        ],
        crons: SCHEDULE_MANIFEST,
      }));
    }

    if (url.pathname === "/inbound/sync" && request.method === "POST") {
      return withCors(await handleInboundSync(request, env, db as any));
    }

    if (url.pathname === "/inbound/run-complete" && request.method === "POST") {
      return withCors(await handleRunComplete(request, env, db as any));
    }

    if ((url.pathname === "/inbound-webhook" || url.pathname === "/inbound/webhook") && request.method === "POST") {
      return withCors(await handleInboundWebhook(request, env, db as any));
    }

    if (url.pathname === "/inbound/manychat" && request.method === "POST") {
      return withCors(await handleManychatWebhook(request, env, db as any));
    }

    if (
      url.pathname.startsWith("/cmd/data") ||
      url.pathname === "/cmd/runs" ||
      url.pathname === "/cmd/pipeline" ||
      url.pathname === "/cmd/replies" ||
      url.pathname === "/cmd/sent"
    ) {
      return withCors(await handleDataApi(request, env, db as any));
    }

    if (url.pathname === "/cmd/crawl-status") {
      return withCors(await this.handleCrawlStatus(env));
    }

    if (url.pathname === "/cmd/verticals" || url.pathname.startsWith("/cmd/verticals/")) {
      return withCors(await this.handleVerticals(request, db));
    }

    if (url.pathname === "/cmd/sources/test" || url.pathname.startsWith("/cmd/sources/test/")) {
      return withCors(await this.handleSourceTest(request, env, db));
    }

    if (url.pathname === "/cmd/scrapers" || url.pathname.startsWith("/cmd/scrapers/")) {
      return withCors(await this.handleScrapers(request, env));
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
        routes: ["/inbound/sync", "/inbound/run-complete", "/inbound-webhook", "/inbound/manychat", "/cmd/data", "/cmd/settings", "/cmd/secrets", "/cmd/wire", "/cmd/schedules", "/cmd/campaign", "/cmd/manychat", "/cmd/simulate-reply", "/cmd/traces"],
      }));
    }

    if (url.pathname === "/cmd/campaign") {
      return withCors(await this.handleCampaign(request, db, env));
    }

    if (url.pathname === "/cmd/manychat" && request.method === "GET") {
      return withCors(await this.handleManychatStatus(request, db, env));
    }

    if (url.pathname === "/cmd/simulate-reply" && request.method === "POST") {
      return withCors(await this.handleSimulateReply(request, db, env));
    }

    if (url.pathname === "/cmd/traces" && request.method === "GET") {
      const limit = Number(url.searchParams.get("limit") ?? 20);
      return withCors(json({ traces: listTraces(db as any, limit) }));
    }

    if (url.pathname === "/cmd/schedules" || url.pathname.startsWith("/cmd/schedules/")) {
      if (url.pathname === "/cmd/schedules") {
        return withCors(await this.handleSchedules(request, db, env));
      }
      const m = url.pathname.match(/^\/cmd\/schedules\/([^/]+)\/run$/);
      if (m && request.method === "POST") {
        return withCors(await this.runScheduleNow(decodeURIComponent(m[1]), request, db, env));
      }
      return withCors(json({ error: "Not found", path: url.pathname }, 404));
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
    const now = Date.now();

    for (const s of SCHEDULE_MANIFEST) {
      const name = s.name;
      if (getSetting(db as any, `cron_enabled:${name}`) === "0") continue;
      const expr = getSetting(db as any, `cron:${name}`) ?? s.cron;
      const lastRunRaw = getSetting(db as any, `cron_last_run:${name}`);
      const lastRunMs = lastRunRaw ? Date.parse(lastRunRaw) : 0;

      // No recorded lastRun → bootstrap run once, then on the cron.
      const due = lastRunMs === 0 || cronWasDue(expr, lastRunMs, now);
      if (!due) continue;

      // Record before running so a long run (crawl) can't re-trigger itself.
      setSetting(db as any, `cron_last_run:${name}`, new Date(now).toISOString());
      const handler = CRON_NAME_MAP[name];
      if (!handler) continue;
      try {
        await handler(env, db as any);
      } catch (e) {
        console.error(`alarm cron ${name} failed:`, e);
      }
    }

    await this.rescheduleAlarms();
  }

  private async rescheduleAlarms(): Promise<void> {
    const nextAlarm = Date.now() + SCHEDULE_TICK_MS;
    await this.state.storage.setAlarm(nextAlarm);
  }

  /**
   * Bootstrap the self-perpetuating alarm on a request. getAlarm/setAlarm
   * are async in current compatibility dates — await both before returning
   * the response or the commit is not guaranteed. Also re-arms a stale
   * (past) alarm, so a crashed tick self-heals on the next request.
   */
  private async ensureAlarmArmed(): Promise<void> {
    try {
      const existing = await this.state.storage.getAlarm();
      if (existing === null || existing < Date.now()) {
        await this.state.storage.setAlarm(Date.now() + 60_000);
      }
    } catch (e) {
      console.error("ensureAlarmArmed failed:", e);
    }
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

  /**
   * GET /cmd/campaign — the resolved campaign (UI edits win over env) plus
   * the test-mode state. POST — persist a partial campaign update.
   */
  private async handleCampaign(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    if (request.method === "GET") {
      const campaign = resolveCampaign(db as any, env);
      return json({
        campaign,
        testMode: isTestMode(db as any),
        testRecipient: getTestRecipient(db as any),
        countries: String(getSetting(db as any, "countries") ?? "uk,ie,fr"),
        crawlLimit: Number(getSetting(db as any, "crawlLimit") ?? 50),
      });
    }
    if (request.method === "POST") {
      let body: Record<string, string>;
      try {
        body = await request.json() as Record<string, string>;
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      const patch: Partial<Record<string, string>> = {};
      const allowed = ["brandName", "brandOneLiner", "brandSiteUrl", "brandLogoUrl", "calendlyUrl", "icpNotes"];
      for (const k of allowed) {
        if (k in body) patch[k] = String(body[k] ?? "");
      }
      const updated = updateCampaign(db as any, patch as any, env);
      const extraKeys: string[] = [];
      if (body.testMode !== undefined) {
        setSetting(db as any, "testMode", body.testMode === "true" || body.testMode === "1" ? "true" : "false");
        extraKeys.push("testMode");
      }
      if (body.testRecipient !== undefined) {
        setSetting(db as any, "testRecipient", String(body.testRecipient).trim());
        extraKeys.push("testRecipient");
      }
      if (body.countries !== undefined) {
        setSetting(db as any, "countries", String(body.countries).trim());
        extraKeys.push("countries");
      }
      if (body.crawlLimit !== undefined) {
        setSetting(db as any, "crawlLimit", String(Number(body.crawlLimit) || 50));
        extraKeys.push("crawlLimit");
      }
      return json({
        campaign: updated,
        testMode: isTestMode(db as any),
        testRecipient: getTestRecipient(db as any),
        countries: String(getSetting(db as any, "countries") ?? "uk,ie,fr"),
        crawlLimit: Number(getSetting(db as any, "crawlLimit") ?? 50),
      });
    }
    return json({ error: "Method not allowed" }, 405);
  }

  /**
   * GET /cmd/manychat — ManyChat integration status for the Operations UI:
   * key presence, live API health (getInfo), webhook token presence, and the
   * public webhook URL to paste into the Manychat dashboard.
   */
  private async handleManychatStatus(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? "";
    const proto = request.headers.get("x-forwarded-proto") ?? "https";
    const webhookUrl = host ? `${proto}://${host}/inbound/manychat` : "(deployed URL)/inbound/manychat";

    const keyConfigured = Boolean(String(env.MANYCHAT_API_KEY ?? "").trim());
    const webhookTokenConfigured = Boolean(String(env.MANYCHAT_WEBHOOK_TOKEN ?? "").trim());

    let api: { ok: true; page: { id: number; name: string; username: string; category: string } } | { ok: false; error: string } = {
      ok: false,
      error: keyConfigured ? "" : "no API key configured",
    };
    if (keyConfigured) {
      try {
        const page = await manychatPageInfo(env);
        api = { ok: true, page: { id: page.id, name: page.name, username: page.username, category: page.category } };
      } catch (e: any) {
        const msg = e instanceof ManyChatError ? e.message : String(e?.message ?? e);
        api = {
          ok: false,
          error:
            e instanceof ManyChatError && e.status === 401
              ? "key rejected by ManyChat (401 Wrong token — public API requires a paid plan; key may also be stale)"
              : msg,
        };
      }
    }

    let inboundLeads = 0;
    let pendingDmDrafts = 0;
    try {
      const row = (db as any).prepare("SELECT COUNT(*) AS n FROM leads WHERE source = 'manychat'").get() as { n: number } | undefined;
      inboundLeads = row?.n ?? 0;
      const drafts = (db as any).prepare("SELECT COUNT(*) AS n FROM replies_log WHERE channel = 'manychat' AND draft_status = 'pending'").get() as { n: number } | undefined;
      pendingDmDrafts = drafts?.n ?? 0;
    } catch {
      /* DB not ready */
    }

    return json({
      keyConfigured,
      webhookTokenConfigured,
      webhookUrl,
      api,
      inboundLeads,
      pendingDmDrafts,
      dm: {
        dmDryRun: isDmDryRun(db as any),
        dmEnabled: isDmEnabled(db as any),
        dmDailyCap: getDmDailyCap(db as any),
        sentDmToday: countSentToday(db as any, "manychat"),
      },
      freeTierNote:
        "ManyChat public API + External Request/webhooks are paid-plan features. On the Free tier the key returns 401 and no events can be pushed out.",
    });
  }

  /**
   * POST /cmd/simulate-reply — fabricate an inbound reply from the operator's
   * test inbox and run it through the SAME classify → draft pipeline as a real
   * Brevo webhook. Lets the whole loop be exercised end-to-end with no mailbox.
   * Body: { sent_id?, lead_key?, from?, text } — needs at least one of
   * sent_id/lead_key and a non-empty text.
   */
  private async handleSimulateReply(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    let body: { sent_id?: number; lead_key?: string; from?: string; text?: string };
    try {
      body = await request.json() as any;
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const text = (body.text ?? "").trim();
    if (!text) return json({ error: "text is required" }, 400);

    let leadKey = (body.lead_key ?? "").trim();
    if (!leadKey && body.sent_id != null) {
      const row = (db as any).prepare("SELECT lead_key FROM sent_log WHERE id = ?").get(Number(body.sent_id)) as { lead_key: string } | undefined;
      leadKey = row?.lead_key ?? "";
    }
    const lead = leadKey ? getLead(db as any, leadKey) : undefined;
    if (!lead) return json({ error: "Lead not found (pass a lead_key or a sent_id from the sent log)" }, 404);

    const testRecipient = getTestRecipient(db as any);
    const from = (body.from ?? "").trim() || testRecipient || getFirstEmail(lead) || `test-${Date.now()}@example.invalid`;
    const messageId = `sim-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const subject = `Re: ${lead.pitch_subject ?? ""}`.trim();

    // Test mode: deliver the simulated reply as a REAL email to the test inbox,
    // quoted under the original pitch, so the whole back-and-forth thread is
    // visible in a real mailbox (internal use — Brevo only sends as the agent).
    let email: { to: string; subject: string; messageId: string } | null = null;
    let emailError: string | undefined;
    if (isTestMode(db as any) && testRecipient) {
      try {
        const quoted = (lead.pitch_body ?? "")
          .split("\n")
          .map((line) => `&gt; ${escapeHtml(line)}`)
          .join("<br>");
        const html = `<div><p>${escapeHtml(text)}</p><hr style="border:none;border-top:1px solid #ddd">${
          quoted ? `<p style="color:#6b7280;font-size:13px;margin-top:8px">${quoted}</p>` : ""
        }</div>`;
        const toName = testRecipient.split("@")[0] || "Test";
        const sent = await sendViaBrevo(testRecipient, toName, subject, html, env);
        email = { to: testRecipient, subject, messageId: sent.messageId };
      } catch (e: any) {
        emailError = e.message;
      }
    }

    const payload = {
      items: [
        {
          MessageId: messageId,
          From: { Address: from, Name: "" },
          Subject: subject,
          RawTextBody: text,
          SentAtDate: new Date().toISOString(),
          SpamScore: 0,
        },
      ],
    };

    const synthetic = new Request("http://internal.inbound/inbound-webhook", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const res = await handleInboundWebhook(synthetic, env, db as any);
    const result = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const emailNote = email
      ? `Real email delivered to ${email.to} (threaded under the pitch) — check your test inbox`
      : emailError
        ? `Simulated, but the real email failed: ${emailError}`
        : "Test mode off — simulation only, no real email sent";
    return withCors(json({
      ...result,
      email,
      ...(emailError ? { emailError } : {}),
      emailNote,
    }));
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
      "MANYCHAT_API_KEY",
      "MANYCHAT_WEBHOOK_TOKEN",
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

  private async handleCrawlStatus(env: Record<string, unknown>): Promise<Response> {
    const coreUrl = String(env.CORE_URL ?? "").replace(/\/$/, "");
    if (!coreUrl) {
      return json({ available: false, error: "CORE_URL not configured" });
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${coreUrl}/status`, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) return json({ available: false, error: `core ${res.status}` });
      return json({ available: true, ...(await res.json()) as object });
    } catch (e: any) {
      return json({ available: false, error: e.message ?? "unreachable" });
    }
  }

  /**
   * POST /cmd/sources/test {verticalId, source} — run one discovery source for
   *   the vertical (no verify/enrich/sync) and return a core task id.
   * GET /cmd/sources/test/:id — poll the test's state + candidate preview.
   * Thin proxies: the core does the work, both hops are fast (Workers 30s cap).
   */
  private async handleSourceTest(request: Request, env: Record<string, unknown>, db: CfSqlDatabase): Promise<Response> {
    const coreUrl = String(env.CORE_URL ?? "").replace(/\/$/, "");
    if (!coreUrl) return json({ error: "CORE_URL not configured" }, 503);
    const pathname = new URL(request.url).pathname;

    if (request.method === "POST" && pathname === "/cmd/sources/test") {
      let body: { verticalId?: string; vertical?: Record<string, unknown>; source?: string } = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.source) return json({ error: "source required" }, 400);
      // Accept a live pack (unsaved preview) or a stored vertical id.
      const vertical =
        body.vertical && typeof body.vertical === "object"
          ? body.vertical
          : body.verticalId
            ? (getVertical(db as any, body.verticalId) as unknown as Record<string, unknown>)
            : null;
      if (!vertical) return json({ error: "vertical (pack) or verticalId required" }, 400);
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 10_000);
      try {
        const res = await fetch(`${coreUrl}/v1/sources/test`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ vertical, source: body.source }),
          signal: ctrl.signal,
        });
        const data = (await res.json()) as { taskId?: string };
        if (!res.ok || !data.taskId) return json({ error: `core ${res.status}` }, 502);
        return json({ taskId: data.taskId });
      } catch (e) {
        return json({ error: `core unreachable: ${(e as Error).message}` }, 502);
      } finally {
        clearTimeout(t);
      }
    }

    const m = pathname.match(/^\/cmd\/sources\/test\/([^/]+)$/);
    if (request.method === "GET" && m) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5_000);
      try {
        const res = await fetch(`${coreUrl}/v1/sources/test/${m[1]}`, { signal: ctrl.signal });
        if (!res.ok) return json({ error: `core ${res.status}` }, res.status === 404 ? 404 : 502);
        return json((await res.json()) as object);
      } catch (e) {
        return json({ error: `core unreachable: ${(e as Error).message}` }, 502);
      } finally {
        clearTimeout(t);
      }
    }

    return json({ error: "Method not allowed" }, 405);
  }

  /**
   * AI Scraper Builder — thin proxies to the core (all hops fast; the core
   * does the LLM call / sandboxed run async and hands back a task id).
   *   POST /cmd/scrapers/generate {prompt} → {taskId}
   *   GET  /cmd/scrapers/generate/:id — poll the generated {id, description, code}
   *   POST /cmd/scrapers/test {code, vertical?} → {taskId}
   *   GET  /cmd/scrapers/test/:id — poll the sandboxed {ok, hits?|error?}
   *   POST /cmd/scrapers {id, description, code} → register (validated + persisted)
   *   GET  /cmd/scrapers → {scrapers: [{id, description, createdAt}]}
   *   DELETE /cmd/scrapers/:id → remove
   */
  private async handleScrapers(request: Request, env: Record<string, unknown>): Promise<Response> {
    const coreUrl = String(env.CORE_URL ?? "").replace(/\/$/, "");
    if (!coreUrl) return json({ error: "CORE_URL not configured" }, 503);
    const pathname = new URL(request.url).pathname;
    const proxy = async (
      path: string,
      method: string,
      body?: unknown,
      timeoutMs = 12_000,
    ): Promise<Response> => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const res = await fetch(`${coreUrl}${path}`, {
          method,
          headers: { "Content-Type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
          signal: ctrl.signal,
        });
        const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        return json(data, res.status === 204 ? 200 : res.status);
      } catch (e) {
        return json({ error: `core unreachable: ${(e as Error).message}` }, 502);
      } finally {
        clearTimeout(t);
      }
    };

    if (request.method === "POST" && pathname === "/cmd/scrapers/generate") {
      let body: { prompt?: string } = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.prompt || !body.prompt.trim()) return json({ error: "prompt required" }, 400);
      return proxy("/v1/scrapers/generate", "POST", { prompt: body.prompt.trim() }, 10_000);
    }

    const genMatch = pathname.match(/^\/cmd\/scrapers\/generate\/([^/]+)$/);
    if (request.method === "GET" && genMatch) {
      return proxy(`/v1/scrapers/generate/${genMatch[1]}`, "GET", undefined, 5_000);
    }

    if (request.method === "POST" && pathname === "/cmd/scrapers/test") {
      let body: { code?: string; vertical?: Record<string, unknown> } = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.code) return json({ error: "code required" }, 400);
      // vertical is optional — the core falls back to a minimal smoke-test pack.
      return proxy("/v1/scrapers/test", "POST", { code: body.code, vertical: body.vertical }, 10_000);
    }

    const testMatch = pathname.match(/^\/cmd\/scrapers\/test\/([^/]+)$/);
    if (request.method === "GET" && testMatch) {
      return proxy(`/v1/scrapers/test/${testMatch[1]}`, "GET", undefined, 5_000);
    }

    if (request.method === "POST" && pathname === "/cmd/scrapers") {
      let body: { id?: string; description?: string; code?: string } = {};
      try {
        body = await request.json();
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.id || !body.code) return json({ error: "id and code required" }, 400);
      return proxy("/v1/scrapers", "POST", body, 10_000);
    }

    if (request.method === "GET" && pathname === "/cmd/scrapers") {
      return proxy("/v1/scrapers", "GET", undefined, 5_000);
    }

    const delMatch = pathname.match(/^\/cmd\/scrapers\/([^/]+)$/);
    if (request.method === "DELETE" && delMatch) {
      return proxy(`/v1/scrapers/${delMatch[1]}`, "DELETE", undefined, 10_000);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  /**
   * GET /cmd/verticals — list all vertical packs.
   * POST /cmd/verticals — create or update one (body = the pack; id generated
   *   when absent).
   * DELETE /cmd/verticals?id=<id> — remove one.
   */
  private async handleVerticals(request: Request, db: CfSqlDatabase): Promise<Response> {
    if (request.method === "GET") {
      return json({ verticals: listVerticals(db as any) });
    }

    if (request.method === "POST") {
      let body: Partial<Vertical>;
      try {
        body = await request.json() as Partial<Vertical>;
      } catch {
        return json({ error: "Invalid JSON" }, 400);
      }
      if (!body.name || typeof body.name !== "string") {
        return json({ error: "name is required" }, 400);
      }
      const id =
        body.id && typeof body.id === "string"
          ? body.id
          : `v-${Date.now().toString(36)}`;
      const vertical: Vertical = {
        id,
        name: body.name,
        icp: body.icp ?? "",
        countries: Array.isArray(body.countries) ? body.countries.map(String) : [],
        dorks: Array.isArray(body.dorks) ? body.dorks.map(String) : [],
        cities: Array.isArray(body.cities) ? body.cities.map(String) : undefined,
        sicInclude: Array.isArray(body.sicInclude) ? body.sicInclude.map(String) : undefined,
        sicExclude: Array.isArray(body.sicExclude) ? body.sicExclude.map(String) : undefined,
        requireWebsite: body.requireWebsite ?? true,
        useRegistry: body.useRegistry ?? true,
        llmEnrich: body.llmEnrich ?? true,
        mxGuess: body.mxGuess ?? true,
        minScore: typeof body.minScore === "number" ? body.minScore : 50,
        perCountryLimit: typeof body.perCountryLimit === "number" ? body.perCountryLimit : 20,
        sources: Array.isArray(body.sources) ? body.sources.map(String) : undefined,
        probes: Array.isArray(body.probes) ? body.probes.map(String) : undefined,
        ccFilters: Array.isArray(body.ccFilters) ? body.ccFilters.map(String) : undefined,
        githubTopics: Array.isArray(body.githubTopics) ? body.githubTopics.map(String) : undefined,
        urlscanQueries: Array.isArray(body.urlscanQueries) ? body.urlscanQueries.map(String) : undefined,
        defillamaChains: Array.isArray(body.defillamaChains) ? body.defillamaChains.map(String) : undefined,
        registryWindowMonths: typeof body.registryWindowMonths === "number" ? body.registryWindowMonths : undefined,
        isDefault: body.isDefault ?? false,
      };
      if (vertical.countries.length === 0) {
        return json({ error: "at least one country is required" }, 400);
      }
      return json({ vertical: upsertVertical(db as any, vertical) });
    }

    if (request.method === "DELETE") {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return json({ error: "id is required" }, 400);
      const removed = deleteVertical(db as any, id);
      return removed ? json({ deleted: id }) : json({ error: "not found" }, 404);
    }

    return json({ error: "Method not allowed" }, 405);
  }

  private scheduleView(db: CfSqlDatabase): Array<Record<string, unknown>> {
    return SCHEDULE_MANIFEST.map((s) => ({
      name: s.name,
      description: s.description,
      cron: getSetting(db as any, `cron:${s.name}`) ?? s.cron,
      defaultCron: s.cron,
      enabled: getSetting(db as any, `cron_enabled:${s.name}`) !== "0",
      lastRun: getSetting(db as any, `cron_last_run:${s.name}`) ?? null,
    }));
  }

  private async handleSchedules(request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    if (request.method === "GET") {
      const paused = isPaused(db as any);
      return json({ schedules: this.scheduleView(db), paused, tickMinutes: SCHEDULE_TICK_MS / 60_000 });
    }
    if (request.method === "POST") {
      let body: { name?: string; cron?: string; enabled?: boolean };
      try {
        body = await request.json() as { name?: string; cron?: string; enabled?: boolean };
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
      // Update the stored schedule (no restart, no redeploy).
      if (typeof body.cron === "string" || typeof body.enabled === "boolean") {
        if (typeof body.cron === "string") {
          if (!isValidCron(body.cron)) {
            return json({ error: `Invalid cron expression: ${body.cron}` }, 400);
          }
          setSetting(db as any, `cron:${name}`, body.cron.trim());
        }
        if (typeof body.enabled === "boolean") {
          setSetting(db as any, `cron_enabled:${name}`, body.enabled ? "1" : "0");
        }
        return json({ updated: name, schedule: this.scheduleView(db).find((s) => s.name === name) });
      }
      // { name } only → run now.
      try {
        const result = await CRON_NAME_MAP[name](env, db as any);
        return json({ triggered: name, result });
      } catch (e: any) {
        return json({ error: e.message }, 500);
      }
    }
    return json({ error: "Method not allowed" }, 405);
  }

  /** POST /cmd/schedules/{name}/run — explicit run-now. */
  private async runScheduleNow(name: string, request: Request, db: CfSqlDatabase, env: Record<string, unknown>): Promise<Response> {
    const handler = CRON_NAME_MAP[name];
    if (!handler) {
      return json({ error: `Unknown cron: ${name}`, available: Object.keys(CRON_NAME_MAP) }, 404);
    }
    // Crawl run-now may pin a specific vertical: {verticalId}.
    let verticalId: string | undefined;
    if (name === "crawl") {
      try {
        const body = (await request.json()) as { verticalId?: string };
        if (body?.verticalId) verticalId = String(body.verticalId);
      } catch {
        /* no body — use default/legacy */
      }
    }
    try {
      const result =
        name === "crawl"
          ? await (handler as typeof crawlCron)(env, db as any, { verticalId, trigger: "manual" })
          : await handler(env, db as any);
      return json({ triggered: name, verticalId: verticalId ?? null, result });
    } catch (e: any) {
      return json({ error: e.message, cron: name }, 500);
    }
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
