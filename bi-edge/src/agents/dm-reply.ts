/// <reference types="@cloudflare/workers-types" />

import type Database from "better-sqlite3";
import type { ReplyIntent } from "../db/types.js";
import {
  getLead,
  updateLead,
  getReplyLogById,
  logReply,
  updateReplyDraft,
  logSentEmail,
  countSentToday,
  isPaused,
  isDmDryRun,
  isDmEnabled,
  getDmDailyCap,
  isTestMode,
  getSetting,
  logLlmTrace,
} from "../db/index.js";
import { resolveCampaign } from "../services/campaign.js";
import { gatewayFetchWithBackoff, gatewayHeaders, parseLlmJson } from "@agentdeploy-io/edge-sdk";
import { manychatSendText, manychatCreateSubscriber, ManyChatError } from "../manychat/client.js";

/**
 * Two-way DM loop for Manychat inbound leads:
 *
 *   inbound DM → classify intent (LLM) → log reply (channel "manychat")
 *   → if interested/question: draft a reply (LLM) → pending draft in the
 *     SAME approvals queue as email replies → /send-reply routes it back
 *     through Manychat (manychatSendText) with DM-specific gates.
 *
 * Gates are independent of the email ones: paused (shared), dmDryRun
 * (default true), dmEnabled (default false), dmDailyCap (default 10).
 */

const INTENTS: ReplyIntent[] = ["interested", "question", "not_interested", "opt_out", "spam"];

function dmRecipientFromEnv(db: Database.Database): string {
  return (getSetting(db, "dmTestRecipient") ?? "").trim();
}

export async function classifyDmIntent(
  dmText: string,
  leadName: string,
  env: Record<string, unknown>,
  db?: Database.Database,
  leadKey?: string,
): Promise<{ intent: ReplyIntent; summary: string }> {
  const campaign = db ? resolveCampaign(db as any, env) : { brandName: String(env.BRAND_NAME ?? "our business") };
  const t0 = Date.now();
  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.2,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You classify an inbound direct message to ${campaign.brandName}'s social account.
The sender is a person (not a company). Judge their commercial intent toward the brand.
Intent: interested (wants the brand's service / asks to work together), question (asks something specific), not_interested (no commercial intent, just chatting), opt_out (asks to stop contact), spam.
Return ONLY JSON: {"intent":"...","summary":"one line"}`,
        },
        {
          role: "user",
          content: JSON.stringify({ leadName, dmText: dmText.slice(0, 4000) }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return { intent: "question", summary: "classification unavailable — defaulting to question" };
  const raw = parseLlmJson(await res.json());
  const intent = INTENTS.includes(raw.intent as ReplyIntent) ? (raw.intent as ReplyIntent) : "question";
  const summary = String(raw.summary ?? "").slice(0, 200);
  if (db && leadKey) {
    logLlmTrace(db, {
      stage: "dm-classify",
      leadKey,
      model: String(env.AD_MODEL ?? ""),
      promptExcerpt: dmText.slice(0, 300),
      rawResponse: JSON.stringify(raw),
      latencyMs: Date.now() - t0,
    });
  }
  return { intent, summary };
}

export async function draftDmReply(
  leadName: string,
  dmText: string,
  env: Record<string, unknown>,
  db?: Database.Database,
  leadKey?: string,
): Promise<string> {
  const campaign = db ? resolveCampaign(db as any, env) : { brandName: String(env.BRAND_NAME ?? ""), calendlyUrl: String(env.CALENDLY_URL ?? "") };
  const t0 = Date.now();
  const res = await gatewayFetchWithBackoff("/v1/chat/completions", {
    method: "POST",
    headers: gatewayHeaders(env),
    body: JSON.stringify({
      model: env.AD_MODEL ?? "openai/gpt-4o-mini",
      temperature: 0.4,
      max_tokens: 2048,
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are the brand's AI rep answering an inbound DM for ${campaign.brandName} on social.
Booking link (offer it only when the person shows clear intent): ${campaign.calendlyUrl || "not available"}.
Rules: short (2-4 sentences), match their tone, answer directly, propose ONE clear next step.
Never re-pitch hard, never quote pricing, never claim to be a human.
Return ONLY JSON: {"reply":"..."}`,
        },
        {
          role: "user",
          content: JSON.stringify({ leadName, dmText: dmText.slice(0, 4000) }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return "";
  const raw = parseLlmJson(await res.json());
  const reply = String(raw.reply ?? "").slice(0, 1500);
  if (db && leadKey) {
    logLlmTrace(db, {
      stage: "dm-draft",
      leadKey,
      model: String(env.AD_MODEL ?? ""),
      promptExcerpt: dmText.slice(0, 300),
      rawResponse: JSON.stringify(raw),
      latencyMs: Date.now() - t0,
    });
  }
  return reply;
}

/**
 * Run the classify → draft half of the loop for a fresh inbound DM.
 * Returns the outcome (the webhook response surfaces it). Errors are
 * non-fatal: the lead still exists even if the LLM half fails.
 */
export async function processDmInbound(
  db: Database.Database,
  leadKey: string,
  dmText: string,
  env: Record<string, unknown>,
): Promise<{ intent?: ReplyIntent; summary?: string; draftPending?: boolean; error?: string }> {
  if (!dmText) return {};
  const lead = getLead(db, leadKey);
  if (!lead) return { error: "lead not found" };

  let intent: ReplyIntent;
  let summary = "";
  try {
    const c = await classifyDmIntent(dmText, lead.name, env, db, leadKey);
    intent = c.intent;
    summary = c.summary;
  } catch (e: any) {
    return { error: `classify failed: ${e?.message ?? e}` };
  }

  const replyId = logReply(db, {
    lead_key: leadKey,
    reply_from: lead.name,
    reply_subject: null,
    reply_body: dmText.slice(0, 800),
    intent,
    draft: null,
    draft_status: null,
    at: new Date().toISOString(),
    channel: "manychat",
  });

  if (intent === "opt_out") {
    updateLead(db, leadKey, { status: "opted_out", stage: "opted_out" });
    return { intent, summary };
  }
  if (intent === "spam") {
    return { intent, summary };
  }
  if (intent !== "interested" && intent !== "question") {
    return { intent, summary };
  }

  let reply = "";
  try {
    reply = await draftDmReply(lead.name, dmText, env, db, leadKey);
  } catch (e: any) {
    return { intent, summary, error: `draft failed: ${e?.message ?? e}` };
  }
  if (!reply) return { intent, summary };

  updateLead(db, leadKey, { status: "replied", stage: "replied" });
  updateReplyDraft(db, replyId, reply, "pending");
  return { intent, summary, draftPending: true };
}

function resolveDmRecipientId(
  db: Database.Database,
  lead: { key: string; manychat_subscriber_id?: string | null },
): string | null {
  if (isTestMode(db)) {
    const t = dmRecipientFromEnv(db);
    if (t) return t;
  }
  if (lead.manychat_subscriber_id) return String(lead.manychat_subscriber_id);
  const m = /^mc-(\d+)$/.exec(lead.key);
  if (m) return m[1];
  return null;
}

/**
 * Send a pending DM draft (the /send-reply path for channel=manychat).
 * Mirrors the email sendReplyDraft: same guards, DM-specific gates
 * (dmDryRun / dmEnabled / dmDailyCap), test-mode redirect, dry-run log.
 */
export async function sendDmReplyDraft(
  db: Database.Database,
  id: number,
  env: Record<string, unknown>,
): Promise<string> {
  const entry = getReplyLogById(db, id);
  if (!entry) return `Reply log ${id} not found`;
  if (entry.channel !== "manychat") return `Reply ${id} is not a DM draft — use the email path`;
  if (!entry.draft) return `Reply ${id} has no draft to send`;
  if (entry.draft_status === "sent") return `Reply ${id} was already sent`;
  if (entry.draft_status === "discarded") return `Reply ${id} was discarded`;

  const lead = getLead(db, entry.lead_key);
  if (!lead) return `Lead ${entry.lead_key} no longer exists`;
  if (lead.status === "opted_out") return `Lead ${lead.key} has opted out — not sending`;
  if (lead.status === "rejected") return `Lead ${lead.key} was rejected — not sending`;

  if (isPaused(db)) return "Pipeline is paused — run /resume first";
  const dryRun = isDmDryRun(db);
  if (!dryRun && !isDmEnabled(db)) return "dmEnabled is false — set it true in settings first";
  if (!dryRun) {
    const cap = getDmDailyCap(db);
    const sentToday = countSentToday(db, "manychat");
    if (sentToday >= cap) return `DM daily cap reached (${sentToday}/${cap})`;
  }

  const recipientId = resolveDmRecipientId(db, lead);
  if (!recipientId) return `No Manychat subscriber id for lead ${lead.key}`;

  const at = new Date().toISOString();
  if (dryRun) {
    logSentEmail(db, {
      lead_key: lead.key,
      email: `dm:${recipientId}`,
      subject: null,
      message_id: null,
      status: "dry-run",
      at,
      channel: "manychat",
    });
    updateReplyDraft(db, id, entry.draft, "sent");
    updateLead(db, lead.key, { stage: "replied", status: "replied" });
    return `DM reply ${id} DRY-RUN → subscriber ${recipientId} — nothing sent`;
  }

  try {
    try {
      await manychatSendText(recipientId, entry.draft, env);
    } catch (e: any) {
      if (!(e instanceof ManyChatError)) throw e;
      // Unknown/rotated subscriber id — best-effort recreate from lead data
      // and retry once.
      const emails: Array<{ addr?: string }> = (() => {
        try {
          return JSON.parse(lead.emails ?? "[]");
        } catch {
          return [];
        }
      })();
      const phones: Array<{ num?: string } | string> = (() => {
        try {
          return JSON.parse(lead.phones ?? "[]");
        } catch {
          return [];
        }
      })();
      const email = emails[0]?.addr ?? "";
      const phone = Array.isArray(phones) ? (typeof phones[0] === "string" ? phones[0] : phones[0]?.num ?? "") : "";
      const created = await manychatCreateSubscriber(
        {
          first_name: lead.name.slice(0, 50) || "Contact",
          last_name: "",
          ...(email ? { email } : {}),
          ...(phone ? { phone } : {}),
        },
        env,
      );
      if (!created?.id) throw new Error("Manychat createSubscriber returned no id");
      updateLead(db, lead.key, { manychat_subscriber_id: String(created.id) });
      await manychatSendText(String(created.id), entry.draft, env);
    }

    logSentEmail(db, {
      lead_key: lead.key,
      email: `dm:${recipientId}`,
      subject: null,
      message_id: null,
      status: "sent",
      at,
      channel: "manychat",
    });
    updateReplyDraft(db, id, entry.draft, "sent");
    updateLead(db, lead.key, { stage: "replied", status: "replied" });
    return `DM reply ${id} sent → subscriber ${recipientId}`;
  } catch (e: any) {
    const msg = e instanceof ManyChatError ? e.message : String(e?.message ?? e);
    return `DM send failed: ${msg}`;
  }
}
