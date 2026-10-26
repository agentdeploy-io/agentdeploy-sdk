/// <reference types="@cloudflare/workers-types" />

import type Database from "better-sqlite3";
import type { Lead } from "../db/types.js";
import {
  updateLead,
  isBlacklisted,
  logSentEmail,
  countSentToday,
  isPaused,
  isSendEnabled,
  isDryRun,
  getDailyCap,
  getSetting,
  isTestMode,
  getTestRecipient,
} from "../db/index.js";

export interface GateResult {
  proceed: boolean;
  reason: string;
  dryRun: boolean;
  email: string;
  name: string;
  subject: string;
  html: string;
  statusStr: string;
}

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function kwMatch(hay: string, kw: string): boolean {
  let re: RegExp;
  try {
    re = new RegExp(`(^|[^a-z0-9\\u00e0-\\u00ff])${escRe(kw)}([^a-z0-9\\u00e0-\\u00ff]|$)`, "i");
  } catch {
    return hay.indexOf(kw) >= 0;
  }
  return re.test(hay);
}

function escH(s: string | null | undefined): string {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const EMAIL_ADDRESS_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function emailAddress(v: unknown): string {
  if (typeof v !== "string") return "";
  const s = v.trim();
  return EMAIL_ADDRESS_RE.test(s) ? s : "";
}

/**
 * Pick the best deliverable email for a lead, preferring real addresses over
 * guesses: personal > role > guessed, and mx_ok over unverified. Corrupted
 * or unparseable contact data yields "" (fail closed — never email a
 * malformed address).
 */
export function pickBestEmail(lead: Lead): string {
  if (!lead.emails) return "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(lead.emails);
  } catch {
    // Legacy rows may hold a bare string address.
    return EMAIL_ADDRESS_RE.test(lead.emails.trim()) ? lead.emails.trim() : "";
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const rank = (e: any): number => {
    if (!e || typeof e !== "object") {
      return EMAIL_ADDRESS_RE.test(String(e)) ? 95 : -1; // bare string
    }
    const addr = emailAddress(e.address ?? e.addr ?? e.email);
    if (!addr) return -1;
    const kind = String(e.kind ?? "role");
    const kindBase = kind === "personal" ? 100 : kind === "guessed" ? 60 : 90;
    // An MX-failed address bounces — it must not outrank a verified one.
    return kindBase + (e.mx_ok === false ? -50 : 0);
  };
  const ranked = list
    .map((e) => ({ e, r: rank(e) }))
    .filter((x) => x.r >= 0)
    .sort((a, b) => b.r - a.r);
  if (ranked.length === 0) return "";
  return emailAddress(ranked[0]!.e.address ?? ranked[0]!.e.addr ?? ranked[0]!.e.email ?? ranked[0]!.e);
}

export function getFirstEmail(lead: Lead): string {
  return pickBestEmail(lead);
}

/**
 * Brand signature footer shared by the initial pitch and approved reply
 * sends: logo → brand name → "built by <domain>" → site/booking links →
 * STOP opt-out line. Returns a self-contained (opened + closed) div.
 */
export function buildSignatureFooter(
  env: Record<string, unknown>,
  leadName: string,
  country: string,
): string {
  const brandName = String(env.BRAND_NAME ?? "");
  const brandSite = String(env.BRAND_SITE_URL ?? "");
  const calendly = String(env.CALENDLY_URL ?? "");

  let html = '<div style="margin-top:22px;border-top:1px solid #e5e7eb;padding-top:14px;font-family:Helvetica,Arial,sans-serif;font-size:13px;color:#4b5563;line-height:1.6">';
  const logo = String(env.BRAND_LOGO_URL ?? "");
  if (logo) {
    html += `<img src="${escH(logo)}" alt="${escH(brandName)}" style="height:32px;display:block;margin-bottom:10px"><br>`;
  }
  if (brandName) {
    html += `<span style="font-size:14px;font-weight:600;color:#111827">${escH(brandName)}</span><br>`;
  }
  const brandDomain = brandSite.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  html += brandDomain
    ? `AI outreach agent built by ${escH(brandDomain)}<br>`
    : "AI outreach agent<br>";
  const links: string[] = [];
  if (brandSite) {
    links.push(`<a href="${escH(brandSite)}" style="color:#2563eb;text-decoration:none">${escH(brandSite.replace(/^https?:\/\//, ""))}</a>`);
  }
  if (calendly) {
    links.push(`<a href="${escH(calendly)}" style="color:#2563eb;text-decoration:none">book a call</a>`);
  }
  if (links.length) html += links.join(' &nbsp;·&nbsp; ') + "<br>";
  html += `<div style="margin-top:12px;font-size:11.5px;color:#9ca3af">You are receiving this because ${escH(leadName)} matched the business profile we are reaching out to in ${escH(String(country).toUpperCase())}. Reply <b>STOP</b> to opt out.</div>`;
  html += "</div>";
  return html;
}

function hasMxOk(lead: Lead): boolean {
  if (!lead.emails) return false;
  // Corrupted/unparseable contact data fails closed: we cannot confirm any
  // address is deliverable.
  try {
    const parsed = JSON.parse(lead.emails);
    if (Array.isArray(parsed) && parsed.length > 0) {
      return parsed.some((e: any) => (e && typeof e === "object" ? e.mx_ok !== false : true));
    }
    return false;
  } catch {
    // Legacy bare-string address — no MX info available.
    return EMAIL_ADDRESS_RE.test(lead.emails.trim());
  }
}

export function runGateStack(
  db: Database.Database,
  lead: Lead,
  env: Record<string, unknown>,
): GateResult {
  const settings = {
    sendEnabled: isSendEnabled(db),
    dryRun: isDryRun(db),
    dailyCap: getDailyCap(db),
  };

  const sentToday = countSentToday(db);
  const testRecipient = getTestRecipient(db);
  // Test mode redirects the send to the operator's own inbox — gates like
  // approval/pitch/dry-run/cap still apply, only the recipient changes.
  const useTest = isTestMode(db) && testRecipient !== "";
  const email = useTest ? testRecipient : getFirstEmail(lead);
  const name = lead.name;
  const subject = lead.pitch_subject ?? "";
  const body = lead.pitch_body ?? "";

  let reason = "";

  if (!lead) {
    reason = `lead not found`;
  } else if (lead.status === "opted_out") {
    reason = "lead has opted out (permanent)";
  } else if (lead.status === "rejected") {
    reason = "lead was rejected in review";
  } else if (lead.status !== "approved" && lead.stage !== "approved") {
    reason = `lead is not approved yet (status: ${lead.status ?? lead.stage} — run /approve first)`;
  } else if (!subject || !body) {
    reason = "lead has no pitch (re-run writer to draft)";
  } else if (!email && !useTest) {
    reason = "no contact address (run /verify first)";
  } else if (!useTest && !hasMxOk(lead)) {
    reason = "email MX check failed";
  } else if (isPaused(db)) {
    reason = "agent is paused (run /resume first)";
  } else if (!settings.sendEnabled) {
    reason = "sendEnabled is false (set it true in /settings)";
  } else if (sentToday >= settings.dailyCap) {
    reason = `daily cap reached (${sentToday}/${settings.dailyCap})`;
  }

  if (!reason && lead && !useTest) {
    const emailDomain = email.split("@")[1] ?? "";
    const blHit = isBlacklisted(db, {
      email,
      domain: emailDomain,
      company: lead.name,
    });
    if (blHit) reason = `blacklisted (/blacklist-remove to clear)`;
  }

  const blockedSics = String(getSetting(db, "blockedSics") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const blockedKeywords = String(getSetting(db, "blockedKeywords") ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);
  const maxHeadcount = Number(getSetting(db, "maxHeadcount") ?? 0);

  if (!reason && lead) {
    const sicVal = String(lead.sic ?? "").toLowerCase();
    for (const blocked of blockedSics) {
      if (blocked && sicVal.indexOf(blocked.toLowerCase()) === 0) {
        reason = `blocked vertical: SIC ${lead.sic ?? ""} matches ${blocked}`;
        break;
      }
    }
    if (!reason) {
      const hay = (
        String(lead.name ?? "") +
        " " +
        String(lead.website ?? "") +
        " " +
        sicVal
      ).toLowerCase();
      for (const kw of blockedKeywords) {
        if (kw && kwMatch(hay, kw.toLowerCase())) {
          reason = `blocked keyword: ${kw}`;
          break;
        }
      }
    }
    if (!reason && maxHeadcount > 0) {
      const classification = lead.classification ? JSON.parse(lead.classification) : {};
      const headcount = Number(classification.headcount ?? 0);
      if (headcount > maxHeadcount) {
        reason = `too large: headcount ${headcount} over max ${maxHeadcount}`;
      }
    }
  }

  const proceed = reason === "";

  let html = "";
  if (lead && body) {
    const paras = body.split(/\n\s*\n/);
    html = '<div style="font-family:Helvetica,Arial,sans-serif;font-size:15px;color:#1f2937;line-height:1.65">';
    for (const para of paras) {
      if (!para.trim()) continue;
      html += `<p style="margin:0 0 12px">${escH(para).replace(/\n/g, "<br>")}</p>`;
    }

    html += buildSignatureFooter(env, lead.name, lead.country);
    html += "</div>";
  }

  return {
    proceed,
    reason,
    dryRun: settings.dryRun,
    email: proceed ? email : "",
    name,
    subject,
    html,
    statusStr: proceed
      ? settings.dryRun
        ? "dry-run"
        : "queued"
      : `blocked:${reason}`,
  };
}

export async function sendViaBrevo(
  to: string,
  name: string,
  subject: string,
  html: string,
  env: Record<string, unknown>,
): Promise<{ messageId: string }> {
  const apiKey = env.BREVO_API_KEY as string;
  const senderEmail = String(env.BREVO_SENDER_EMAIL ?? "noreply@example.com");
  const senderName = String(env.BRAND_NAME ?? "Outreach");

  const res = await fetch("https://api.brevo.com/v3/smtp/email", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "api-key": apiKey,
    },
    body: JSON.stringify({
      sender: { name: senderName, email: senderEmail },
      to: [{ email: to, name }],
      subject,
      htmlContent: html,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Brevo ${res.status}: ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as { messageId?: string };
  return { messageId: data.messageId ?? "" };
}

export async function runOutreach(
  db: Database.Database,
  lead: Lead,
  env: Record<string, unknown>,
): Promise<GateResult> {
  const gate = runGateStack(db, lead, env);

  if (!gate.proceed) return gate;

  if (gate.dryRun) {
    logSentEmail(db, {
      lead_key: lead.key,
      email: gate.email,
      subject: gate.subject,
      message_id: null,
      status: "dry-run",
      at: new Date().toISOString(),
    });
    updateLead(db, lead.key, { stage: "sent", status: "sent" });
    return gate;
  }

  try {
    const { messageId } = await sendViaBrevo(
      gate.email,
      gate.name,
      gate.subject,
      gate.html,
      env,
    );

    logSentEmail(db, {
      lead_key: lead.key,
      email: gate.email,
      subject: gate.subject,
      message_id: messageId,
      status: "sent",
      at: new Date().toISOString(),
    });

    updateLead(db, lead.key, { stage: "sent", status: "sent" });

    return { ...gate, statusStr: "sent" };
  } catch (e: any) {
    logSentEmail(db, {
      lead_key: lead.key,
      email: gate.email,
      subject: gate.subject,
      message_id: null,
      status: `failed:${e.message}`,
      at: new Date().toISOString(),
    });
    return { ...gate, proceed: false, reason: `send failed: ${e.message}`, statusStr: "failed" };
  }
}
