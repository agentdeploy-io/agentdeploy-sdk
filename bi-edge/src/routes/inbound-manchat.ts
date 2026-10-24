/// <reference types="@cloudflare/workers-types" />

import type Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import { getLead, upsertLead, logLlmTrace } from "../db/index.js";
import type { Lead } from "../db/types.js";

/**
 * ManyChat inbound webhook — turns inbound Instagram/Messenger activity into
 * leads. The operator points a ManyChat webhook (Settings → Developer →
 * Webhooks) at this URL with a shared secret token; ManyChat POSTs an event
 * JSON here whenever a configured trigger fires (new DM, comment, follow, …).
 *
 * This is the "inbound DMs → leads" channel: a person who messages the brand
 * becomes a lead in the pipeline (source: "manychat"). The raw event is always
 * preserved in the lead's `research` so nothing is lost if the field names
 * differ from the best-known ManyChat v1 shape.
 *
 * NOTE: receiving webhooks does not require the ManyChat API key — the key
 * (MANYCHAT_API_KEY) is only needed for outbound calls (send/lookup). The
 * webhook secret is MANYCHAT_WEBHOOK_TOKEN.
 */

interface ManyChatEvent {
  type?: string;
  event?: string;
  token?: string;
  secret?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
  [k: string]: unknown;
}

function pick(obj: unknown, keys: string[]): unknown {
  if (!obj || typeof obj !== "object") return undefined;
  const o = obj as Record<string, unknown>;
  for (const k of keys) {
    if (o[k] !== undefined && o[k] !== null && o[k] !== "") return o[k];
  }
  return undefined;
}

/**
 * Normalize a ManyChat event into a lightweight inbound-lead shape. Tolerant
 * of the common v1 field-name variants (user_id/psid/contact_id, message/text/
 * comment, profile.first_name, …). Returns null when the event carries no
 * usable contact.
 */
export function normalizeManyChatEvent(raw: ManyChatEvent): {
  userId: string;
  name: string;
  profileUrl: string;
  region: string;
  text: string;
  eventType: string;
  at: string;
} | null {
  const data = (raw.data && typeof raw.data === "object" ? raw.data : raw) as Record<string, unknown>;
  const profile = (pick(data, ["profile", "user", "contact", "subscriber"]) ?? {}) as Record<string, unknown>;

  const userIdRaw = pick(data, ["user_id", "psid", "contact_id", "subscriber_id", "sender_id", "id", "userId"]);
  if (userIdRaw === undefined) return null;
  const userId = String(userIdRaw);

  const name = String(
    pick(profile, ["first_name", "name", "full_name", "display_name"]) ??
      pick(data, ["first_name", "name", "full_name", "display_name"]) ??
      `Manychat contact ${userId}`,
  );
  const profileUrl = String(
    pick(profile, ["profile_url", "url", "link", "user_url", "profile_link"]) ??
      pick(data, ["profile_url", "user_url", "profile_link", "url"]) ??
      "",
  );
  const region = String(pick(data, ["region", "country", "locale"]) ?? pick(profile, ["region", "country"]) ?? "ig");
  const text = String(
    pick(data, ["message", "text", "comment", "body", "message_text", "content"]) ??
      pick(profile, ["message", "text"]) ??
      "",
  ).slice(0, 4000);
  const eventType = String(raw.type ?? raw.event ?? "unknown");
  const ts = raw.timestamp ?? data.timestamp;
  const at = typeof ts === "number" ? new Date(ts * 1000).toISOString() : new Date().toISOString();

  return { userId, name, profileUrl, region, text, eventType, at };
}

/** Event types worth turning into a lead (inbound intent signals). */
const LEAD_EVENT_TYPES = new Set([
  "new_message",
  "message",
  "incoming_message",
  "dm",
  "new_comment",
  "comment",
  "comment_received",
  "follow",
  "new_follower",
  "new_subscriber",
  "subscriber",
  "profile_view",
]);

export async function handleManychatWebhook(
  request: Request,
  env: Record<string, unknown>,
  db: DatabaseType.Database,
): Promise<Response> {
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  if (request.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let raw: ManyChatEvent;
  try {
    raw = (await request.json()) as ManyChatEvent;
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }

  // Token check. If a secret is configured it must match; if none is set we
  // accept (but the operator should set MANYCHAT_WEBHOOK_TOKEN).
  const expected = String(env.MANYCHAT_WEBHOOK_TOKEN ?? "").trim();
  const provided = String(raw.token ?? raw.secret ?? "");
  if (expected && provided !== expected) {
    return json({ error: "invalid token" }, 401);
  }

  // Keep a raw-event trace so the operator can confirm field names / debug.
  try {
    logLlmTrace(db, {
      stage: "manychat-webhook",
      leadKey: "",
      model: "",
      promptExcerpt: JSON.stringify({ type: raw.type ?? raw.event, tokenOk: !expected || provided === expected }).slice(0, 500),
      rawResponse: JSON.stringify(raw).slice(0, 8000),
      latencyMs: 0,
    });
  } catch {
    /* trace is best-effort */
  }

  const norm = normalizeManyChatEvent(raw);
  if (!norm) return json({ received: 1, lead: false, reason: "no contact id in event" });

  const eventType = norm.eventType;
  const isLeadEvent = LEAD_EVENT_TYPES.has(eventType) || eventType === "unknown";
  if (!isLeadEvent) {
    return json({ received: 1, lead: false, reason: `event type "${eventType}" not lead-capturing` });
  }

  const key = `mc-${norm.userId}`;
  const existing = getLead(db, key);
  const now = new Date().toISOString();
  const research = JSON.stringify({
    channel: "manychat",
    event: eventType,
    message: norm.text || null,
    receivedAt: norm.at,
    raw: raw,
  }).slice(0, 20000);

  if (existing) {
    // Append the new signal; keep the original creation time + identity.
    const prevResearch = existing.research ? `${existing.research}\n---\n` : "";
    const lead: Lead = {
      ...existing,
      name: existing.name && existing.name !== `Manychat contact ${norm.userId}` ? existing.name : norm.name,
      website: existing.website ?? (norm.profileUrl || null),
      socials: norm.profileUrl
        ? JSON.stringify([{ platform: "instagram", url: norm.profileUrl }])
        : existing.socials,
      research: (prevResearch + research).slice(0, 20000),
      status: "pending_review",
      updated_at: now,
    };
    upsertLead(db, lead);
    return json({ received: 1, lead: true, key, event: eventType, updated: true });
  }

  const lead: Lead = {
    key,
    country: norm.region || "ig",
    name: norm.name,
    website: norm.profileUrl || null,
    website_status: "none",
    socials: norm.profileUrl ? JSON.stringify([{ platform: "instagram", url: norm.profileUrl }]) : null,
    source: "manychat",
    source_url: norm.profileUrl || null,
    stage: "raw",
    research,
    status: "pending_review",
    created_at: now,
    updated_at: now,
  };
  upsertLead(db, lead);
  return json({ received: 1, lead: true, key, event: eventType, created: true });
}
