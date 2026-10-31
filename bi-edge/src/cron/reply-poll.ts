/// <reference types="@cloudflare/workers-types" />

import Database from "better-sqlite3";
import type DatabaseType from "better-sqlite3";
import {
  isPaused,
  updateLead,
  getLead,
  logReply,
  listRecentSent,
  isAutoSendReplies,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";
import type { Lead, ReplyIntent } from "../db/types.js";
import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import { sendReplyDraft } from "../agents/supervisor.js";

function initDb(): DatabaseType.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

interface BrevoInboundEvent {
  sender?: string;
  subject?: string;
  date?: string;
  messageId?: string;
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

async function fetchBrevoInbound(env: Record<string, unknown>): Promise<BrevoInboundEvent[]> {
  const apiKey = env.BREVO_API_KEY as string;
  if (!apiKey) return [];

  try {
    const res = await fetch("https://api.brevo.com/v3/inbound/events", {
      headers: { "api-key": apiKey },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { events?: BrevoInboundEvent[] };
    return data.events ?? [];
  } catch {
    return [];
  }
}

function normalizeInbound(raw: BrevoInboundEvent[]): NormalizedItem[] {
  return raw.map((e) => ({
    messageId: e.messageId ?? "",
    from: e.sender ?? "",
    fromName: "",
    subject: e.subject ?? "",
    body: "",
    at: e.date ?? new Date().toISOString(),
    spam: 0,
  }));
}

async function classifyReplyIntent(
  items: NormalizedItem[],
  sentLeads: Array<{ key: string; name: string; email: string }>,
  env: Record<string, unknown>,
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

  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 4096,
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
  const replies = Array.isArray(raw.replies) ? raw.replies : [];

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

async function draftReply(
  threads: Array<{
    key: string;
    name: string;
    leadSubject: string;
    replyFrom: string;
    replySubject: string;
    replyBody: string;
  }>,
  env: Record<string, unknown>,
): Promise<Array<{ key: string; subject: string; body: string }>> {
  const brandName = String(env.BRAND_NAME ?? "");
  const calendly = String(env.CALENDLY_URL ?? "");

  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 4096,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the brand's AI outreach agent replying to inbound email.
Brand: ${brandName}. Calendly: ${calendly || "not available"}.
For each thread write one short reply (40-80 words).
Return ONLY JSON: {"replies":[{"key":"...","subject":"Re: ...","body":"..."}]}`,
        },
        {
          role: "user",
          content: JSON.stringify({ brand: { name: brandName, calendly }, threads }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return [];

  const raw = parseLlmJson(await res.json());
  return Array.isArray(raw.replies) ? raw.replies : [];
}

export async function replyPollCron(env: Record<string, unknown>, externalDb?: DatabaseType.Database): Promise<{
  received: number;
  matched: number;
  interested: number;
  optOuts: number;
  drafted: number;
  autoSent: number;
  skipped: boolean;
}> {
  const ownDb = !externalDb;
  const db = externalDb ?? initDb();

  try {
    if (isPaused(db)) {
      return { received: 0, matched: 0, interested: 0, optOuts: 0, drafted: 0, autoSent: 0, skipped: true };
    }

    const raw = await fetchBrevoInbound(env);
    const items = normalizeInbound(raw);

    if (items.length === 0) {
      return { received: 0, matched: 0, interested: 0, optOuts: 0, drafted: 0, autoSent: 0, skipped: false };
    }

    const sentLog = listRecentSent(db, 500);
    const sentLeadKeys = new Set(sentLog.map((s) => s.lead_key));
    const sentLeads: Array<{ key: string; name: string; email: string }> = [];
    for (const key of sentLeadKeys) {
      const lead = getLead(db, key);
      if (lead) {
        let email = "";
        try {
          const parsed = JSON.parse(lead.emails ?? "[]");
          email = Array.isArray(parsed) && parsed[0] ? parsed[0].addr ?? String(parsed[0]) : "";
        } catch {
          email = lead.emails ?? "";
        }
        sentLeads.push({ key: lead.key, name: lead.name, email });
      }
    }

    const classified = await classifyReplyIntent(items, sentLeads, env);

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
    let autoSent = 0;
    const autoSend = isAutoSendReplies(db);
    if (draftThreads.length > 0) {
      const drafts = await draftReply(draftThreads, env);
      for (const draft of drafts) {
        const entry = db
          .prepare(
            "SELECT id FROM replies_log WHERE lead_key = ? AND draft_status IS NULL ORDER BY id DESC LIMIT 1"
          )
          .get(draft.key) as { id: number } | undefined;
        if (entry) {
          db.prepare(
            "UPDATE replies_log SET draft = ?, draft_status = 'pending' WHERE id = ?"
          ).run(draft.body, entry.id);
          drafted++;
          if (autoSend) {
            try {
              const result = await sendReplyDraft(db, entry.id, env);
              const now = db
                .prepare("SELECT draft_status FROM replies_log WHERE id = ?")
                .get(entry.id) as { draft_status: string | null } | undefined;
              if (now?.draft_status === "sent") {
                autoSent++;
                console.log(`[reply-poll] auto-sent reply ${entry.id}: ${result}`);
              } else {
                console.log(`[reply-poll] auto-send reply ${entry.id} held: ${result}`);
              }
            } catch (e) {
              console.error(`[reply-poll] auto-send reply ${entry.id} failed: ${String(e)}`);
            }
          }
        }
      }
    }

    return {
      received: items.length,
      matched,
      interested,
      optOuts,
      drafted,
      autoSent,
      skipped: false,
    };
  } finally {
    if (ownDb) db.close();
  }
}
