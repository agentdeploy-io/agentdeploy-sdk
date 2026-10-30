import type DatabaseType from "better-sqlite3";
import {
  gatewayFetchWithBackoff,
  gatewayHeaders,
  parseLlmJson,
} from "@agentdeploy-io/edge-sdk";
import { nextBookingSlots, googleCalendarLink, type BookingSlot } from "./booking.js";

export interface DraftThread {
  key: string;
  name: string;
  leadSubject: string;
  replyFrom: string;
  replySubject: string;
  replyBody: string;
}

export interface DraftResult {
  key: string;
  subject: string;
  body: string;
  /** Slot the customer picked, when unambiguous. */
  slotIndex?: number;
}

interface LlmDraftOut {
  replies?: Array<{ key?: string; subject?: string; body?: string; slotIndex?: number }>;
}

/**
 * Draft agent replies to inbound threads. When a lead shows interest the
 * agent offers concrete booking slots; when the lead picks one, the draft
 * carries `slotIndex` so the caller can record the booking and append the
 * Google Calendar link.
 */
export async function draftReplyWithBooking(
  threads: DraftThread[],
  env: Record<string, unknown>,
  db?: DatabaseType.Database,
): Promise<{ drafts: DraftResult[]; slots: BookingSlot[] }> {
  const slots = nextBookingSlots(4);
  const brandName = String(env.BRAND_NAME ?? "");
  const calendly = String(env.CALENDLY_URL ?? "");
  const t0 = Date.now();

  const slotList = slots.map((s) => ({ index: s.index, label: s.label }));
  const calendlyLine = calendly
    ? `Prefer the booking link when available: ${calendly}`
    : "No external booking link is available — propose slots from the list below.";

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
          content:
            `You are the brand's AI outreach agent replying to inbound email.\n` +
            `Brand: ${brandName}. Calendly: ${calendly || "not available"}.\n` +
            `For each thread write one short reply (40-80 words).\n` +
            `Acknowledge what they wrote, answer directly, propose a next step.\n` +
            `Never re-pitch, never quote pricing, never claim to be human.\n` +
            `\nBooking slots offered to interested leads (London time):\n` +
            `${JSON.stringify(slotList)}\n` +
            `${calendlyLine}\n` +
            `If the customer explicitly chose a time that matches one of the slot labels (same day + hour), ` +
            `write a short confirmation naming that time and set "slotIndex" to that slot's index. ` +
            `If they showed interest but did not pick a time, propose two slots by their exact label and do NOT set slotIndex. ` +
            `If they are not interested in a call, do not set slotIndex.\n` +
            `Return ONLY JSON: {"replies":[{"key":"...","subject":"Re: ...","body":"...","slotIndex":int?}]}`,
        },
        {
          role: "user",
          content: JSON.stringify({ brand: { name: brandName, slots: slotList }, threads }),
        },
      ],
    }),
  }, { env });

  if (!res.ok) return { drafts: [], slots };

  const raw = parseLlmJson(await res.json()) as LlmDraftOut;
  if (db) {
    const { logLlmTrace } = await import("../db/index.js");
    logLlmTrace(db, {
      stage: "reply-draft",
      leadKey: threads.length === 1 ? threads[0].key : `${threads.length} threads`,
      model: String(env.AD_MODEL ?? ""),
      promptExcerpt: JSON.stringify(threads.map((t) => ({ key: t.key, replyBody: t.replyBody.slice(0, 200) }))),
      rawResponse: JSON.stringify(raw),
      latencyMs: Date.now() - t0,
    });
  }

  const drafts: DraftResult[] = [];
  for (const r of Array.isArray(raw.replies) ? raw.replies : []) {
    if (!r || typeof r.key !== "string" || typeof r.body !== "string") continue;
    const d: DraftResult = {
      key: r.key,
      subject: typeof r.subject === "string" && r.subject ? r.subject : "Re: your message",
      body: r.body,
    };
    if (typeof r.slotIndex === "number" && Number.isInteger(r.slotIndex) && slots[r.slotIndex]) {
      d.slotIndex = r.slotIndex;
    }
    drafts.push(d);
  }
  return { drafts, slots };
}

/** Calendar link for a confirmed booking slot. */
export function bookingCalendarLink(leadName: string, slot: BookingSlot, brandName: string): string {
  return googleCalendarLink(
    `Call: ${leadName}`,
    slot.start,
    slot.end,
    `Meeting with ${brandName} about AI agents.`,
  );
}
