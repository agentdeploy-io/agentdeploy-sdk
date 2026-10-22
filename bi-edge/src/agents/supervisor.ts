/// <reference types="@cloudflare/workers-types" />

import { createAgent } from "@agentdeploy-io/edge-sdk";
import type { AgentDeployAgent } from "@agentdeploy-io/edge-sdk";
import Database from "better-sqlite3";
import {
  listLeads,
  getLead,
  updateLead,
  batchUpdateLeads,
  deleteLead,
  countByStage,
  listBlacklist,
  addToBlacklist,
  removeFromBlacklist,
  isBlacklisted,
  logSentEmail,
  listRecentSent,
  getRepliesByLead,
  listRecentReplies,
  getPendingDrafts,
  getReplyLogById,
  updateReplyDraft,
  getAllSettings,
  setSetting,
  getSettingsWithDefaults,
  isPaused,
  isSendEnabled,
  isDryRun,
  getDailyCap,
  countSentToday,
  listCrawlRuns,
  SCHEMA_V1,
  runMigrations,
} from "../db/index.js";
import type {
  Lead,
  LeadStage,
  LeadStatus,
  LeadPatch,
  BlacklistKind,
  DraftStatus,
} from "../db/types.js";
import { runQualifier } from "./qualifier.js";
import { runResearcher } from "./researcher.js";
import { runWriter } from "./writer.js";
import { runOutreach, sendViaBrevo, buildSignatureFooter, getFirstEmail, type GateResult } from "./outreach.js";

type HitlState = {
  pendingApprovals: string[];
  pendingReplies: number[];
  paused: boolean;
};

export const COMMANDS = [
  "/leads", "/run", "/verify", "/approve", "/send", "/poll",
  "/settings", "/sent", "/replies", "/erase", "/status",
  "/pause", "/resume", "/test-send", "/reply-list", "/send-reply", "/discard-reply",
  "/blacklist", "/blacklist-list", "/blacklist-remove", "/add-lead",
  "/blacklist-import", "/blacklist-export", "/pending",
  "/approve-batch", "/export-csv", "/import-csv",
] as const;

export function parseCommand(text: string): { cmd: string; args: string[] } {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/")) return { cmd: "chat", args: [trimmed] };
  const parts = trimmed.split(/\s+/);
  const cmd = parts[0].toLowerCase();
  const args = parts.slice(1);
  return { cmd, args };
}

function initDb(env: Record<string, unknown>): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

/**
 * Approve-and-send a pending reply draft (G3): the draft text goes out
 * through the same Brevo path as initial outreach, carrying the brand
 * signature footer. Honours dryRun (logs a dry-run entry, no network),
 * sendEnabled, the daily cap, pause, and lead opt-out state. Marks the
 * draft `sent` and the lead `replied` on success.
 */
async function sendReplyDraft(
  db: Database.Database,
  id: number,
  env: Record<string, unknown>,
): Promise<string> {
  const entry = getReplyLogById(db, id);
  if (!entry) return `Reply log ${id} not found`;
  if (!entry.draft) return `Reply ${id} has no draft to send`;
  if (entry.draft_status === "sent") return `Reply ${id} was already sent`;
  if (entry.draft_status === "discarded") return `Reply ${id} was discarded`;

  const lead = getLead(db, entry.lead_key);
  if (!lead) return `Lead ${entry.lead_key} no longer exists`;
  if (lead.status === "opted_out") return `Lead ${lead.key} has opted out — not sending`;
  if (lead.status === "rejected") return `Lead ${lead.key} was rejected — not sending`;

  const to = entry.reply_from || getFirstEmail(lead);
  if (!to) return `No recipient address for reply ${id}`;

  if (isPaused(db)) return "Pipeline is paused — run /resume first";
  const dryRun = isDryRun(db);
  if (!dryRun && !isSendEnabled(db)) return "sendEnabled is false — set it true in /settings first";
  if (!dryRun) {
    const cap = getDailyCap(db);
    const sentToday = countSentToday(db);
    if (sentToday >= cap) return `Daily cap reached (${sentToday}/${cap})`;
  }

  let rawSubject = entry.reply_subject || lead.pitch_subject || "";
  while (/^\s*(re|fw|fwd)\s*(:|\.\s*)\s*/i.test(rawSubject)) {
    rawSubject = rawSubject.replace(/^\s*(re|fw|fwd)\s*(:|\.\s*)\s*/i, "");
  }
  const subject = `Re: ${rawSubject.replace(/\s+$/, "")}`;
  const html =
    `<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.65">` +
    `<p style="margin:0 0 12px">${entry.draft
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\n/g, "<br>")}</p>` +
    buildSignatureFooter(env, lead.name, lead.country) +
    "</div>";

  const at = new Date().toISOString();
  if (dryRun) {
    logSentEmail(db, { lead_key: lead.key, email: to, subject, message_id: null, status: "dry-run", at });
    updateReplyDraft(db, id, entry.draft, "sent");
    updateLead(db, lead.key, { stage: "replied", status: "replied" });
    return `Reply ${id} DRY-RUN → ${to} (subject: ${subject}) — no email sent`;
  }

  try {
    const { messageId } = await sendViaBrevo(to, lead.name, subject, html, env);
    logSentEmail(db, { lead_key: lead.key, email: to, subject, message_id: messageId, status: "sent", at });
    updateReplyDraft(db, id, entry.draft, "sent");
    updateLead(db, lead.key, { stage: "replied", status: "replied" });
    return `Reply ${id} sent → ${to} (subject: ${subject}, message ${messageId || "queued"})`;
  } catch (e: any) {
    return `Reply ${id} failed to send: ${e.message}`;
  }
}

export async function handleCommand(
  cmd: string,
  args: string[],
  db: Database.Database,
  env: Record<string, unknown>,
): Promise<string> {
  switch (cmd) {
    case "/leads": {
      const stage = args[0] as LeadStage | undefined;
      const result = listLeads(db, { stage, page: 1, pageSize: 25 });
      if (result.rows.length === 0) return "No leads found.";
      const lines = result.rows.map((l, i) =>
        `${i + 1}. ${l.name} (${l.country}) — ${l.stage} [${l.status ?? "pending"}]`
      );
      return `**Leads (${result.total} total):**\n${lines.join("\n")}`;
    }

    case "/add-lead": {
      if (args.length < 2) return "Usage: /add-lead <name> <country>";
      const name = args.slice(0, -1).join(" ");
      const country = args[args.length - 1].toUpperCase();
      const key = `${country}:${name.toLowerCase().replace(/\s+/g, "-")}`;
      const existing = getLead(db, key);
      if (existing) return `Lead already exists: ${key}`;
      const lead: Lead = {
        key,
        name,
        country,
        stage: "raw",
        status: "pending_review",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      const { upsertLead } = await import("../db/leads.js");
      upsertLead(db, lead);
      return `Added lead: ${key}`;
    }

    case "/run": {
      const key = args[0];
      if (!key) return "Usage: /run <lead_key>";
      const lead = getLead(db, key);
      if (!lead) return `Lead not found: ${key}`;
      try {
        await runQualifier(db, lead, env);
        return `Classified ${key}`;
      } catch (e: any) {
        return `Classification failed: ${e.message}`;
      }
    }

    case "/verify": {
      const key = args[0];
      if (!key) return "Usage: /verify <lead_key>";
      const lead = getLead(db, key);
      if (!lead) return `Lead not found: ${key}`;
      try {
        const evidence = await runResearcher(db, lead, env);
        return `Researched ${key}: ${evidence.services.length} services, ${evidence.techStack.length} tech`;
      } catch (e: any) {
        return `Research failed: ${e.message}`;
      }
    }

    case "/approve": {
      const key = args[0];
      if (!key) return "Usage: /approve <lead_key>";
      const lead = getLead(db, key);
      if (!lead) return `Lead not found: ${key}`;
      updateLead(db, key, { stage: "approved", status: "approved" });
      return `Approved: ${key}`;
    }

    case "/approve-batch": {
      const keys = args.filter(Boolean);
      if (keys.length === 0) return "Usage: /approve-batch <key1> [key2] ...";
      const count = batchUpdateLeads(db, keys, { stage: "approved", status: "approved" });
      return `Approved ${count} leads`;
    }

    case "/send": {
      const key = args[0];
      if (!key) return "Usage: /send <lead_key>";
      const lead = getLead(db, key);
      if (!lead) return `Lead not found: ${key}`;
      try {
        const result: GateResult = await runOutreach(db, lead, env);
        if (!result.proceed) return `Blocked: ${result.reason}`;
        return `Sent to ${key} (${result.statusStr})`;
      } catch (e: any) {
        return `Send failed: ${e.message}`;
      }
    }

    case "/test-send": {
      const key = args[0];
      if (!key) return "Usage: /test-send <lead_key>";
      const lead = getLead(db, key);
      if (!lead) return `Lead not found: ${key}`;
      const prevDryRun = db.prepare("SELECT value FROM settings WHERE key = 'dryRun'").get() as { value: string } | undefined;
      setSetting(db, "dryRun", "true");
      try {
        const result = await runOutreach(db, lead, env);
        if (prevDryRun) setSetting(db, "dryRun", prevDryRun.value);
        return `Test send: ${result.statusStr} — ${result.proceed ? "would send" : result.reason}`;
      } catch (e: any) {
        if (prevDryRun) setSetting(db, "dryRun", prevDryRun.value);
        return `Test send failed: ${e.message}`;
      }
    }

    case "/status": {
      const counts = countByStage(db);
      const settings = getSettingsWithDefaults(db);
      const sentToday = countSentToday(db);
      const lines = [
        `Pipeline status: ${settings.paused ? "PAUSED" : "RUNNING"}`,
        `Send enabled: ${settings.sendEnabled} | Dry run: ${settings.dryRun}`,
        `Daily cap: ${settings.dailyCap} | Sent today: ${sentToday}`,
        "",
        "Stage counts:",
        ...Object.entries(counts).map(([stage, count]) => `  ${stage}: ${count}`),
      ];
      return lines.join("\n");
    }

    case "/pause": {
      setSetting(db, "paused", "true");
      return "Pipeline paused";
    }

    case "/resume": {
      setSetting(db, "paused", "false");
      return "Pipeline resumed";
    }

    case "/settings": {
      if (args.length === 0) {
        const all = getAllSettings(db);
        const lines = Object.entries(all).map(([k, v]) => `${k} = ${v}`);
        return lines.length > 0 ? `**Settings:**\n${lines.join("\n")}` : "No settings configured";
      }
      if (args.length >= 2) {
        const key = args[0];
        const value = args.slice(1).join(" ");
        setSetting(db, key, value);
        return `Set ${key} = ${value}`;
      }
      return "Usage: /settings [key value]";
    }

    case "/sent": {
      const limit = Number(args[0]) || 25;
      const entries = listRecentSent(db, limit);
      if (entries.length === 0) return "No sent emails";
      const lines = entries.map((e) =>
        `${e.at.slice(0, 16)} ${e.lead_key} → ${e.email} [${e.status}]`
      );
      return `**Sent (${entries.length}):**\n${lines.join("\n")}`;
    }

    case "/replies":
    case "/reply-list": {
      const drafts = getPendingDrafts(db);
      if (drafts.length === 0) return "No pending reply drafts";
      const lines = drafts.map((d) =>
        `[${d.id}] ${d.lead_key} from ${d.reply_from} (${d.intent}) — draft: ${(d.draft ?? "").slice(0, 80)}...`
      );
      return `**Pending drafts (${drafts.length}):**\n${lines.join("\n")}\nUse /send-reply <id> to approve & send, /discard-reply <id> to drop`;
    }

    case "/send-reply": {
      const id = Number(args[0]);
      if (!id) return "Usage: /send-reply <reply_log_id>";
      return sendReplyDraft(db, id, env);
    }

    case "/discard-reply": {
      const id = Number(args[0]);
      if (!id) return "Usage: /discard-reply <reply_log_id>";
      const entry = getReplyLogById(db, id);
      if (!entry) return `Reply log ${id} not found`;
      if (entry.draft_status === "sent" || entry.draft_status === "discarded") {
        return `Reply ${id} is already ${entry.draft_status}`;
      }
      const success = updateReplyDraft(db, id, entry.draft ?? "", "discarded");
      return success ? `Reply draft ${id} discarded` : `Reply log ${id} not found`;
    }

    case "/erase": {
      const key = args[0];
      if (!key) return "Usage: /erase <lead_key>";
      const deleted = deleteLead(db, key);
      return deleted ? `Deleted: ${key}` : `Not found: ${key}`;
    }

    case "/poll": {
      return "Reply poll triggered — check /replies for results";
    }

    case "/blacklist": {
      if (args.length < 1) return "Usage: /blacklist <id> [kind]";
      const id = args[0];
      const kind = (args[1] ?? "any") as BlacklistKind;
      addToBlacklist(db, id, kind);
      return `Blacklisted: ${id} (${kind})`;
    }

    case "/blacklist-list": {
      const entries = listBlacklist(db);
      if (entries.length === 0) return "Blacklist is empty";
      const lines = entries.map((e) => `${e.id} (${e.kind}) — ${e.created_at.slice(0, 10)}`);
      return `**Blacklist (${entries.length}):**\n${lines.join("\n")}`;
    }

    case "/blacklist-remove": {
      const id = args[0];
      if (!id) return "Usage: /blacklist-remove <id>";
      const removed = removeFromBlacklist(db, id);
      return removed ? `Removed from blacklist: ${id}` : `Not found: ${id}`;
    }

    case "/blacklist-import": {
      if (args.length === 0) return "Usage: /blacklist-import <json_array>";
      try {
        const entries = JSON.parse(args.join(" ")) as Array<{ id: string; kind?: BlacklistKind }>;
        let count = 0;
        for (const entry of entries) {
          addToBlacklist(db, entry.id, entry.kind ?? "any");
          count++;
        }
        return `Imported ${count} blacklist entries`;
      } catch (e: any) {
        return `Import failed: ${e.message}`;
      }
    }

    case "/blacklist-export": {
      const entries = listBlacklist(db);
      return JSON.stringify(entries, null, 2);
    }

    case "/pending": {
      const result = listLeads(db, { status: "pending_review", page: 1, pageSize: 25 });
      if (result.rows.length === 0) return "No pending leads";
      const lines = result.rows.map((l) => `${l.key} — ${l.name} (${l.country}) ${l.stage}`);
      return `**Pending review (${result.total}):**\n${lines.join("\n")}`;
    }

    case "/export-csv": {
      const result = listLeads(db, { page: 1, pageSize: 10000 });
      const header = "key,country,name,sic,stage,status,website,emails";
      const rows = result.rows.map((l) =>
        [l.key, l.country, `"${l.name}"`, l.sic ?? "", l.stage, l.status ?? "", l.website ?? "", l.emails ?? ""].join(",")
      );
      return header + "\n" + rows.join("\n");
    }

    case "/import-csv": {
      return "CSV import: POST to /cmd/data/import with CSV body";
    }

    case "chat": {
      return "BI-Edge supervisor ready. Commands: " + COMMANDS.join(", ");
    }

    default:
      return `Unknown command: ${cmd}. Available: ${COMMANDS.join(", ")}`;
  }
}

export const Supervisor = createAgent<HitlState>({
  name: "supervisor",

  onStart() {
    this.setState({
      pendingApprovals: [],
      pendingReplies: [],
      paused: false,
    });
  },

  async onRequest(request: Request) {
    const url = new URL(request.url);

    if (request.method !== "POST") {
      return new Response(
        JSON.stringify({
          status: "ok",
          agent: "supervisor",
          commands: COMMANDS,
        }),
        { headers: { "Content-Type": "application/json" } },
      );
    }

    const body = await request.json() as { message?: string; text?: string };
    const text = body.message ?? body.text ?? "";
    const env = this.env as Record<string, unknown>;
    const db = initDb(env);

    try {
      const { cmd, args } = parseCommand(text);
      const reply = await handleCommand(cmd, args, db, env);
      db.close();
      return new Response(JSON.stringify({ reply }), {
        headers: { "Content-Type": "application/json" },
      });
    } catch (e: any) {
      db.close();
      return new Response(
        JSON.stringify({ error: e.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
  },
});
