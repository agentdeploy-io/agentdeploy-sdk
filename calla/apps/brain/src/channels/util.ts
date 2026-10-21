/**
 * Small, dependency-free helpers shared across the channels module.
 * Kept local (instead of importing ../lib/*) so the module stays self-contained
 * and immune to concurrent edits elsewhere in the brain.
 */
import { randomBytes, randomInt } from "node:crypto";

/** Best-effort human string for any thrown value. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err) ?? String(err);
  } catch {
    return String(err);
  }
}

/** JSON.stringify that survives Error objects and BigInt values. */
export function safeStringify(value: unknown): string {
  try {
    return (
      JSON.stringify(value, (_key, v: unknown) => {
        if (v instanceof Error) return { name: v.name, message: v.message };
        if (typeof v === "bigint") return v.toString();
        return v;
      }) ?? "null"
    );
  } catch {
    return JSON.stringify({ error: "unserializable value", repr: String(value) });
  }
}

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escape the five HTML-sensitive chars (Telegram HTML parse mode). */
export function escapeHtml(text: string): string {
  return String(text).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch] ?? ch);
}

/** Mask a chat/user id, keeping only the last 4 chars (audit + listings). */
export function maskChatId(chatId: string): string {
  const s = String(chatId ?? "");
  if (s.length <= 4) return "•".repeat(Math.max(s.length, 1));
  return `••••${s.slice(-4)}`;
}

/** Truncate to `max` chars, appending an ellipsis marker when clipped. */
export function truncate(text: string, max: number): string {
  const s = String(text ?? "");
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Strip the most common Markdown affordances down to plain-ish text so chat
 * replies read naturally (LLM output is often Markdown).
 */
export function stripMarkdown(text: string): string {
  return String(text ?? "")
    .replace(/```[\s\S]*?```/g, (block) =>
      block.replace(/```[a-zA-Z0-9]*\n?/g, "").replace(/```/g, ""),
    ) // fenced code -> keep inner text
    .replace(/`([^`]+)`/g, "$1") // inline code
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1") // images -> alt text
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "$1 ($2)") // links -> text (url)
    .replace(/^\s{0,3}#{1,6}\s+/gm, "") // headings
    .replace(/^\s{0,3}>\s?/gm, "") // blockquotes
    .replace(/(\*\*|__)(.*?)\1/g, "$2") // bold
    .replace(/(\*|_)(.*?)\1/g, "$2") // italic
    .replace(/~~(.*?)~~/g, "$1") // strikethrough
    .replace(/^\s*[-*+]\s+/gm, "• ") // bullet lists
    .replace(/^\s*\d+\.\s+/gm, (m) => m.trim() + " ") // ordered lists
    .replace(/\n{3,}/g, "\n\n") // collapse blank runs
    .trim();
}

/**
 * Split text into <= max-char chunks, preferring line then word boundaries so
 * messages are not cut mid-token. Used for Telegram/WhatsApp 4096-char limits.
 */
export function chunkText(text: string, max: number): string[] {
  const s = String(text ?? "");
  if (s.length <= max) return [s];
  const chunks: string[] = [];
  let rest = s;
  while (rest.length > max) {
    let cut = rest.lastIndexOf("\n", max);
    if (cut <= 0) cut = rest.lastIndexOf(" ", max);
    if (cut <= 0) cut = max;
    chunks.push(rest.slice(0, cut).trimEnd());
    rest = rest.slice(cut).replace(/^\n/, "");
  }
  if (rest.length) chunks.push(rest);
  return chunks.filter((c) => c.length > 0);
}

const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/** Cryptographically-random code from an alphabet (binding codes: A-Z0-9). */
export function randomCode(length: number, alphabet = CODE_ALPHABET): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[randomInt(alphabet.length)];
  return out;
}

/** Compact base36 short id (callback registry keys). */
export function randomShortId(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (const b of bytes) out += (b % 36).toString(36);
  return out.slice(0, length).padEnd(length, "0");
}

/** Awaitable sleep. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function riskEmoji(risk: string | undefined | null): string {
  switch (risk) {
    case "low":
      return "🟢";
    case "medium":
      return "🟡";
    case "high":
      return "🟠";
    case "critical":
      return "🔴";
    default:
      return "🟡";
  }
}
