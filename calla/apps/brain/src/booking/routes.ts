/**
 * Booking HTTP surface — createBookingApp({ store }) builds a Hono sub-app
 * mounted at /booking (channels/app.ts composition pattern).
 *
 * Route map:
 *   GET    /                                 provider/config status
 *   GET    /reps            POST /reps       list / create
 *   PUT    /reps/:repId     DELETE /reps/:repId
 *   GET    /policy          PUT  /policy
 *   POST   /connect/:provider/start          → { authUrl, state } (google|microsoft)
 *   POST   /connect/calendly/link            { repId, schedulingLink, eventTypeUri? }
 *   GET    /connect/:provider/callback       code+state → tokens → HTML (auth-exempt)
 *   GET    /availability?repId&from&to       { slots } | { link } (calendly)
 *   POST   /appointments                     provider create + audit
 *   GET    /appointments?repId&days          aggregated upcoming (best-effort)
 *   DELETE /appointments/:id?repId=
 *   POST   /webhook/calendly                 X-Signature HMAC (auth-exempt)
 *   GET|POST /webhook/google                 sync/reachability (auth-exempt)
 *   POST   /webhook/microsoft                validationToken echo + clientState (auth-exempt)
 *
 * GDPR posture (Ireland): attendee data is minimized (name + optional email/
 * phone only), tokens live in the durable store (never in logs/audit), and
 * the audit chain records ids/times — not raw attendee contact details beyond
 * the name needed for the survey event title.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { CallaStore } from "../store/types.js";
import {
  buildAuthUrl,
  exchangeCode,
  fetchProfile,
  makeStateRecord,
  randomOAuthState,
  readBookingConfig,
} from "./oauth.js";
import {
  DEFAULT_POLICY,
  DEFAULT_TIMEZONE,
  BookingStore,
} from "./store.js";
import { googleRegisterWatch } from "./providers/google.js";
import { msCreateSubscription } from "./providers/microsoft.js";
import {
  calendlyAppointment,
  matchRepForEventType,
  parseCalendlyWebhook,
  verifyCalendlySignature,
} from "./providers/calendly.js";
import {
  BookingApiError,
  type BookingProvider,
} from "./types.js";
import { getBackend } from "./backend.js";
import { mcpSurfaceStatus } from "./mcp-server.js";

/**
 * Map a BookingApiError (thrown by the shared booking service/backend) to the
 * HTTP response shape the REST contract has always used, so delegating the
 * handlers to the dual backend is byte-compatible for existing callers (UI,
 * flows, voice agent).
 */
function bookingErrorResponse(c: import("hono").Context, err: unknown) {
  if (err instanceof BookingApiError) {
    const status = err.status ?? 502;
    return c.json(
      {
        error: err.message,
        ...(err.detail ? { detail: err.detail.slice(0, 300) } : {}),
        ...(status === 409 ? { reconnectRequired: true } : {}),
      },
      status as 400 | 404 | 409 | 502,
    );
  }
  return c.json(
    { error: "booking failed", detail: errorMessage(err).slice(0, 300) },
    502,
  );
}

export interface BookingAppDeps {
  store: CallaStore;
}

// ─── Schemas ─────────────────────────────────────────────────────

const workHoursSchema = z.object({
  days: z.array(z.number().int().min(0).max(6)).min(1),
  start: z.string().regex(/^\d{2}:\d{2}$/),
  end: z.string().regex(/^\d{2}:\d{2}$/),
});

const createRepSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/).optional(),
  name: z.string().min(1).max(120),
  email: z.string().min(3).max(200),
  provider: z.enum(["calendly", "google", "microsoft"]),
  schedulingLink: z.string().url().optional(),
  eventTypeUri: z.string().max(500).optional(),
  timezone: z.string().max(100).optional(),
  workHours: workHoursSchema.optional(),
  slotMinutes: z.number().int().min(5).max(480).optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  enabled: z.boolean().optional(),
});

const updateRepSchema = createRepSchema
  .omit({ provider: true, id: true })
  .partial()
  .extend({ provider: z.never().optional() });

const policySchema = z.object({
  slotMinutes: z.number().int().min(5).max(480).optional(),
  bufferMinutes: z.number().int().min(0).max(240).optional(),
  workHours: workHoursSchema.optional(),
  timezone: z.string().max(100).optional(),
  maxBookingsPerDay: z.number().int().min(1).max(100).nullable().optional(),
});

const connectStartSchema = z.object({ repId: z.string().min(1) });

const calendlyLinkSchema = z.object({
  repId: z.string().min(1),
  schedulingLink: z.string().url(),
  eventTypeUri: z.string().max(500).optional(),
});

const attendeeSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
});

const createAppointmentSchema = z.object({
  repId: z.string().min(1),
  start: z.string().min(1),
  end: z.string().min(1).optional(),
  attendee: attendeeSchema,
  context: z
    .object({
      leadKey: z.string().max(200).optional(),
      propertyAddress: z.string().max(500).optional(),
      notes: z.string().max(2000).optional(),
    })
    .optional(),
});

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

async function parseBody<T extends z.ZodType>(
  schema: T,
  c: { req: { json(): Promise<unknown> } },
) {
  const raw = await c.req.json().catch(() => null);
  return schema.safeParse(raw);
}

// ─── HTML pages (OAuth callback) ────────────────────────────────

function page(title: string, bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · Calla Booking</title>
<style>
  body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; background: #f6f7f9;
         display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #fff; border-radius: 12px; padding: 40px 48px; max-width: 480px;
          box-shadow: 0 4px 24px rgba(0,0,0,.08); text-align: center; }
  h1 { font-size: 22px; margin: 0 0 12px; color: #14231c; }
  p { color: #4b5563; line-height: 1.55; margin: 8px 0; }
  .ok { color: #0f7a4d; } .err { color: #b42318; }
  code { background: #f3f4f6; padding: 2px 6px; border-radius: 4px; font-size: 12px; }
</style>
</head>
<body><div class="card">${bodyHtml}</div></body>
</html>`;
}

function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) =>
    ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;",
  );
}

// ─── App factory ─────────────────────────────────────────────────

export function createBookingApp(deps: BookingAppDeps): Hono {
  const bs = new BookingStore(deps.store);
  // Single booking core shared by REST (here) and MCP (mcp-server.ts); the
  // backend selector honours BOOKING_BACKEND=native|mcp|both for BOTH.
  const backend = getBackend(bs);
  const app = new Hono();

  const PROVIDERS = ["calendly", "google", "microsoft"] as const;
  const isProvider = (v: string): v is BookingProvider =>
    (PROVIDERS as readonly string[]).includes(v);

  // ── Status ────────────────────────────────────────────────────

  app.get("/", async (c) => {
    const cfg = readBookingConfig();
    const [reps, policy, connections] = await Promise.all([
      bs.listReps(),
      bs.getPolicy(),
      bs.listConnections(),
    ]);
    return c.json({
      service: "calla-booking",
      timezone: DEFAULT_TIMEZONE,
      providers: {
        google: {
          configured: Boolean(cfg.google.clientId && cfg.google.clientSecret),
          redirectUri: cfg.google.redirectUri,
          apiBase: cfg.google.apiBase,
          oauthBase: cfg.google.oauthBase,
        },
        microsoft: {
          configured: Boolean(cfg.microsoft.clientId && cfg.microsoft.clientSecret),
          tenantId: cfg.microsoft.tenantId,
          redirectUri: cfg.microsoft.redirectUri,
          graphBase: cfg.microsoft.graphBase,
        },
        calendly: {
          // No OAuth needed: webhook secret enables inbound, token enables API.
          configured: Boolean(cfg.calendly.webhookSecret),
          webhookConfigured: Boolean(cfg.calendly.webhookSecret),
          apiTokenConfigured: Boolean(cfg.calendly.accessToken),
          apiBase: cfg.calendly.apiBase,
        },
      },
      webhookSecretConfigured: Boolean(cfg.webhookSecret),
      reps: reps.map((r) => ({
        id: r.id,
        name: r.name,
        provider: r.provider,
        enabled: r.enabled,
        connected: r.provider === "calendly" ? Boolean(r.schedulingLink) : Boolean(r.accountId),
      })),
      connections: connections.length,
      policy,
      // Dual-booking: which backend serves ops + whether the Calla-hosted
      // booking MCP surface is enabled (see mcp-server.ts).
      backend: backend.modeName,
      mcp: mcpSurfaceStatus(),
    });
  });

  // ── Reps CRUD ─────────────────────────────────────────────────

  app.get("/reps", async (c) => {
    const reps = await bs.listReps();
    return c.json({ reps, total: reps.length });
  });

  app.post("/reps", async (c) => {
    const parsed = await parseBody(createRepSchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    if (!isProvider(parsed.data.provider)) {
      return c.json({ error: `unknown provider: ${parsed.data.provider}` }, 400);
    }
    const [rep, err] = await bs.createRep(parsed.data);
    if (!rep) return c.json({ error: err ?? "invalid rep" }, 400);
    return c.json({ rep }, 201);
  });

  app.put("/reps/:repId", async (c) => {
    const repId = c.req.param("repId");
    const parsed = await parseBody(updateRepSchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const [rep, err] = await bs.updateRep(repId, parsed.data);
    if (!rep) {
      const status = err?.startsWith("unknown rep") ? 404 : 400;
      return c.json({ error: err ?? "invalid rep" }, status as 404 | 400);
    }
    return c.json({ rep });
  });

  app.delete("/reps/:repId", async (c) => {
    const repId = c.req.param("repId");
    const removed = await bs.deleteRep(repId);
    if (!removed) return c.json({ error: `unknown rep: ${repId}` }, 404);
    return c.json({ ok: true, rep: removed });
  });

  // ── Policy ────────────────────────────────────────────────────

  app.get("/policy", async (c) => {
    const policy = await bs.getPolicy();
    return c.json({ policy, defaults: DEFAULT_POLICY });
  });

  app.put("/policy", async (c) => {
    const parsed = await parseBody(policySchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const [policy, err] = await bs.putPolicy(parsed.data);
    if (!policy) return c.json({ error: err ?? "invalid policy" }, 400);
    return c.json({ policy });
  });

  // ── OAuth: start ──────────────────────────────────────────────

  app.post("/connect/:provider/start", async (c) => {
    const provider = c.req.param("provider");
    if (provider === "calendly") {
      return c.json(
        { error: "calendly does not use OAuth — use POST /booking/connect/calendly/link" },
        400,
      );
    }
    if (provider !== "google" && provider !== "microsoft") {
      return c.json({ error: `unknown provider: ${provider}` }, 400);
    }
    const parsed = await parseBody(connectStartSchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const rep = await bs.getRep(parsed.data.repId);
    if (!rep) return c.json({ error: `unknown rep: ${parsed.data.repId}` }, 404);
    if (rep.provider !== provider) {
      return c.json(
        { error: `rep "${rep.id}" uses provider "${rep.provider}", not "${provider}"` },
        400,
      );
    }

    const cfg = readBookingConfig();
    const pcfg = provider === "google" ? cfg.google : cfg.microsoft;
    if (!pcfg.clientId || !pcfg.clientSecret) {
      return c.json(
        {
          error: `${provider} OAuth is not configured — set ${
            provider === "google"
              ? "GOOGLE_OAUTH_CLIENT_ID + GOOGLE_OAUTH_CLIENT_SECRET"
              : "MICROSOFT_CLIENT_ID + MICROSOFT_CLIENT_SECRET"
          }`,
        },
        400,
      );
    }

    // Random state, cached 10 min (single-use; consumed by the callback).
    const state = randomOAuthState();
    await bs.putState(state, makeStateRecord(provider, rep.id, pcfg.redirectUri));
    const authUrl = buildAuthUrl(provider, cfg, state);
    return c.json({ authUrl, state, repId: rep.id, expiresIn: 600 });
  });

  // ── Calendly: link a rep (no OAuth) ───────────────────────────

  app.post("/connect/calendly/link", async (c) => {
    const parsed = await parseBody(calendlyLinkSchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const rep = await bs.getRep(parsed.data.repId);
    if (!rep) return c.json({ error: `unknown rep: ${parsed.data.repId}` }, 404);
    if (rep.provider !== "calendly") {
      return c.json(
        { error: `rep "${rep.id}" uses provider "${rep.provider}" — calendly link is for calendly reps` },
        400,
      );
    }
    const [updated, err] = await bs.updateRep(rep.id, {
      schedulingLink: parsed.data.schedulingLink,
      ...(parsed.data.eventTypeUri ? { eventTypeUri: parsed.data.eventTypeUri } : {}),
    });
    if (!updated) return c.json({ error: err ?? "update failed" }, 400);
    await bs.audit("booking.connected", {
      provider: "calendly",
      repId: rep.id,
      schedulingLink: updated.schedulingLink ?? null,
      eventTypeUri: updated.eventTypeUri ?? null,
    });
    return c.json({ ok: true, rep: updated });
  });

  // ── OAuth: callback (auth-exempt; state is the CSRF guard) ────

  app.get("/connect/:provider/callback", async (c) => {
    const provider = c.req.param("provider");
    if (provider !== "google" && provider !== "microsoft") {
      return c.html(page("Bad request", `<h1 class="err">Unknown provider</h1><p>${escapeHtml(provider)}</p>`), 400);
    }
    const code = c.req.query("code") ?? "";
    const state = c.req.query("state") ?? "";
    const oauthError = c.req.query("error");
    if (oauthError) {
      return c.html(
        page(
          "Sign-in cancelled",
          `<h1 class="err">Authorization failed</h1><p>${escapeHtml(oauthError)}</p><p>You can close this window and try again.</p>`,
        ),
        400,
      );
    }
    if (!code || !state) {
      return c.html(
        page("Bad request", `<h1 class="err">Missing code/state</h1><p>Start the flow again from the Booking screen.</p>`),
        400,
      );
    }

    const record = await bs.consumeState(state);
    if (!record || record.provider !== provider) {
      return c.html(
        page(
          "Link expired",
          `<h1 class="err">Invalid or expired sign-in link</h1>
           <p>OAuth states are single-use and last 10 minutes. Start the connection again.</p>`,
        ),
        400,
      );
    }

    const cfg = readBookingConfig();
    try {
      const tokens = await exchangeCode(provider, cfg, code, record.redirectUri);
      const profile = await fetchProfile(provider, cfg, tokens.accessToken);
      const rep = await bs.getRep(record.repId);
      const accountId =
        profile.accountId ??
        // Fallback: deterministic-per-rep id so reconnects overwrite cleanly.
        `${provider}-${record.repId}`;

      await bs.putConnection({
        provider,
        accountId,
        accessToken: tokens.accessToken,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        ...(tokens.expiresAt ? { expiresAt: tokens.expiresAt } : {}),
        ...(profile.email ? { email: profile.email } : {}),
        repId: record.repId,
        createdAt: new Date().toISOString(),
      });
      if (rep && rep.provider === provider) {
        await bs.updateRep(rep.id, { accountId });
      }

      // Best-effort push registration when a public URL is configured:
      // Google events watch / Graph subscription (both self-verify against
      // the webhook routes; see provider docs for sync + expiry semantics).
      if (cfg.publicUrlExplicit) {
        try {
          const conn = await bs.getConnection(provider, accountId);
          if (conn) {
            if (provider === "google") {
              await googleRegisterWatch(
                cfg.google,
                conn,
                `${cfg.publicUrl}/booking/webhook/google`,
                cfg.webhookSecret || undefined,
              );
            } else {
              await msCreateSubscription(
                cfg.microsoft,
                conn,
                `${cfg.publicUrl}/booking/webhook/microsoft`,
              );
            }
          }
        } catch (err) {
          console.warn(`[booking] ${provider} push registration failed:`, errorMessage(err));
        }
      }

      await bs.audit("booking.connected", {
        provider,
        repId: record.repId,
        accountId,
        email: profile.email ?? null,
      });

      const who = rep ? escapeHtml(rep.name) : escapeHtml(record.repId);
      return c.html(
        page(
          "Calendar connected",
          `<h1 class="ok">✓ Calendar connected</h1>
           <p><strong>${who}</strong> is now linked to ${provider === "google" ? "Google Calendar" : "Microsoft 365 Calendar"}.</p>
           <p>Account id: <code>${escapeHtml(accountId)}</code></p>
           <p>You can close this window and continue in Calla.</p>`,
        ),
      );
    } catch (err) {
      const detail = err instanceof BookingApiError ? err.detail ?? err.message : errorMessage(err);
      console.error(`[booking] ${provider} OAuth callback failed:`, detail);
      return c.html(
        page(
          "Connection failed",
          `<h1 class="err">Connection failed</h1>
           <p>${escapeHtml(detail.slice(0, 300))}</p>
           <p>Close this window and start the connection again.</p>`,
        ),
        502,
      );
    }
  });

  // ── Availability ──────────────────────────────────────────────

  app.get("/availability", async (c) => {
    const repId = c.req.query("repId");
    if (!repId) return c.json({ error: "repId query parameter is required" }, 400);
    const from = c.req.query("from") ?? undefined;
    const to = c.req.query("to") ?? undefined;
    try {
      const result = await backend.getAvailability({
        repId,
        ...(from ? { from } : {}),
        ...(to ? { to } : {}),
      });
      if (result.kind === "link") {
        return c.json({ repId: result.repId, provider: "calendly", link: result.link });
      }
      return c.json({
        repId: result.repId,
        provider: result.provider,
        timezone: result.timezone,
        from: result.from,
        to: result.to,
        slots: result.slots,
        count: result.count,
      });
    } catch (err) {
      return bookingErrorResponse(c, err);
    }
  });

  // ── Appointments ──────────────────────────────────────────────

  app.post("/appointments", async (c) => {
    const parsed = await parseBody(createAppointmentSchema, c);
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const input = parsed.data;
    try {
      const result = await backend.bookAppointment({
        repId: input.repId,
        start: input.start,
        ...(input.end ? { end: input.end } : {}),
        attendee: input.attendee,
        ...(input.context ? { context: input.context } : {}),
      });
      if (result.calendlyHandoff) {
        return c.json(
          {
            error: "calendly reps cannot be booked via this API — share the scheduling link; the webhook records the booking",
            link: result.link ?? null,
          },
          400,
        );
      }
      return c.json(
        {
          appointment: result.appointment,
          ...(result.link ? { link: result.link } : {}),
          ...(result.meetingUrl ? { meetingUrl: result.meetingUrl } : {}),
          ...(result.addToCalendarUrl ? { addToCalendarUrl: result.addToCalendarUrl } : {}),
        },
        201,
      );
    } catch (err) {
      return bookingErrorResponse(c, err);
    }
  });

  app.get("/appointments", async (c) => {
    const repId = c.req.query("repId") ?? undefined;
    const daysRaw = Number(c.req.query("days") ?? "");
    const days = Number.isFinite(daysRaw) && daysRaw >= 1 ? Math.min(Math.trunc(daysRaw), 90) : 7;
    try {
      const result = await backend.listAppointments({ ...(repId ? { repId } : {}), days });
      return c.json(result);
    } catch (err) {
      return bookingErrorResponse(c, err);
    }
  });

  app.delete("/appointments/:id", async (c) => {
    const appointmentId = c.req.param("id");
    const repId = c.req.query("repId") ?? undefined;
    try {
      const result = await backend.cancelAppointment({
        id: appointmentId,
        ...(repId ? { repId } : {}),
      });
      return c.json(result);
    } catch (err) {
      return bookingErrorResponse(c, err);
    }
  });

  // ── Webhooks (auth-exempt — each self-verifies) ───────────────

  // Calendly: X-Signature = hex HMAC-SHA256(raw body, CALENDLY_WEBHOOK_SECRET).
  app.post("/webhook/calendly", async (c) => {
    const cfg = readBookingConfig();
    if (!cfg.calendly.webhookSecret) {
      return c.json({ error: "CALENDLY_WEBHOOK_SECRET not configured" }, 400);
    }
    const raw = await c.req.text();
    const signature = c.req.header("X-Signature");
    if (!verifyCalendlySignature(raw, signature, cfg.calendly.webhookSecret)) {
      return c.json({ error: "invalid signature" }, 401);
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }

    const parsed = parseCalendlyWebhook(body);
    if (!parsed) {
      // Unknown/irrelevant Calendly event type — acknowledge and move on.
      return c.json({ ok: true, ignored: true });
    }

    const reps = await bs.listReps();
    const rep = matchRepForEventType(
      reps.filter((r) => r.provider === "calendly"),
      parsed.eventTypeUri,
    );
    if (!rep) {
      await bs.audit("booking.webhook", {
        provider: "calendly",
        event: parsed.kind,
        eventTypeUri: parsed.eventTypeUri,
        matched: false,
      });
      return c.json({ ok: true, matched: false });
    }

    const appointment = calendlyAppointment(parsed, rep.id);
    await bs.saveInvitee(appointment);
    await bs.audit("booking.webhook", {
      provider: "calendly",
      event: parsed.kind,
      appointmentId: appointment.id,
      repId: rep.id,
      start: appointment.start,
      matched: true,
    });
    return c.json({
      ok: true,
      matched: true,
      repId: rep.id,
      appointment,
    });
  });

  // Google: GET → 200 reachability check; POST → channel notifications.
  // SYNC VERIFICATION: after POST events/watch, Google immediately sends a
  // "sync" notification (X-Goog-Resource-State: sync, empty body) which we
  // answer 200 to; the channel token (BOOKING_WEBHOOK_SECRET) is verified
  // when configured. Renew the watch before its ≤7-day ttl expires.
  app.get("/webhook/google", (c) => c.text("ok"));

  app.post("/webhook/google", async (c) => {
    const cfg = readBookingConfig();
    const channelToken = c.req.header("X-Goog-Channel-Token");
    if (cfg.webhookSecret && channelToken && channelToken !== cfg.webhookSecret) {
      return c.json({ error: "invalid channel token" }, 401);
    }
    const resourceState = c.req.header("X-Goog-Resource-State") ?? "unknown";
    const channelId = c.req.header("X-Goog-Channel-ID") ?? null;
    if (resourceState === "sync") {
      // Registration handshake — nothing to process, must answer 2xx.
      return c.json({ ok: true, sync: true, channelId });
    }
    // Change notifications carry no event details (privacy): the correct
    // response is to re-pull calendars (GET /booking/availability does this
    // on demand). Recorded for observability only.
    await bs.audit("booking.webhook", {
      provider: "google",
      event: resourceState,
      channelId,
    });
    return c.json({ ok: true });
  });

  // Microsoft Graph: handshake echoes validationToken as text/plain; later
  // notifications must carry the configured clientState (else 401).
  app.post("/webhook/microsoft", async (c) => {
    const cfg = readBookingConfig();
    const raw = await c.req.text();
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return c.json({ error: "invalid body" }, 400);
    }
    const obj = (body ?? {}) as {
      validationToken?: string;
      clientState?: string;
      value?: { clientState?: string; resource?: string; changeType?: string }[];
    };

    // Subscription handshake (must respond within ~10s, text/plain echo).
    if (typeof obj.validationToken === "string" && obj.validationToken) {
      return c.text(obj.validationToken);
    }

    const expected = cfg.microsoft.clientState || cfg.webhookSecret;
    const provided = obj.clientState ?? obj.value?.[0]?.clientState;
    if (expected && provided !== expected) {
      return c.json({ error: "clientState mismatch" }, 401);
    }

    const changes = obj.value ?? [];
    await bs.audit("booking.webhook", {
      provider: "microsoft",
      event: changes.map((v) => v.changeType ?? "unknown").join(",") || "notification",
      resources: changes.map((v) => v.resource ?? null).filter(Boolean),
    });
    // Like Google, Graph notifications are opaque — availability is re-pulled
    // on demand. 202 acknowledges without promising processing.
    return c.json({ ok: true, received: changes.length }, 202);
  });

  return app;
}
