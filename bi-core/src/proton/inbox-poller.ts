/**
 * Proton Mail inbox poller — reads the operator's Proton mailbox over IMAP
 * (via Proton Mail Bridge running locally) and forwards new inbound messages
 * to bi-edge's /inbound-webhook, which already matches replies to sent
 * leads, classifies intent, drafts the agent's reply and records bookings.
 *
 * Enabled only when PROTON_IMAP_USER + PROTON_IMAP_PASSWORD are set.
 *
 * Env:
 *   PROTON_IMAP_HOST        default 127.0.0.1
 *   PROTON_IMAP_PORT        default 1143 (Bridge IMAP, non-TLS)
 *   PROTON_IMAP_USER        Proton account address
 *   PROTON_IMAP_PASSWORD    Proton SMTP/IMAP password (not the login password)
 *   PROTON_INBOX_FOLDER     default INBOX (e.g. "Folders/agent-miles-outreach")
 *   PROTON_POLL_INTERVAL_MS default 120000
 *   PROTON_LOOKBACK_MINUTES default 60 (scan window per poll; dedupe via seen file)
 *   EDGE_WEBHOOK_URL        default http://127.0.0.1:8792/inbound-webhook
 *   DATA_DIR                state dir for the seen-id file
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname } from "node:path";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";

interface SeenState {
  ids: Record<string, string>;
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
  console.log(`[proton-poller] ${msg}`);
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

async function pollOnce(env: Record<string, string>, seen: SeenState, statePath: string): Promise<{ checked: number; forwarded: number }> {
  const host = env.PROTON_IMAP_HOST || "127.0.0.1";
  const port = Number(env.PROTON_IMAP_PORT || 1143);
  const folder = env.PROTON_INBOX_FOLDER || "INBOX";
  const lookbackMin = Number(env.PROTON_LOOKBACK_MINUTES || 60);
  const webhookUrl = env.EDGE_WEBHOOK_URL || "http://127.0.0.1:8792/inbound-webhook";

  const conn = new ImapFlow({
    host,
    port,
    secure: false,
    auth: { user: env.PROTON_IMAP_USER, pass: env.PROTON_IMAP_PASSWORD },
    logger: false,
  });

  const items: Array<Record<string, unknown>> = [];
  let checked = 0;

  try {
    await conn.connect();
    await conn.mailboxOpen(folder, { readOnly: true });
    const since = new Date(Date.now() - lookbackMin * 60 * 1000);
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
        const fromAddr = Array.isArray(fromList)
          ? String(fromList[0]?.address ?? "")
          : "";
        const fromLocal = fromAddr.split("@")[0]?.toLowerCase() ?? "";
        if (!fromAddr || SKIP_SENDER_LOCAL.has(fromLocal)) continue;

        const source = m.source ? Buffer.from(m.source) : null;
        if (!source) continue;
        const parsed = await simpleParser(source);
        const body = (parsed.text || stripHtml(parsed.html || "")).slice(0, 4000);
        if (!body) continue;

        items.push({
          MessageId: messageId,
          From: { Address: fromAddr, Name: String(parsed.from?.value?.[0]?.name ?? "") },
          Subject: String(parsed.subject || m.envelope.subject || ""),
          RawTextBody: body,
          SentAtDate: (m.envelope.date as Date | undefined)?.toISOString() ?? new Date().toISOString(),
          SpamScore: 0,
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
      const res = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items }),
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) {
        forwarded = items.length;
        const out = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        log(`forwarded ${items.length} message(s) → matched=${out.matched ?? "?"} interested=${out.interested ?? "?"} booked=${out.booked ?? 0}`);
      } else {
        log(`webhook returned ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
      }
    } catch (e: any) {
      log(`webhook POST failed: ${e.message}`);
      // Roll back seen so the next poll retries these.
      for (const it of items) delete seen.ids[String(it.MessageId)];
    }
  }
  saveSeen(statePath, seen);
  return { checked, forwarded };
}

/**
 * Start the poller loop. No-op (with a log line) when credentials are absent.
 */
export function startProtonPoller(env: Record<string, string>): void {
  if (!env.PROTON_IMAP_USER || !env.PROTON_IMAP_PASSWORD) {
    log("disabled — set PROTON_IMAP_USER + PROTON_IMAP_PASSWORD (Proton Mail Bridge must be running) to enable");
    return;
  }

  const dataDir = env.DATA_DIR || "/tmp";
  const statePath = `${dataDir.replace(/\/$/, "")}/proton-seen.json`;
  const intervalMs = Number(env.PROTON_POLL_INTERVAL_MS || 120_000);
  const seen = loadSeen(statePath);
  let busy = false;

  log(`enabled — folder="${env.PROTON_INBOX_FOLDER || "INBOX"}" every ${intervalMs / 1000}s, ${Object.keys(seen.ids).length} known message ids`);

  const tick = async () => {
    if (busy) return;
    busy = true;
    try {
      await pollOnce(env, seen, statePath);
    } catch (e: any) {
      // Connection refused etc. — Bridge not running. Log once-ish and retry next tick.
      log(`poll failed: ${e.message?.slice(0, 200)}`);
    } finally {
      busy = false;
    }
  };

  // First tick shortly after boot, then on the interval.
  setTimeout(tick, 10_000).unref();
  setInterval(tick, intervalMs).unref();
}
