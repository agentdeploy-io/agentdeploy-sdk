/**
 * Platform-agnostic command logic shared by the Telegram + WhatsApp adapters:
 * talking to the orchestrator (/ask), the fleet+approvals summary (/status),
 * and the per-platform help text. Rendering differences (HTML vs plain text,
 * edit vs follow-up) stay inside the adapters.
 */
import type { ApprovalRequest } from "@calla/shared";
import type { ChannelDeps, ChannelPlatform } from "./types.js";
import { errorMessage, safeStringify, stripMarkdown } from "./util.js";

/** Extract a plain string from a Mastra FullOutput (or any) agent result. */
function extractAgentText(out: unknown): string {
  if (typeof out === "string") return out;
  if (out && typeof out === "object") {
    const o = out as { text?: unknown; error?: unknown };
    if (o.error) return `Error: ${errorMessage(o.error)}`;
    if (typeof o.text === "string") return o.text;
  }
  return safeStringify(out);
}

/**
 * Ask the orchestrator a free-form question. Calls the Mastra agent's
 * `generate([{role:"user",content}])` (Mastra 1.74 API) and returns a
 * plain-ish (Markdown-stripped) reply. Never throws — errors become text.
 */
export async function askOrchestrator(deps: ChannelDeps, text: string): Promise<string> {
  const prompt = String(text ?? "").trim();
  if (!prompt) return "What would you like to ask the orchestrator?";
  try {
    const agent = deps.getAgent();
    if (!agent || typeof agent.generate !== "function") {
      return "The orchestrator agent is not available right now.";
    }
    const out = await agent.generate([{ role: "user", content: prompt }]);
    const reply = extractAgentText(out);
    return stripMarkdown(reply) || "(the orchestrator returned an empty response)";
  } catch (err) {
    return `Sorry, I couldn't reach the orchestrator: ${errorMessage(err)}`;
  }
}

/** Fleet + pending-approval summary (best-effort; edge /fleet may be absent). */
export async function fleetSummary(deps: ChannelDeps): Promise<string> {
  const lines: string[] = [];

  let mastra: ApprovalRequest[] = [];
  try {
    mastra = await deps.listPendingMastra();
  } catch (err) {
    lines.push(`Brain approvals: unavailable (${errorMessage(err)})`);
  }
  if (lines.length === 0) {
    const bySource: Record<string, number> = {};
    for (const r of mastra) bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    lines.push(`Pending brain approvals: ${mastra.length}`);
    for (const [source, count] of Object.entries(bySource)) {
      lines.push(`  ${source}: ${count}`);
    }
  }

  const edge = deps.edgeBaseUrl.replace(/\/+$/, "");
  try {
    const res = await fetch(`${edge}/fleet`, { headers: { accept: "application/json" } });
    if (res.ok) {
      const json = (await res.json().catch(() => null)) as
        | { agents?: { status?: string }[] }
        | null;
      const agents = json?.agents ?? [];
      const counts: Record<string, number> = {};
      for (const a of agents) {
        const status = a?.status ?? "unknown";
        counts[status] = (counts[status] ?? 0) + 1;
      }
      const parts = Object.entries(counts)
        .map(([status, count]) => `${status}: ${count}`)
        .join(", ");
      lines.push(
        `Fleet: ${agents.length} agent${agents.length === 1 ? "" : "s"}${parts ? ` (${parts})` : ""}`,
      );
    } else {
      lines.push(`Fleet: unavailable (edge responded ${res.status})`);
    }
  } catch (err) {
    lines.push(`Fleet: unreachable (${errorMessage(err)})`);
  }

  return lines.join("\n");
}

/** Per-platform help text. */
export function helpText(platform: ChannelPlatform): string {
  if (platform === "telegram") {
    return [
      "Calla bot — commands:",
      "/start <code> — bind this chat to Calla",
      "/status — fleet + pending approvals summary",
      "/approvals — list pending approvals with Approve/Decline",
      "/ask <question> — talk to the orchestrator (or just send text)",
      "/unbind — remove this chat binding",
      "/help — this message",
    ].join("\n");
  }
  return [
    "Calla bot — send one of:",
    "status — fleet + pending approvals summary",
    "approvals — list pending approvals with Approve/Decline buttons",
    "ask <question> — talk to the orchestrator (or just send text)",
    "<code> — bind this chat (send the 6-char code alone)",
    "unbind — remove this chat binding",
    "help — this message",
  ].join("\n");
}
