/** Deterministic reply matching, shared by the webhook and Brevo-poll paths.
 *  An inbound item only becomes a candidate reply when it (a) comes from an
 *  address we actually emailed, or (b) its subject threads one of our pitch
 *  subjects. Everything else — newsletters, other people's correspondence —
 *  is dropped BEFORE any LLM call, so the classifier is never asked to guess
 *  and never sees unmatched mail. */

export interface InboundMailItem {
  messageId: string;
  from: string;
  fromName: string;
  subject: string;
  body: string;
  at: string;
  spam: number;
}

export interface SentLeadRef {
  key: string;
  name: string;
  /** Every address this lead has actually been emailed (lead record + sent log). */
  emails: string[];
  subject: string;
}

const normAddr = (s: string) => s.trim().toLowerCase();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** All plausible addresses stored on a lead record (handles addr/address/
 *  email keys and legacy bare-string values). */
export function leadEmailAddresses(lead: { emails?: string | null }): string[] {
  if (!lead.emails) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(lead.emails);
  } catch {
    return EMAIL_RE.test(lead.emails.trim()) ? [lead.emails.trim()] : [];
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const out: string[] = [];
  for (const e of list) {
    const addr =
      typeof e === "string"
        ? e
        : e && typeof e === "object"
          ? String((e as any).addr ?? (e as any).address ?? (e as any).email ?? "")
          : "";
    if (EMAIL_RE.test(addr.trim())) out.push(addr.trim());
  }
  return out;
}

/** Strip leading "Re:/Fwd:/..." prefixes so thread subjects compare cleanly. */
const stripThreadPrefix = (s: string): string => {
  let v = s.trim().toLowerCase();
  let changed = true;
  while (changed) {
    changed = false;
    const m = v.match(/^\s*(?:\[)?\s*(?:re|fwd|fw|aw|iv|zv)\s*[:\-]?\s*(?:\])?/);
    if (m && m[0].length > 0) {
      v = v.slice(m[0].length);
      changed = true;
    }
  }
  return v.replace(/\s+/g, " ").trim();
};

export function matchReplyCandidates(
  items: InboundMailItem[],
  sentLeads: SentLeadRef[],
): Array<InboundMailItem & { candidates: string[] }> {
  const out: Array<InboundMailItem & { candidates: string[] }> = [];
  for (const item of items) {
    const from = normAddr(item.from);
    const subject = stripThreadPrefix(item.subject);
    const candidates: string[] = [];
    for (const lead of sentLeads) {
      const leadEmails = lead.emails.map(normAddr).filter(Boolean);
      const leadSubject = stripThreadPrefix(lead.subject);
      if (from && leadEmails.includes(from)) {
        candidates.push(lead.key);
        continue;
      }
      if (leadSubject.length > 0 && subject.includes(leadSubject)) {
        candidates.push(lead.key);
      }
    }
    if (candidates.length > 0) out.push({ ...item, candidates });
  }
  return out;
}
