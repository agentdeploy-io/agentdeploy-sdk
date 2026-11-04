/**
 * Channels HTTP surface + lifecycle.
 *
 * createChannelsApp(deps) builds the adapters/registry/bindings/notifier, stores
 * them in a module-level runtime, and returns a Hono sub-app to mount at
 * /channels. startChannels()/stopChannels() drive Telegram polling/webhook and
 * the ApprovalNotifier; channelsStatus() reports the live state.
 *
 * INTEGRATOR WIRING (see channels/README.md) — two lines + one after serve():
 *   import { createChannelsApp, startChannels, stopChannels } from "./channels/app.js";
 *   import { buildChannelsDeps } from "./channels/config.js";
 *   const channels = createChannelsApp(buildChannelsDeps(mastra, getCallaStore()));
 *   app.route("/channels", channels);
 *   // ...inside the serve() callback:
 *   startChannels();
 *
 * AUTH NOTE: /channels/telegram/webhook and /channels/whatsapp/webhook are
 * verified by their platform-native schemes (Telegram secret-token header,
 * WhatsApp HMAC) and MUST be exempt from the brain's Bearer auth; the other
 * routes (/bindings, /test/notify) should sit behind it.
 */
import { Hono } from "hono";
import { readConfig } from "./config.js";
import { InMemoryDecisionRegistry } from "./decisions.js";
import { CacheBindingStore } from "./bindings.js";
import { TelegramAdapter } from "./telegram.js";
import { WhatsAppAdapter } from "./whatsapp.js";
import { ApprovalNotifier } from "./notifier.js";
import type {
  ChannelAdapter,
  ChannelDeps,
  ChannelPlatform,
  ChannelsConfig,
} from "./types.js";
import type { TgUpdate } from "./telegram.js";
import { errorMessage, maskChatId } from "./util.js";

// ── Social (Instagram + TikTok + WhatsApp customers) ─────────────
import { resolveDynamicAgent } from "../mastra/dynamic-agents.js";
import { readSocialConfig, TIKTOK_REGION_WARNING } from "./social/config.js";
import { InstagramAdapter } from "./social/instagram.js";
import { TikTokAdapter } from "./social/tiktok.js";
import { WhatsAppSocialAdapter } from "./social/whatsapp.js";
import { RedditAdapter, startRedditPolling } from "./social/reddit.js";
import { enqueueSocialSend } from "./social/queue.js";
import { registerSocialSender } from "./social/senders.js";
import {
  defaultTriggers,
  handleSocialInbound,
  loadTriggers,
  saveTriggers,
} from "./social/engine.js";
import type {
  SocialAdapter,
  SocialConfig,
  SocialDeps,
  SocialInbound,
  SocialPlatform,
} from "./social/types.js";

// ── Meta Lead Forms (Facebook/Instagram Lead Ads) ────────────────
import {
  handleFacebookLeadgenWebhook,
  readFacebookConfig,
  validateFacebookSignature,
  verifyFacebookWebhook,
} from "./facebook.js";

export interface PlatformStatus {
  enabled: boolean;
  mode: "webhook" | "polling" | "off";
  webhookSet?: boolean;
  /** WhatsApp only: unbound chats are treated as customers (social engine). */
  customerMode?: boolean;
}

export interface SocialPlatformStatus {
  enabled: boolean;
  /** "polling" = Reddit (poller-driven, no webhook). */
  mode: "webhook" | "polling" | "off";
  /** Only set for TikTok — the region-gate notice operators must not miss. */
  regionWarning?: string;
}

export interface ChannelsStatus {
  enabled: boolean;
  platforms: {
    telegram: PlatformStatus;
    whatsapp: PlatformStatus;
    instagram: SocialPlatformStatus;
    tiktok: SocialPlatformStatus;
    reddit: SocialPlatformStatus;
  };
  bindings: number;
  social: { replyAgent: string; triggers: number; leadSync: boolean };
}

interface SocialRuntime {
  config: SocialConfig;
  deps: SocialDeps;
  instagram?: InstagramAdapter;
  tiktok?: TikTokAdapter;
  /** Reddit thread adapter (poller-driven; sidecar-backed). */
  reddit?: RedditAdapter;
  /** Stop the reddit inbound poller (set in startChannels). */
  stopRedditPolling?: () => void;
  /** Customer-conversation transport for the business WhatsApp line. */
  whatsapp?: WhatsAppSocialAdapter;
}

interface ChannelsRuntime {
  deps: ChannelDeps;
  config: ChannelsConfig;
  registry: InMemoryDecisionRegistry;
  bindings: CacheBindingStore;
  telegram?: TelegramAdapter;
  whatsapp?: WhatsAppAdapter;
  social: SocialRuntime;
  notifier: ApprovalNotifier;
  started: boolean;
}

let runtime: ChannelsRuntime | null = null;

function adapterFor(
  rt: ChannelsRuntime,
  platform: ChannelPlatform,
): ChannelAdapter | undefined {
  if (platform === "telegram") return rt.telegram;
  if (platform === "whatsapp") return rt.whatsapp;
  return undefined;
}

function telegramMode(rt: ChannelsRuntime): PlatformStatus["mode"] {
  if (!rt.telegram || !rt.config.telegram.enabled) return "off";
  return rt.config.telegram.webhookUrl ? "webhook" : "polling";
}

async function computeStatus(rt: ChannelsRuntime | null): Promise<ChannelsStatus> {
  if (!rt) {
    return {
      enabled: false,
      platforms: {
        telegram: { enabled: false, mode: "off" },
        whatsapp: { enabled: false, mode: "off" },
        instagram: { enabled: false, mode: "off" },
        tiktok: { enabled: false, mode: "off" },
        reddit: { enabled: false, mode: "off" },
      },
      bindings: 0,
      social: { replyAgent: "miles", triggers: 0, leadSync: false },
    };
  }
  const bindings = await rt.bindings.listBindings().catch(() => []);
  const tgMode = telegramMode(rt);
  const sc = rt.social.config;
  const triggers = await loadTriggers(rt.social.deps).catch(() => defaultTriggers());
  const triggerCount =
    triggers.instagram.length +
    triggers.tiktok.length +
    triggers.whatsapp.length +
    triggers.reddit.length;
  return {
    enabled:
      rt.config.telegram.enabled ||
      rt.config.whatsapp.enabled ||
      sc.instagram.enabled ||
      sc.tiktok.enabled ||
      sc.reddit.enabled,
    platforms: {
      telegram: {
        enabled: rt.config.telegram.enabled,
        mode: tgMode,
        ...(tgMode === "webhook" ? { webhookSet: rt.telegram?.webhookSet ?? false } : {}),
      },
      whatsapp: {
        enabled: rt.config.whatsapp.enabled,
        mode: rt.config.whatsapp.enabled ? "webhook" : "off",
        customerMode: sc.whatsapp.customerMode,
      },
      instagram: {
        enabled: sc.instagram.enabled,
        mode: sc.instagram.enabled ? "webhook" : "off",
      },
      tiktok: {
        enabled: sc.tiktok.enabled,
        mode: sc.tiktok.enabled ? "webhook" : "off",
        ...(sc.tiktok.enabled ? { regionWarning: TIKTOK_REGION_WARNING } : {}),
      },
      reddit: {
        enabled: sc.reddit.enabled,
        // Poller-driven (no webhook); cadence in pollMinutes from config.
        mode: sc.reddit.enabled ? "polling" : "off",
      },
    },
    bindings: bindings.length,
    social: {
      replyAgent: sc.replyAgent,
      triggers: triggerCount,
      leadSync: Boolean(sc.engineSyncUrl),
    },
  };
}

/** Build the /channels Hono sub-app and initialize the module runtime. */
export function createChannelsApp(deps: ChannelDeps): Hono {
  const config = readConfig();
  const registry = new InMemoryDecisionRegistry();
  const bindings = new CacheBindingStore(deps.store);

  // ── Social (Instagram + TikTok + WhatsApp customers) runtime ────
  // Built BEFORE the WhatsApp console adapter so its customer-mode handler
  // can close over the social deps.
  const socialConfig = readSocialConfig();
  const facebookConfig = readFacebookConfig();
  const socialInstagram = socialConfig.instagram.enabled
    ? new InstagramAdapter(socialConfig.instagram, deps.store)
    : undefined;
  const socialTiktok = socialConfig.tiktok.enabled
    ? new TikTokAdapter(socialConfig.tiktok)
    : undefined;
  // Reddit: enabled when the sidecar URL is set (REDDIT_MCP_URL). Reads work
  // keyless; replies need user creds ON THE SIDECAR, else the engine's
  // auto-send fails over to the approval path (degrade-to-human).
  const socialReddit = socialConfig.reddit.enabled
    ? new RedditAdapter(socialConfig.reddit)
    : undefined;
  // WhatsApp customer transport: reuse the Cloud API send config from the
  // channels config; enabled only when the platform can send AND customer
  // mode is on (otherwise the engine degrades sends to approval cards).
  const socialWhatsapp = new WhatsAppSocialAdapter(
    {
      apiBase: config.whatsapp.apiBase,
      ...(config.whatsapp.token ? { token: config.whatsapp.token } : {}),
      ...(config.whatsapp.phoneNumberId ? { phoneNumberId: config.whatsapp.phoneNumberId } : {}),
    },
    deps.store,
    config.whatsapp.enabled && socialConfig.whatsapp.customerMode,
  );

  const socialAdapters: Partial<Record<SocialPlatform, SocialAdapter>> = {};
  if (socialInstagram) socialAdapters.instagram = socialInstagram;
  if (socialTiktok) socialAdapters.tiktok = socialTiktok;
  if (socialReddit) socialAdapters.reddit = socialReddit;
  if (socialWhatsapp.enabled) socialAdapters.whatsapp = socialWhatsapp;

  const socialDeps: SocialDeps = {
    store: deps.store,
    registry,
    config: socialConfig,
    // Replies MUST come from the tenant's editable persona (dynamic agent).
    resolveAgent: (agentId) => resolveDynamicAgent(agentId),
    adapters: socialAdapters,
  };

  // Register per-platform senders so an approved social reply can be delivered
  // from the EXISTING Telegram/WhatsApp approval cards (decisions.executeDecision
  // → getSocialSender). Sends funnel through the shared rate-limited queue.
  if (socialInstagram) {
    const ig = socialInstagram;
    registerSocialSender("instagram", {
      send: (target, text, commentId) =>
        enqueueSocialSend("instagram", () =>
          commentId ? ig.sendPrivateReply(commentId, text) : ig.sendText(target, text),
        ),
    });
  }
  if (socialTiktok) {
    const tt = socialTiktok;
    registerSocialSender("tiktok", {
      send: (target, text) => enqueueSocialSend("tiktok", () => tt.sendText(target, text)),
    });
  }
  if (socialReddit) {
    const rd = socialReddit;
    registerSocialSender("reddit", {
      // commentId carries the parent thing id (t3_/t1_); fall back to target.
      send: (target, text, commentId) =>
        enqueueSocialSend("reddit", () =>
          commentId ? rd.sendPrivateReply(commentId, text) : rd.sendText(target, text),
        ),
    });
  }
  if (socialWhatsapp.enabled) {
    const wa = socialWhatsapp;
    registerSocialSender("whatsapp", {
      send: (target, text) => enqueueSocialSend("whatsapp", () => wa.sendText(target, text)),
    });
  }

  const telegram = config.telegram.enabled
    ? new TelegramAdapter(config, { registry, bindings })
    : undefined;
  const whatsapp = config.whatsapp.enabled
    ? new WhatsAppAdapter(config, {
        registry,
        bindings,
        // Unbound chats → the social engine (customer conversations). Bound
        // operator chats keep the console behavior EXACTLY (zero regression).
        customer: {
          enabled: socialConfig.whatsapp.customerMode,
          handle: (msg) => handleSocialInbound(msg, socialDeps),
        },
      })
    : undefined;

  const social: SocialRuntime = {
    config: socialConfig,
    deps: socialDeps,
    instagram: socialInstagram,
    tiktok: socialTiktok,
    reddit: socialReddit,
    whatsapp: socialWhatsapp.enabled ? socialWhatsapp : undefined,
  };

  const rt: ChannelsRuntime = {
    deps,
    config,
    registry,
    bindings,
    telegram,
    whatsapp,
    social,
    notifier: new ApprovalNotifier({
      deps,
      registry,
      bindings,
      getAdapter: (platform) =>
        platform === "telegram" ? telegram : platform === "whatsapp" ? whatsapp : undefined,
      edgeEventsUrl: config.edgeEventsUrl,
    }),
    started: false,
  };
  runtime = rt;

  const app = new Hono();

  // ── status ────────────────────────────────────────────────────
  app.get("/", async (c) => c.json(await computeStatus(rt)));

  // ── Telegram webhook ──────────────────────────────────────────
  app.post("/telegram/webhook", async (c) => {
    if (!telegram) return c.json({ error: "telegram not enabled" }, 404);
    const secret = config.telegram.webhookSecret;
    if (secret) {
      const header = c.req.header("X-Telegram-Bot-Api-Secret-Token");
      if (header !== secret) return c.json({ error: "unauthorized" }, 401);
    }
    const update = (await c.req.json().catch(() => null)) as TgUpdate | null;
    if (!update) return c.json({ error: "invalid body" }, 400);
    await telegram.handleWebhookUpdate(update, deps);
    return c.text("ok");
  });

  // ── WhatsApp webhook ──────────────────────────────────────────
  app.get("/whatsapp/webhook", (c) => {
    if (!whatsapp) return c.text("whatsapp not enabled", 404);
    const query: Record<string, string> = {};
    const url = new URL(c.req.url);
    url.searchParams.forEach((value, key) => {
      query[key] = value;
    });
    const challenge = whatsapp.verifyWebhook(query);
    if (challenge != null) return c.text(challenge);
    return c.text("Forbidden", 403);
  });

  app.post("/whatsapp/webhook", async (c) => {
    if (!whatsapp) return c.json({ error: "whatsapp not enabled" }, 404);
    const raw = await c.req.text();
    const signature = c.req.header("X-Hub-Signature-256");
    const check = whatsapp.verifySignature(raw, signature);
    if (!check.ok) return c.json({ error: "invalid signature" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    await whatsapp.handleWebhookEvent(body, deps);
    return c.json({ ok: true });
  });

  // ── Bindings ──────────────────────────────────────────────────
  app.post("/bindings/code", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { platform?: string } | null;
    const requested = body?.platform ?? c.req.query("platform");
    const platform: ChannelPlatform | undefined =
      requested === "telegram" || requested === "whatsapp" ? requested : undefined;
    try {
      const code = await bindings.createBindingCode(platform);
      return c.json({ code, expiresIn: 600 });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 500);
    }
  });

  app.get("/bindings", async (c) => {
    const list = await bindings.listBindings().catch(() => []);
    return c.json({
      bindings: list.map((b) => ({
        platform: b.platform,
        chatId: maskChatId(b.chatId),
        boundAt: b.boundAt,
      })),
      count: list.length,
    });
  });

  // ── Debug: push a test card to every bound chat ───────────────
  app.post("/test/notify", async (c) => {
    const body = (await c.req.json().catch(() => null)) as { text?: string } | null;
    const text = body?.text?.trim() || "🔔 Test notification from Calla channels.";
    const list = await bindings.listBindings().catch(() => []);
    let sent = 0;
    for (const b of list) {
      const adapter = adapterFor(rt, b.platform);
      if (!adapter) continue;
      try {
        await adapter.sendMessage(b.chatId, text);
        sent += 1;
      } catch (err) {
        console.warn(`[channels] test/notify to ${b.platform} failed:`, errorMessage(err));
      }
    }
    return c.json({ ok: true, sent, total: list.length });
  });

  // ── Social: Instagram webhook (auth-exempt; HMAC/verify-token) ──
  app.get("/instagram/webhook", (c) => {
    const ig = social.instagram;
    if (!ig) return c.text("instagram not enabled", 404);
    const challenge = ig.verifyWebhook(queryFromUrl(c.req.url));
    if (challenge != null) return c.text(challenge);
    return c.text("Forbidden", 403);
  });

  app.post("/instagram/webhook", async (c) => {
    const ig = social.instagram;
    if (!ig) return c.json({ error: "instagram not enabled" }, 404);
    const raw = await c.req.text();
    const check = ig.validateSignature(raw, {
      "x-hub-signature-256": c.req.header("X-Hub-Signature-256"),
    });
    if (!check.ok) return c.json({ error: "invalid signature" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const events = ig.parseWebhook(body);
    for (const msg of events) {
      await handleSocialInbound(msg, social.deps).catch((err) =>
        console.warn("[channels:social] instagram inbound failed:", errorMessage(err)),
      );
    }
    return c.json({ ok: true, received: events.length });
  });

  // ── Social: TikTok webhook (auth-exempt; challenge/body-token) ──
  app.get("/tiktok/webhook", (c) => {
    const tt = social.tiktok;
    if (!tt) return c.text("tiktok not enabled", 404);
    const challenge = tt.verifyWebhook(queryFromUrl(c.req.url));
    if (challenge != null) return c.text(challenge);
    return c.text("Forbidden", 403);
  });

  app.post("/tiktok/webhook", async (c) => {
    const tt = social.tiktok;
    if (!tt) return c.json({ error: "tiktok not enabled" }, 404);
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    // body-token handshake (TIKTOK_WEBHOOK_MODE=body): echo the challenge.
    if (tt.verificationMode === "body") {
      const challenge = tt.verifyWebhookBody(body);
      if (challenge != null) return c.text(challenge);
    }
    const events = tt.parseWebhook(body);
    for (const msg of events) {
      await handleSocialInbound(msg, social.deps).catch((err) =>
        console.warn("[channels:social] tiktok inbound failed:", errorMessage(err)),
      );
    }
    return c.json({ ok: true, received: events.length });
  });

  // ── Meta Lead Forms webhook (auth-exempt; verify-token + HMAC) ──
  // GET: hub.challenge echo. POST: leadgen changes → full-lead fetch →
  // engine lead sync (FB:<leadgen_id>) → prefilled qualification flow.
  // NEVER fails: best-effort processing, always 200 to Meta.
  app.get("/facebook/webhook", (c) => {
    const challenge = verifyFacebookWebhook(queryFromUrl(c.req.url), facebookConfig);
    if (challenge != null) return c.text(challenge);
    return c.text("Forbidden", 403);
  });

  app.post("/facebook/webhook", async (c) => {
    const raw = await c.req.text();
    const check = validateFacebookSignature(raw, c.req.header("X-Hub-Signature-256"), facebookConfig);
    if (!check.ok) return c.json({ error: "invalid signature" }, 401);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      // Unparseable but signed — acknowledge so Meta does not retry-storm.
      return c.json({ ok: true, processed: 0, error: "invalid body" });
    }
    const result = await handleFacebookLeadgenWebhook(body, {
      store: deps.store,
      config: facebookConfig,
    }).catch((err) => {
      console.warn("[channels:facebook] leadgen processing failed:", errorMessage(err));
      return { processed: 0, captured: 0, flowsStarted: 0, duplicates: 0, results: [] };
    });
    return c.json({ ok: true, ...result });
  });

  // ── Social: IG code → token exchange helper (behind auth) ──────
  // Instagram API with Instagram Login OAuth: exchange the ?code= from the
  // redirect for a short-lived token, then upgrade to a ~60-day long-lived
  // token. Store the returned `longLivedToken` as IG_ACCESS_TOKEN.
  app.post("/instagram/exchange", async (c) => {
    const ig = social.config.instagram;
    const body = (await c.req.json().catch(() => null)) as
      | { code?: string; redirect_uri?: string }
      | null;
    const code = body?.code?.trim();
    if (!code) return c.json({ error: "code is required" }, 400);
    if (!ig.appId || !ig.appSecret) {
      return c.json({ error: "IG_APP_ID + IG_APP_SECRET must be set" }, 400);
    }
    const redirectUri = body?.redirect_uri?.trim() || ig.redirectUri;
    if (!redirectUri) return c.json({ error: "redirect_uri is required" }, 400);
    try {
      // 1) authorization code → short-lived token.
      const form = new URLSearchParams({
        client_id: ig.appId,
        client_secret: ig.appSecret,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
        code,
      });
      const shortRes = await fetch(`${ig.apiBase}/access_token`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      });
      const shortJson = (await shortRes.json().catch(() => null)) as
        | { access_token?: string; user_id?: string | number; error?: unknown }
        | null;
      if (!shortRes.ok || !shortJson?.access_token) {
        return c.json(
          { error: "code exchange failed", status: shortRes.status, detail: shortJson ?? null },
          502,
        );
      }
      // 2) short-lived → long-lived (ig_exchange_token).
      const longUrl =
        `${ig.apiBase}/access_token?grant_type=ig_exchange_token` +
        `&client_secret=${encodeURIComponent(ig.appSecret)}` +
        `&access_token=${encodeURIComponent(shortJson.access_token)}`;
      const longRes = await fetch(longUrl, { method: "GET" });
      const longJson = (await longRes.json().catch(() => null)) as
        | { access_token?: string; expires_in?: number; user_id?: string | number }
        | null;
      return c.json({
        userId: longJson?.user_id ?? shortJson.user_id ?? null,
        shortLivedToken: shortJson.access_token,
        longLivedToken: longRes.ok ? (longJson?.access_token ?? null) : null,
        expiresIn: longJson?.expires_in ?? null,
        note: "Store longLivedToken as IG_ACCESS_TOKEN (~60-day validity; re-exchange before expiry).",
      });
    } catch (err) {
      return c.json({ error: errorMessage(err) }, 502);
    }
  });

  // ── Social: trigger config (behind auth) ───────────────────────
  app.get("/social/triggers", async (c) => {
    const cfg = await loadTriggers(social.deps);
    return c.json(cfg);
  });

  app.put("/social/triggers", async (c) => {
    const body = await c.req.json().catch(() => null);
    const res = await saveTriggers(social.deps, body);
    if (!res.ok) return c.json({ error: res.error }, 400);
    await deps.store
      .appendAudit({
        agentId: "social",
        kind: "social.triggers.updated",
          entry: {
            instagram: res.config.instagram.length,
            tiktok: res.config.tiktok.length,
            whatsapp: res.config.whatsapp.length,
            reddit: res.config.reddit.length,
            fallback: res.config.fallback,
          },
      })
      .catch((err) =>
        console.warn("[channels:social] triggers audit failed:", errorMessage(err)),
      );
    return c.json({ ok: true, config: res.config });
  });

  // ── Social: synthetic QA event (behind auth) ───────────────────
  app.post("/social/test", async (c) => {
    const body = (await c.req.json().catch(() => null)) as Partial<SocialInbound> | null;
    const platform: SocialPlatform | undefined =
      body?.platform === "instagram" ||
      body?.platform === "tiktok" ||
      body?.platform === "whatsapp" ||
      body?.platform === "reddit"
        ? body.platform
        : undefined;
    if (!platform) {
      return c.json(
        { error: "platform must be 'instagram' | 'tiktok' | 'whatsapp' | 'reddit'" },
        400,
      );
    }
    const kind: SocialInbound["kind"] =
      body?.kind === "comment" ||
      body?.kind === "postback" ||
      body?.kind === "story_mention"
        ? body.kind
        : "dm";
    const msg: SocialInbound = {
      platform,
      kind,
      externalUserId: String(body?.externalUserId ?? "test-user"),
      text: String(body?.text ?? ""),
      ...(body?.username ? { username: String(body.username) } : {}),
      ...(body?.commentId ? { commentId: String(body.commentId) } : {}),
      ts: Date.now(),
      raw: { synthetic: true },
    };
    await handleSocialInbound(msg, social.deps).catch((err) =>
      console.warn("[channels:social] /social/test failed:", errorMessage(err)),
    );
    return c.json({ ok: true, handled: msg });
  });

  return app;
}

/** Collect a request URL's query params into a plain record. */
function queryFromUrl(url: string): Record<string, string> {
  const query: Record<string, string> = {};
  try {
    new URL(url).searchParams.forEach((value, key) => {
      query[key] = value;
    });
  } catch {
    // ignore malformed URL
  }
  return query;
}

/** Start Telegram polling/webhook + the notifier. Idempotent. */
export function startChannels(): void {
  if (!runtime) {
    console.warn("[channels] startChannels() called before createChannelsApp() — ignoring");
    return;
  }
  if (runtime.started) return;
  runtime.started = true;

  const { config, telegram, deps, notifier } = runtime;

  if (telegram) {
    if (config.telegram.webhookUrl) {
      telegram
        .setWebhook(config.telegram.webhookUrl, config.telegram.webhookSecret)
        .then(() => console.log("[channels] telegram webhook set:", config.telegram.webhookUrl))
        .catch((err) =>
          console.warn("[channels] telegram setWebhook failed:", errorMessage(err)),
        );
    } else {
      telegram.startPolling(deps);
    }
  }

  if (config.telegram.enabled || config.whatsapp.enabled) {
    try {
      notifier.start();
    } catch (err) {
      console.warn("[channels] notifier start failed:", errorMessage(err));
    }
  }

  // Reddit inbound poller (reddit has no webhook). No-ops when the platform
  // is disabled (no REDDIT_MCP_URL) and degrades to a warning if the sidecar
  // is unreachable or lacks user creds.
  if (runtime.social.reddit?.enabled) {
    runtime.social.stopRedditPolling = startRedditPolling(
      runtime.social.deps,
      runtime.social.config.reddit.pollMinutes,
    );
  }

  console.log(
    `[channels] started (telegram: ${telegramMode(runtime)}, whatsapp: ${
      config.whatsapp.enabled
        ? runtime.social.config.whatsapp.customerMode
          ? "webhook+customer"
          : "webhook"
        : "off"
    }, instagram: ${runtime.social.config.instagram.enabled ? "webhook" : "off"}, tiktok: ${
      runtime.social.config.tiktok.enabled ? "webhook" : "off"
    }, reddit: ${runtime.social.config.reddit.enabled ? `poll/${runtime.social.config.reddit.pollMinutes}m` : "off"})`,
  );
}

/** Stop Telegram polling + close the notifier WS. Idempotent. */
export function stopChannels(): void {
  if (!runtime) return;
  runtime.telegram?.stopPolling();
  try {
    runtime.social.stopRedditPolling?.();
    runtime.social.stopRedditPolling = undefined;
  } catch (err) {
    console.warn("[channels] reddit poller stop failed:", errorMessage(err));
  }
  try {
    runtime.notifier.stop();
  } catch (err) {
    console.warn("[channels] notifier stop failed:", errorMessage(err));
  }
  runtime.started = false;
}

/** Live status snapshot (also served by GET /channels). */
export async function channelsStatus(): Promise<ChannelsStatus> {
  return computeStatus(runtime);
}
