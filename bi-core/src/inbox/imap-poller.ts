/**
 * Inbox reply poller — reads the agent's reply inbox over IMAP and forwards
 * new messages to bi-edge's /inbound-webhook, which matches replies to sent
 * leads, classifies intent, drafts the agent's reply and records bookings.
 *
 * Production design (no desktop app, no Proton Mail Bridge):
 *   Brevo sends pitches from agent.miles@gradient3.io (public identity).
 *   Proton auto-forwards replies to a dedicated free Gmail inbox, which this
 *   poller reads over IMAP/TLS from Fly (or anywhere Node runs).
 *
 * The poller is provider-agnostic imapflow: Gmail is the primary target, and
 * the old Proton Mail Bridge (localhost, self-signed STARTTLS) still works
 * via the legacy PROTON_* env vars for local dev/rollback.
 *
 * Env (generic, preferred):
 *   INBOX_IMAP_HOST         default 127.0.0.1; Gmail: imap.gmail.com
 *   INBOX_IMAP_PORT         default 993 on Gmail, 1143 on Bridge
 *   INBOX_IMAP_USER         mailbox address (or legacy PROTON_IMAP_USER)
 *   INBOX_IMAP_PASSWORD     Gmail app password / Bridge IMAP password
 *   INBOX_IMAP_FOLDER       default INBOX (Gmail label: Label_<NAME>)
 *   INBOX_IMAP_SECURE       "true"/"false"; default: true when port is 993
 *   INBOX_TLS_INSECURE      "true" skips TLS cert verification (Bridge only)
 *   INBOX_POLL_INTERVAL_MS  default 120000
 *   INBOX_LOOKBACK_MINUTES  default 60 (scan window per poll; dedupe by id)
 *   INBOX_FIRST_LOOKBACK_HOURS default 24 (first run, no seen state yet)
 *   INBOX_SEEN_FILE         default <DATA_DIR>/imap-seen-<provider>.json
 *   EDGE_WEBHOOK_URL        default http://127.0.0.1:8792/inbound-webhook
 *   INBOX_WEBHOOK_SECRET    sent as X-AD-Webhook header when the engine
 *                           has INBOUND_WEBHOOK_SECRET set
 *   DATA_DIR                state dir (default /tmp)
 *
 * Legacy (local dev / rollback) — each generic var falls back to these:
 *   PROTON_IMAP_HOST, PROTON_IMAP_PORT, PROTON_IMAP_USER, PROTON_IMAP_PASSWORD,
 *   PROTON_INBOX_FOLDER, PROTON_POLL_INTERVAL_MS, PROTON_LOOKBACK_MINUTES,
 *   PROTON_FIRST_LOOKBACK_HOURS
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

interface SeenState {
  ids: Record<string, string>;
}

export interface InboxImapConfig {
  provider: "gmail" | "proton-bridge";
  host: string;
  port: number;
  /** Implicit TLS (connect already encrypted). */
  secure: boolean;
  user: string;
  pass: string;
  folder: string;
  /** Skip TLS certificate verification (self-signed Bridge only). */
  tlsInsecure: boolean;
  seenFile: string;
  intervalMs: number;
  lookbackMs: number;
  firstLookbackMs: number;
  webhookUrl: string;
  webhookSecret: string;
}

const SKIP_SENDER_LOCAL = new Set([
  "mailer-daemon",
  "postmaster",
  "no-reply",
  "noreply",
  "da",
  "bounce",
]);

function log(msg: string): void {
  console.log(`[inbox-poller] ${msg}`);
}

function boolEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === "") return fallback;
  return value === "true" || value === "1";
}

/**
 * Resolve the poller configuration. Returns null when no credentials are
 * configured (poller stays off).
 */
export function resolveInboxConfig(env: Record<string, string>): InboxImapConfig | null {
  const user = env.INBOX_IMAP_USER || env.PROTON_IMAP_USER || "";
  const pass = env.INBOX_IMAP_PASSWORD || env.PROTON_IMAP_PASSWORD || "";
  if (!user || !pass) return null;

  const host = env.INBOX_IMAP_HOST || env.PROTON_IMAP_HOST || "127.0.0.1";
  const provider: InboxImapConfig["provider"] = host === "imap.gmail.com" ? "gmail" : "proton-bridge";
  const defaultPort = provider === "gmail" ? 993 : 1143;
  const port = Number(env.INBOX_IMAP_PORT || env.PROTON_IMAP_PORT || defaultPort);
  const secure = boolEnv(env.INBOX_IMAP_SECURE, port === 993);
  const folder =
    env.INBOX_IMAP_FOLDER || (provider === "gmail" ? "INBOX" : env.PROTON_INBOX_FOLDER || "INBOX");
  // Bridge serves a self-signed cert over STARTTLS; real providers must verify.
  const tlsInsecure = boolEnv(env.INBOX_TLS_INSECURE, provider === "proton-bridge");

  const dataDir = (env.DATA_DIR || "/tmp").replace(/\/$/, "");
  const seenFile =
    env.INBOX_SEEN_FILE || `${dataDir}/${provider === "gmail" ? "imap-seen-gmail.json" : "proton-seen.json"}`;

  return {
    provider,
    host,
    port,
    secure,
    user,
    pass,
    folder,
    tlsInsecure,
    seenFile,
    intervalMs: Number(env.INBOX_POLL_INTERVAL_MS || env.PROTON_POLL_INTERVAL_MS || 120_000),
    lookbackMs: Number(env.INBOX_LOOKBACK_MINUTES || env.PROTON_LOOKBACK_MINUTES || 60) * 60 * 1000,
    firstLookbackMs: Number(env.INBOX_FIRST_LOOKBACK_HOURS || env.PROTON_FIRST_LOOKBACK_HOURS || 24) * 3600 * 1000,
    webhookUrl: env.EDGE_WEBHOOK_URL || "http://127.0.0.1:8792/inbound-webhook",
    webhookSecret: env.INBOX_WEBHOOK_SECRET || "",
  };
}

function loadSeen(statePath: string): SeenState {
  try {
    if (existsSync(statePath)) {
      const parsed = JSON.parse(readFileSync(statePath, "utf8")) as SeenState;
      if (parsed && typeof parsed.ids === "object") return parsed;
    }
  } catch {
    /* corrupted state — start fresh */
  }
  return { ids: {} };
}

function saveSeen(statePath: string, state: SeenState): void {
  // Cap the seen set so the file stays small.
  const entries = Object.entries(state.ids);
  if (entries.length > 3000) {
    entries.sort((a, b) => (a[1] < b[1] ? 1 : -1));
    state.ids = Object.fromEntries(entries.slice(0, 3000));
  }
  try {
    mkdirSync(dirname(statePath), { recursive: true });
    writeFileSync(statePath, JSON.stringify(state));
  } catch (e: any) {
    log(`failed to save seen state: ${e.message}`);
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

async function pollOnce(
  cfg: InboxImapConfig,
  seen: SeenState,
): Promise<{ checked: number; forwarded: number }> {
  // First run (no seen state) scans back further so replies that arrived
  // before the poller was switched on are still picked up.
  const lookbackMs = Object.keys(seen.ids).length === 0 ? cfg.firstLookbackMs : cfg.lookbackMs;

  const conn = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.secure,
    auth: { user: cfg.user, pass: cfg.pass },
    tls: { rejectUnauthorized: !cfg.tlsInsecure },
    logger: false,
  });

  const items: Array<Record<string, unknown>> = [];
  let checked = 0;

  try {
    await conn.connect();
    await conn.mailboxOpen(cfg.folder, { readOnly: true });
    const since = new Date(Date.now() - lookbackMs);
    const seq = (await conn.search({ since }, { uid: true })) ?? [];
    if (!Array.isArray(seq) || seq.length === 0) return { checked: 0, forwarded: 0 };

    // Newest first.
    const uids = [...seq].sort((a, b) => b - a);
    for (const uid of uids) {
      const gen = conn.fetch(`${uid}`, { envelope: true, source: true }, { uid: true });
      for await (const m of gen) {
        if (!m.envelope) continue;
        checked++;
        const messageId = String(m.envelope.messageId ?? "").replace(/^<|>$/g, "");
        if (!messageId || seen.ids[messageId]) continue;

        const fromList = m.envelope.from;
        const fromAddr = Array.isArray(fromList) ? String(fromList[0]?.address ?? "") : "";
        const fromLocal = fromAddr.split("@")[0]?.toLowerCase() ?? "";
        if (!fromAddr || SKIP_SENDER_LOCAL.has(fromLocal)) continue;

        const source = m.source ? Buffer.from(m.source) : null;
        if (!source) continue;
        const parsed = await simpleParser(source);
        const body = (parsed.text || stripHtml(parsed.html || "")).slice(0, 4000);
        if (!body) continue;

        // Gmail marks spam via X-GM-Labels (<label:SPAM>); Bridge mail has no
        // equivalent here — 0 means "not known to be spam".
        const gmRaw = parsed.headers?.get("x-gm-labels");
        const gmLabels = Array.isArray(gmRaw) ? gmRaw.join(" ") : String(gmRaw ?? "");
        const spam = /<label:SPAM>/i.test(gmLabels) ? 1 : 0;

        items.push({
          MessageId: messageId,
          From: { Address: fromAddr, Name: String(parsed.from?.value?.[0]?.name ?? "") },
          Subject: String(parsed.subject || m.envelope.subject || ""),
          RawTextBody: body,
          SentAtDate: (m.envelope.date as Date | undefined)?.toISOString() ?? new Date().toISOString(),
          SpamScore: spam,
        });
        seen.ids[messageId] = new Date().toISOString();
      }
    }
  } finally {
    try {
      await conn.logout();
    } catch {
      conn.close();
    }
  }

  let forwarded = 0;
  if (items.length > 0) {
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (cfg.webhookSecret) headers["X-AD-Webhook"] = cfg.webhookSecret;
      const res = await fetch(cfg.webhookUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({ items }),
        // The webhook runs LLM classify (+ draft/booking) — give it room.
        signal: AbortSignal.timeout(180_000),
      });
      if (res.ok) {
        forwarded = items.length;
        const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        log(`forwarded ${items.length} message(s) → matched=${out.matched ?? "?"} interested=${out.interested ?? "?"} booked=${out.booked ?? 0} autoSent=${out.autoSent ?? 0}`);
      } else {
        log(`webhook returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
    } catch (e: any) {
      log(`webhook POST failed: ${e.message}`);
      // Roll back seen so the next poll retries these.
      for (const it of items) delete seen.ids[String(it.MessageId)];
    }
  }
  saveSeen(cfg.seenFile, seen);
  return { checked, forwarded };
}

/**
 * Start the poller loop. No-op (with a log line) when no credentials are set.
 */
export function startInboxPoller(env: Record<string, string>): void {
  const cfg = resolveInboxConfig(env);
  if (!cfg) {
    log(
      "disabled — set INBOX_IMAP_USER + INBOX_IMAP_PASSWORD to enable " +
        "(Gmail: INBOX_IMAP_HOST=imap.gmail.com, port 993, app password; legacy Bridge: PROTON_* vars)",
    );
    return;
  }

  const seen = loadSeen(cfg.seenFile);
  let busy = false;

  log(
    `enabled — provider=${cfg.provider} ${cfg.host}:${cfg.port} folder="${cfg.folder}" ` +
      `every ${cfg.intervalMs / 1000}s, ${Object.keys(seen.ids).length} known message ids`,
  );

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOnce(cfg, seen);
    } catch (e: any) {
      // Auth failure, connection refused, etc. Log and retry next tick.
      log(`poll failed: ${String(e.message ?? e).slice(0, 200)}`);
    } finally {
      busy = false;
    }
  };

  // First tick shortly after boot, then on the interval.
  setTimeout(tick, 10_000).unref();
  setInterval(tick, cfg.intervalMs).unref();
}

/** Legacy alias — the pre-Gmail name (Proton Bridge era). */
export const startProtonPoller = startInboxPoller;
