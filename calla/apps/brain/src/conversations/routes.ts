/**
 * Conversations HTTP surface — the operator's "every customer conversation"
 * view over the social/WhatsApp threads recorded by the social engine
 * (channels/social/engine.ts) and the approval path (channels/decisions.ts).
 *
 * createConversationsApp({ store, getSender? }) builds a Hono sub-app mounted
 * at /conversations (behind the brain's bearer auth; no webhook paths).
 *
 * FROZEN CONTRACT (apps/ui codes against this — see the README's
 * "Conversations API" section; do not change shapes without telling the UI):
 *   GET    /conversations?platform=&limit=50
 *          → { conversations:[{ id:"<platform>:<userId>", platform, username?,
 *              phone?, lastMessage, lastAt, messageCount, takeover, leadKey?,
 *              flowRunId?, flowStatus?:"active"|"completed", flowTier? }], total }
 *   GET    /conversations/:id
 *          → { id, platform, contact:{ username?, phone?, externalUserId },
 *              messages:[{ dir, text, ts, auto?, kind?, approvalId? }],
 *              takeover, lead?:{ key, source },
 *              flowRun?:{ id, flowId, status, currentField?, answers, score?,
 *                         tier?, routing? } }
 *   POST   /conversations/:id/message   { text }  → { ok, message }
 *          manual operator send through the platform sender; provider/window
 *          errors → 502 { error } and NOTHING is stored (only successful sends
 *          are recorded, kind "manual", auto:false).
 *   POST   /conversations/:id/takeover  { on }    → { ok, takeover }
 *          pauses automation for this thread (audit "conversation.takeover").
 *   DELETE /conversations/:id                    → { ok, id }
 *          GDPR/retention wipe (thread row + index entry + audit
 *          "conversation.deleted").
 *
 * Additive (not in the frozen contract, safe for the UI to ignore):
 *   • `windowOpen?:boolean` on POST /:id/message for instagram/whatsapp — the
 *     platform 24h reply window state. A CLOSED window still ATTEMPTS the send
 *     (only the provider can decide); its error surfaces as 502 { error }.
 *   • kind "system" messages are thread notices that were NOT delivered to the
 *     customer (a pending approval, a declined draft) — they carry approvalId.
 */
import { Hono } from "hono";
import { z } from "zod";
import type { CallaStore } from "../store/types.js";
import { errorMessage, truncate } from "../channels/util.js";
import { readConfig } from "../channels/config.js";
import { sendWhatsAppText, type WhatsAppSendConfig } from "../channels/whatsapp.js";
import { enqueueSocialSend } from "../channels/social/queue.js";
import { getSocialSender, type SocialSender } from "../channels/social/senders.js";
import {
  IG_WINDOW_PREFIX,
  SOCIAL_CACHE_AGENT,
  WA_WINDOW_PREFIX,
} from "../channels/social/keys.js";
import { FlowStore } from "../flows/store.js";
import type { FlowTier } from "../flows/types.js";
import {
  CONVERSATIONS_CACHE_AGENT,
  ConversationStore,
  INDEX_CAP,
  parseConversationId,
  type ConversationIndexEntry,
  type ConversationMessage,
  type ConversationPlatform,
} from "./store.js";

export interface ConversationsAppDeps {
  store: CallaStore;
  /**
   * Platform sender resolver. Defaults to the social senders registry that
   * channels/app.ts populates at boot (the SAME mechanism decisions.ts uses to
   * deliver approved replies), with a WhatsApp fallback built from the channels
   * config. Injectable for tests.
   */
  getSender?: (platform: ConversationPlatform) => SocialSender | undefined;
}

const MESSAGE_TEXT_MAX = 4000;

const messageSchema = z.object({
  text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX),
});

const takeoverSchema = z.object({
  on: z.boolean(),
  /** Operator identity for the audit trail (defaults to "operator"). */
  by: z.string().trim().max(120).optional(),
});

function isPlatform(v: string | undefined): v is ConversationPlatform {
  return (
    v === "instagram" || v === "tiktok" || v === "whatsapp" || v === "voice"
  );
}

/** GET /conversations row: the index entry + its flow-run enrichment. */
type ConversationListRow = ConversationIndexEntry & {
  flowStatus?: "active" | "completed";
  flowTier?: FlowTier;
};

/**
 * WhatsApp fallback sender: the registry only holds one while customer mode is
 * enabled, but a MANUAL operator reply is not automation — so build the exact
 * same Cloud API send (sendWhatsAppText, shared with the operator console) from
 * the channels config when the credentials exist.
 */
function fallbackSender(
  platform: ConversationPlatform,
): SocialSender | undefined {
  if (platform !== "whatsapp") return undefined;
  const wa = readConfig().whatsapp;
  if (!wa.token || !wa.phoneNumberId) return undefined;
  const cfg: WhatsAppSendConfig = {
    apiBase: wa.apiBase,
    token: wa.token,
    phoneNumberId: wa.phoneNumberId,
  };
  return {
    send: (target, text) =>
      enqueueSocialSend("whatsapp", () => sendWhatsAppText(cfg, target, text)),
  };
}

/**
 * Platform 24h reply-window state (informational): IG `social:ig:window:<id>`,
 * WhatsApp `social:wa:window:<phone>`; null for platforms without one. A closed
 * window never blocks a manual send — Meta does (error 131047 → 502).
 */
async function windowOpen(
  store: CallaStore,
  platform: ConversationPlatform,
  userId: string,
): Promise<boolean | null> {
  const prefix =
    platform === "instagram"
      ? IG_WINDOW_PREFIX
      : platform === "whatsapp"
        ? WA_WINDOW_PREFIX
        : null;
  if (!prefix) return null;
  const rec = await store
    .cacheGet(`${prefix}${userId}`, SOCIAL_CACHE_AGENT)
    .catch(() => null);
  return rec != null;
}

export function createConversationsApp(deps: ConversationsAppDeps): Hono {
  const convs = new ConversationStore(deps.store);
  const flows = new FlowStore(deps.store);
  const resolveSender =
    deps.getSender ??
    ((platform: ConversationPlatform) =>
      // Voice threads have no outbound sender (no live PSTN channel to push
      // a manual send into) — operator sends on them are refused (502).
      platform === "voice"
        ? null
        : getSocialSender(platform) ?? fallbackSender(platform));

  const app = new Hono();

  /** Best-effort flow-run read (never fails the request). */
  async function loadRun(runId: string | undefined) {
    if (!runId) return null;
    try {
      return await flows.getRun(runId);
    } catch (err) {
      console.warn("[conversations] flow run load failed:", errorMessage(err));
      return null;
    }
  }

  /** List-row enrichment: flowStatus (contract union) + flowTier. */
  async function enrichEntry(
    entry: ConversationIndexEntry,
  ): Promise<ConversationListRow> {
    const run = await loadRun(entry.flowRunId);
    if (!run) return entry;
    return {
      ...entry,
      // The frozen contract only allows "active" | "completed" here; a
      // cancelled run keeps flowRunId but no flowStatus.
      ...(run.status === "active" || run.status === "completed"
        ? { flowStatus: run.status }
        : {}),
      ...(run.tier ? { flowTier: run.tier } : {}),
    };
  }

  // ── List ───────────────────────────────────────────────────────

  app.get("/", async (c) => {
    const platformParam = c.req.query("platform");
    let platform: ConversationPlatform | undefined;
    if (platformParam) {
      if (!isPlatform(platformParam)) {
        return c.json(
          {
            error: `invalid platform: ${platformParam} (expected instagram | tiktok | whatsapp | voice)`,
          },
          400,
        );
      }
      platform = platformParam;
    }
    const limitRaw = Number(c.req.query("limit") ?? "");
    const limit =
      Number.isFinite(limitRaw) && limitRaw >= 1
        ? Math.min(Math.trunc(limitRaw), INDEX_CAP)
        : 50;
    const entries = await convs.listThreads({
      ...(platform ? { platform } : {}),
      limit,
    });
    const conversations = await Promise.all(entries.map(enrichEntry));
    return c.json({ conversations, total: conversations.length });
  });

  // ── Detail ─────────────────────────────────────────────────────

  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    const parts = parseConversationId(id);
    if (!parts) {
      return c.json(
        { error: `invalid conversation id: ${truncate(id, 80)} (expected "<platform>:<userId>")` },
        400,
      );
    }
    const thread = await convs.getThread(id);
    if (!thread) return c.json({ error: `unknown conversation: ${id}` }, 404);
    const run = await loadRun(thread.flowRunId);
    return c.json({
      id,
      platform: parts.platform,
      contact: thread.contact,
      messages: thread.messages,
      takeover: Boolean(thread.takeover?.on),
      ...(thread.leadKey
        ? { lead: { key: thread.leadKey, source: parts.platform } }
        : {}),
      ...(run
        ? {
            flowRun: {
              id: run.id,
              flowId: run.flowId,
              status: run.status,
              ...(run.currentField ? { currentField: run.currentField } : {}),
              answers: run.answers,
              ...(run.score !== undefined ? { score: run.score } : {}),
              ...(run.tier ? { tier: run.tier } : {}),
              ...(run.routing ? { routing: run.routing } : {}),
            },
          }
        : {}),
    });
  });

  // ── Voice transcript recording (B2) ────────────────────────────
  // The Telnyx voice DO (edge) is the sole writer of voice threads: one
  // thread per call id (`voice:<callId>`), transcript lines appended as they
  // happen. Record-only — never delivers to a platform sender (there is no
  // sender for a finished/active PSTN call); operator sends on voice
  // threads are refused by POST /:id/message (502, no sender).
  const transcriptSchema = z.object({
    dir: z.enum(["inbound", "outbound"]),
    text: z.string().trim().min(1).max(MESSAGE_TEXT_MAX),
    kind: z
      .enum(["message", "flow_prompt", "persona", "static", "approval_result", "manual", "system"])
      .optional(),
    auto: z.boolean().optional(),
    phone: z.string().trim().max(40).optional(),
    username: z.string().trim().max(120).optional(),
  });

  app.post("/:id/transcript", async (c) => {
    const id = c.req.param("id");
    const parts = parseConversationId(id);
    if (!parts) {
      return c.json(
        { error: `invalid conversation id: ${truncate(id, 80)} (expected "<platform>:<userId>")` },
        400,
      );
    }
    if (parts.platform !== "voice") {
      return c.json(
        { error: `transcript recording is only supported for voice threads, not ${parts.platform}` },
        400,
      );
    }
    const parsed = transcriptSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const { dir, text, kind, auto, phone, username } = parsed.data;
    try {
      if (dir === "inbound") {
        const recorded = await convs.recordInbound({
          platform: "voice",
          externalUserId: parts.userId,
          ...(phone ? { phone } : {}),
          ...(username ? { username } : {}),
          text,
          ...(kind ? { kind } : {}),
        });
        if (!recorded) return c.json({ error: `unknown conversation: ${id}` }, 404);
      } else {
        const recorded = await convs.recordOutbound({
          platform: "voice",
          externalUserId: parts.userId,
          text,
          kind: kind ?? "message",
          auto: auto ?? true,
          ...(phone ? { phone } : {}),
          ...(username ? { username } : {}),
        });
        if (!recorded) return c.json({ error: `unknown conversation: ${id}` }, 404);
      }
      return c.json({ ok: true });
    } catch (err) {
      console.warn("[conversations] transcript record failed:", errorMessage(err));
      return c.json({ error: "failed to record transcript" }, 500);
    }
  });

  // ── Manual operator send ───────────────────────────────────────

  app.post("/:id/message", async (c) => {
    const id = c.req.param("id");
    const parts = parseConversationId(id);
    if (!parts) {
      return c.json(
        { error: `invalid conversation id: ${truncate(id, 80)} (expected "<platform>:<userId>")` },
        400,
      );
    }
    const parsed = messageSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const thread = await convs.getThread(id);
    if (!thread) return c.json({ error: `unknown conversation: ${id}` }, 404);

    const sender = resolveSender(parts.platform);
    if (!sender) {
      return c.json(
        { error: `the ${parts.platform} sender is not available — cannot deliver this reply` },
        502,
      );
    }
    const window = await windowOpen(deps.store, parts.platform, parts.userId);
    const text = parsed.data.text;
    try {
      await sender.send(parts.userId, text);
    } catch (err) {
      // Provider/window rejection (e.g. Meta 131047 outside the 24h window):
      // surface the message and store NOTHING.
      return c.json(
        { error: errorMessage(err), ...(window === null ? {} : { windowOpen: window }) },
        502,
      );
    }

    const ts = new Date().toISOString();
    const stored: ConversationMessage | null = await convs.recordOutbound({
      platform: parts.platform,
      externalUserId: parts.userId,
      ...(thread.contact.username ? { username: thread.contact.username } : {}),
      ...(thread.contact.phone ? { phone: thread.contact.phone } : {}),
      text,
      ts,
      kind: "manual",
      auto: false,
    });
    try {
      await deps.store.appendAudit({
        agentId: CONVERSATIONS_CACHE_AGENT,
        kind: "conversation.manual_sent",
        entry: {
          id,
          platform: parts.platform,
          chars: text.length,
          ...(window === null ? {} : { windowOpen: window }),
        },
      });
    } catch (err) {
      console.warn("[conversations] appendAudit(conversation.manual_sent) failed:", errorMessage(err));
    }
    return c.json({
      ok: true,
      // Contract shape guaranteed even if the thread write failed.
      message: stored ?? { dir: "out", text, ts, auto: false, kind: "manual" },
      ...(window === null ? {} : { windowOpen: window }),
    });
  });

  // ── Takeover (pause automation for one thread) ─────────────────

  app.post("/:id/takeover", async (c) => {
    const id = c.req.param("id");
    const parts = parseConversationId(id);
    if (!parts) {
      return c.json(
        { error: `invalid conversation id: ${truncate(id, 80)} (expected "<platform>:<userId>")` },
        400,
      );
    }
    const parsed = takeoverSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) {
      return c.json({ error: "Invalid request body", details: parsed.error.issues }, 400);
    }
    const thread = await convs.getThread(id);
    if (!thread) return c.json({ error: `unknown conversation: ${id}` }, 404);
    const takeover = await convs.setTakeover(id, parsed.data.on, parsed.data.by ?? "operator");
    if (takeover === null) {
      return c.json({ error: "conversation store unavailable" }, 500);
    }
    return c.json({ ok: true, takeover });
  });

  // ── Deletion (retention / GDPR) ────────────────────────────────

  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    const parts = parseConversationId(id);
    if (!parts) {
      return c.json(
        { error: `invalid conversation id: ${truncate(id, 80)} (expected "<platform>:<userId>")` },
        400,
      );
    }
    const thread = await convs.getThread(id);
    if (!thread) return c.json({ error: `unknown conversation: ${id}` }, 404);
    const deleted = await convs.deleteThread(id);
    if (!deleted) {
      return c.json({ error: `could not delete conversation: ${id}` }, 500);
    }
    return c.json({ ok: true, id });
  });

  return app;
}
