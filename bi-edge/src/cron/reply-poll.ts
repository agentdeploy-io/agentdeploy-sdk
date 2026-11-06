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
import { matchReplyCandidates, leadEmailAddresses, type SentLeadRef } from "../reply-match.js";

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
  items: Array<NormalizedItem & { candidates: string[] }>,
  sentLeads: SentLeadRef[],
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
          content: `You classify intent for inbound emails that have ALREADY been deterministically matched (by sender address or thread subject) to candidate outreach leads from ${brandName}.
Each event lists its candidate leadKeys. For each event: choose exactly one leadKey from its own candidates, and classify intent: interested, question, not_interested, opt_out, or spam. For opt_out set permanent true.
If an event is clearly not a reply to its candidate lead, omit it from the output.
HARD RULES: never output a leadKey that is not in that event's candidates; the "email" field must be the event's own sender address, never an address from another event; if nothing is a genuine reply return {"replies": []}.
Return ONLY JSON: {"replies": [{"leadKey":"...","email":"...","intent":"...","permanent":false,"summary":"...","replyFrom":"...","replySubject":"...","replyBody":"..."}]}`,
        },
        {
          role: "user",
          content: JSON.stringify({
            leads: sentLeads,
            events: items.map((i) => ({
              from: i.from,
              subject: i.subject,
              body: i.body,
              candidates: i.candidates,
            })),
          }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return [];

  const raw = parseLlmJson(await res.json());
  const repliesRaw: any[] = Array.isArray(raw.replies) ? raw.replies : [];

  // Post-validation: the LLM may only keep replies whose leadKey is a
  // candidate for the event's own sender, and whose email IS that sender.
  const candidatesByFrom = new Map<string, string[]>();
  for (const i of items) candidatesByFrom.set(i.from.trim().toLowerCase(), i.candidates);
  const replies = repliesRaw.filter((r: any) => {
    const cands = candidatesByFrom.get(String(r.replyFrom ?? "").trim().toLowerCase());
    if (!cands || !cands.includes(String(r.leadKey ?? ""))) return false;
    const item = items.find((i) => i.from.trim().toLowerCase() === String(r.replyFrom ?? "").trim().toLowerCase());
    if (!item) return false;
    return String(r.email ?? "").trim().toLowerCase() === item.from.trim().toLowerCase();
  });

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
    const sentLeads: SentLeadRef[] = [];
    for (const key of sentLeadKeys) {
      const lead = getLead(db, key);
      if (lead) {
        const emails = new Set<string>();
        for (const addr of leadEmailAddresses(lead)) emails.add(addr);
        for (const row of sentLog) {
          if (row.lead_key === key && row.email) emails.add(row.email);
        }
        sentLeads.push({ key: lead.key, name: lead.name, emails: [...emails], subject: lead.pitch_subject ?? "" });
      }
    }

    // Same deterministic pre-match as the webhook path: only items that come
    // from an emailed address or thread a pitch subject reach the classifier.
    const candidateItems = matchReplyCandidates(items, sentLeads);
    const classified =
      candidateItems.length > 0 ? await classifyReplyIntent(candidateItems, sentLeads, env) : [];

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
