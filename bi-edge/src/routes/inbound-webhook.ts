/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  getLead,
  updateLead,
  logReply,
  listRecentSent,
  logLlmTrace,
  isAutoSendReplies,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";
import type { ReplyIntent } from "../db/types.js";
import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import { draftReplyWithBooking, bookingCalendarLink } from "../agents/reply-draft.js";
import { insertBooking, findExistingBooking } from "../db/bookings.js";
import { getFirstEmail } from "../agents/outreach.js";
import { sendReplyDraft } from "../agents/supervisor.js";
import { sendCalendarInvite } from "../agents/calendar-invite.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

interface BrevoWebhookPayload {
  items?: Array<{
    MessageId?: string;
    messageId?: string;
    InReplyTo?: string;
    From?: { Address?: string; Name?: string };
    Subject?: string;
    ExtractedMarkdownMessage?: string;
    RawTextBody?: string;
    RawHtmlBody?: string;
    SentAtDate?: string;
    SpamScore?: number;
  }>;
  MessageId?: string;
}

interface NormalizedItem {
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  at: string;
  spam: number;
}

function normalizeWebhook(payload: BrevoWebhookPayload, seenIds: string[]): {
  items: NormalizedItem[];
  allSeen: string[];
} {
  const raw = payload.items ?? (payload.MessageId ? [payload as any] : []);
  const seenSet = new Set(seenIds.map(String));
  const items: NormalizedItem[] = [];

  for (const it of raw) {
    const mid = String(it.MessageId ?? it.messageId ?? "");
    if (mid && seenSet.has(mid)) continue;

    const from = it.From ?? {};
    let body = String(it.ExtractedMarkdownMessage ?? it.RawTextBody ?? it.RawHtmlBody ?? "");
    if (body.length > 4000) body = body.slice(0, 4000) + "...";

    items.push({
      messageId: mid,
      from: String(from.Address ?? ""),
      fromName: String(from.Name ?? ""),
      subject: String(it.Subject ?? ""),
      body,
      at: String(it.SentAtDate ?? new Date().toISOString()),
      spam: it.SpamScore !== undefined ? Number(it.SpamScore) : 0,
    });

    if (mid) seenSet.add(mid);
  }

  const allSeen = [...seenSet];
  if (allSeen.length > 1000) {
    return { items, allSeen: allSeen.slice(allSeen.length - 1000) };
  }

  return { items, allSeen };
}

async function classifyReplyIntent(
  items: NormalizedItem[],
  sentLeads: Array<{ key: string; name: string; email: string; subject: string }>,
  env: Record<string, unknown>,
  db?: DatabaseType.Database,
): Promise<
  Array<{
    leadKey: string;
    email: string;
    intent: ReplyIntent;
    permanent: boolean;
    summary: string;
    replyFrom: string;
    replySubject: string;
    replyBody: string;
  }>
> {
  const brandName = String(env.BRAND_NAME ?? "our business");
  const t0 = Date.now();

  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 8192,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify inbound email replies to an outreach thread from ${brandName}.
Match each inbound event to a sent lead by recipient email or reply-thread subject.
Classify intent: interested, question, not_interested, opt_out, or spam.
For opt_out set permanent true.
Return ONLY JSON: {"replies": [{"leadKey":"...","email":"...","intent":"...","permanent":false,"summary":"...","replyFrom":"...","replySubject":"...","replyBody":"..."}]}`,
        },
        {
          role: "user",
          content: JSON.stringify({ leads: sentLeads, events: { items } }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return [];

  const raw = parseLlmJson(await res.json());
  const repliesRaw: any[] = Array.isArray(raw.replies) ? raw.replies : [];
  if (db) {
    logLlmTrace(db, {
      stage: "reply-classify",
      leadKey: repliesRaw.length === 1 ? String(repliesRaw[0]?.leadKey ?? "") : `${repliesRaw.length} replies`,
      model: String(env.AD_MODEL ?? ""),
      promptExcerpt: JSON.stringify({ leads: sentLeads.map((l) => l.key), events: items.map((i) => ({ from: i.from, subject: i.subject, body: i.body.slice(0, 200) })) }),
      rawResponse: JSON.stringify(raw),
      latencyMs: Date.now() - t0,
    });
  }
  const replies = repliesRaw;

  return replies.map((r: any) => ({
    leadKey: String(r.leadKey ?? ""),
    email: String(r.email ?? ""),
    intent: (["interested", "question", "not_interested", "opt_out", "spam"].includes(r.intent)
      ? r.intent
      : "question") as ReplyIntent,
    permanent: Boolean(r.permanent),
    summary: String(r.summary ?? ""),
    replyFrom: String(r.replyFrom ?? ""),
    replySubject: String(r.replySubject ?? ""),
    replyBody: String(r.replyBody ?? "").slice(0, 800),
  }));
}

export async function handleInboundWebhook(
  request: Request,
  env: Record<string, unknown>,
  externalDb?: DatabaseType.Database,
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  let payload: BrevoWebhookPayload;
  try {
    payload = (await request.json()) as BrevoWebhookPayload;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const ownDb = !externalDb;
  const db = externalDb ?? initDb();
  try {
    const seenRow = db
      .prepare("SELECT ids FROM inbound_seen WHERE id = 1")
      .get() as { ids: string } | undefined;
    let seenIds: string[] = [];
    if (seenRow) {
      try {
        seenIds = JSON.parse(seenRow.ids);
      } catch {
        seenIds = [];
      }
    }

    const { items, allSeen } = normalizeWebhook(payload, seenIds);

    if (items.length === 0) {
      if (ownDb) db.close();
      return new Response(JSON.stringify({ skipped: true, received: 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    db.prepare(
      "INSERT OR REPLACE INTO inbound_seen (id, ids, updated_at) VALUES (1, ?, ?)"
    ).run(JSON.stringify(allSeen), new Date().toISOString());

    const sentLog = listRecentSent(db, 500);
    const sentLeadKeys = new Set(sentLog.map((s) => s.lead_key));
    const sentLeads: Array<{ key: string; name: string; email: string; subject: string }> = [];
    for (const key of sentLeadKeys) {
      const lead = getLead(db, key);
      if (lead && (lead.status === "sent" || lead.status === "replied" || lead.stage === "sent")) {
        let email = "";
        try {
          const parsed = JSON.parse(lead.emails ?? "[]");
          email = Array.isArray(parsed) && parsed[0] ? parsed[0].addr ?? String(parsed[0]) : "";
        } catch {
          email = lead.emails ?? "";
        }
        sentLeads.push({
          key: lead.key,
          name: lead.name,
          email,
          subject: lead.pitch_subject ?? "",
        });
      }
    }

    const classified = await classifyReplyIntent(items, sentLeads, env, db);

    let matched = 0;
    let interested = 0;
    let optOuts = 0;

    const draftThreads: Array<{
      key: string;
      name: string;
      leadSubject: string;
      replyFrom: string;
      replySubject: string;
      replyBody: string;
    }> = [];

    for (const reply of classified) {
      const lead = getLead(db, reply.leadKey);
      if (!lead) continue;
      matched++;

      if (reply.intent === "opt_out") {
        updateLead(db, reply.leadKey, { status: "opted_out", stage: "opted_out" });
        optOuts++;
      } else if (reply.intent === "interested") {
        updateLead(db, reply.leadKey, { status: "replied", stage: "replied" });
        interested++;
      } else if (reply.intent === "question") {
        updateLead(db, reply.leadKey, { status: "replied", stage: "replied" });
      }

      logReply(db, {
        lead_key: reply.leadKey,
        reply_from: reply.replyFrom,
        reply_subject: reply.replySubject,
        reply_body: reply.replyBody,
        intent: reply.intent,
        draft: null,
        draft_status: null,
        at: new Date().toISOString(),
      });

      if (reply.intent === "interested" || reply.intent === "question") {
        draftThreads.push({
          key: reply.leadKey,
          name: lead.name,
          leadSubject: lead.pitch_subject ?? "",
          replyFrom: reply.replyFrom,
          replySubject: reply.replySubject,
          replyBody: reply.replyBody,
        });
      }
    }

    let drafted = 0;
    let booked = 0;
    let autoSent = 0;
    const autoSend = isAutoSendReplies(db);
    if (draftThreads.length > 0) {
      const { drafts, slots } = await draftReplyWithBooking(draftThreads, env, db);
      const brandName = String(env.BRAND_NAME ?? "Agent Miles");
      for (const draft of drafts) {
        let body = draft.body;
        const lead = getLead(db, draft.key);
        const slot = draft.slotIndex != null ? slots[draft.slotIndex] : undefined;
        if (slot && lead) {
          const link = bookingCalendarLink(lead.name, slot, brandName);
          const existing = findExistingBooking(db, draft.key, slot.start.toISOString());
          if (existing) {
            body = `${body}\n\nBook it here — adds the meeting to your Google Calendar:\n${link}\n`;
          } else {
            const bookingId = insertBooking(db, {
              lead_key: draft.key,
              customer_email: getFirstEmail(lead),
              start_at: slot.start.toISOString(),
              end_at: slot.end.toISOString(),
              title: `Call: ${lead.name}`,
              calendar_link: link,
            });
            // Real .ics invite to customer + operator (best effort — never
            // block the draft flow on the invite send).
            sendCalendarInvite(db, env, bookingId)
              .then((r) => console.log(`[webhook] calendar invite: ${r}`))
              .catch((e) => console.error(`[webhook] calendar invite failed: ${String(e)}`));
            body = `${body}\n\nBook it here — adds the meeting to your Google Calendar:\n${link}\n`;
          }
          booked++;
        }
        const entry = db
          .prepare(
            "SELECT id FROM replies_log WHERE lead_key = ? AND draft_status IS NULL ORDER BY id DESC LIMIT 1"
          )
          .get(draft.key) as { id: number } | undefined;
        if (entry) {
          db.prepare(
            "UPDATE replies_log SET draft = ?, draft_status = 'pending' WHERE id = ?"
          ).run(body, entry.id);
          drafted++;
          if (autoSend) {
            // HITL off — deliver the draft immediately (still honours the
            // dryRun / sendEnabled / paused / cap gates inside).
            try {
              const result = await sendReplyDraft(db, entry.id, env);
              const now = db
                .prepare("SELECT draft_status FROM replies_log WHERE id = ?")
                .get(entry.id) as { draft_status: string | null } | undefined;
              if (now?.draft_status === "sent") {
                autoSent++;
                console.log(`[webhook] auto-sent reply ${entry.id}: ${result}`);
              } else {
                console.log(`[webhook] auto-send reply ${entry.id} held: ${result}`);
              }
            } catch (e) {
              console.error(`[webhook] auto-send reply ${entry.id} failed: ${String(e)}`);
            }
          }
        }
      }
    }

    if (ownDb) db.close();
    return new Response(
      JSON.stringify({
        received: items.length,
        matched,
        interested,
        optOuts,
        drafted,
        booked,
        autoSent,
        note:
          matched > 0
            ? `${drafted} reply draft(s) ready — /reply-list to review, /send-reply to send` +
              (booked > 0 ? ` (${booked} meeting(s) booked)` : "") +
              (autoSent > 0 ? ` (${autoSent} auto-sent)` : "")
            : "No match to a sent lead",
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (e: any) {
    if (ownDb) db.close();
    return new Response(JSON.stringify({ error: e.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
