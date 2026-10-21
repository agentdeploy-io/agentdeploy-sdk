/**
 * DORMANT (B3): fish.audio chat read-aloud path. Superseded by the live
 * telephony voice agent (agents voice SDK + Telnyx) and the Calls module.
 * Kept for reference; no UI code imports this anymore.
 *
 * Voice helpers for the Calla UI chat (fish.audio via the platform).
 *
 * The browser never talks to fish.audio directly — everything goes through
 * the platform's /v1/voice/* console API (edge-JWT authed, same-origin
 * proxy), so the provider key stays server-side.
 */

import { authFetch } from "@/hooks/useAuthFetch";
import { DEPLOYMENT_API_URL } from "@/constants/auth";

const apiBase = () => DEPLOYMENT_API_URL.replace(/\/+$/, "");

export interface VoiceStatus {
  enabled: boolean;
  hasVoice: boolean;
  ttsModel: string;
}

export async function getVoiceStatus(): Promise<VoiceStatus | null> {
  try {
    const res = await authFetch(`${apiBase()}/v1/voice/status`, {
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Partial<VoiceStatus>;
    return {
      enabled: !!data.enabled,
      hasVoice: !!data.hasVoice,
      ttsModel: typeof data.ttsModel === "string" ? data.ttsModel : "",
    };
  } catch {
    return null;
  }
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.startsWith("data:") ? result.slice(result.indexOf(",") + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Transcribe a recorded audio clip; resolves to the transcript text. */
export async function transcribeAudio(blob: Blob): Promise<string> {
  if (blob.size === 0) throw new Error("Recording is empty");
  if (blob.size > 15 * 1024 * 1024) throw new Error("Recording is too long (15 MB max)");
  const audioBase64 = await blobToBase64(blob);
  const res = await authFetch(`${apiBase()}/v1/voice/stt`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ audioBase64, mimeType: blob.type || "audio/webm" }),
    signal: AbortSignal.timeout(70000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as
      | { error?: string; message?: string }
      | null;
    const code = err?.error ?? `STT failed (${res.status})`;
    throw new Error(err?.message || (code === "transcript_empty" ? "No speech detected" : code));
  }
  const data = (await res.json()) as { text?: string };
  if (!data.text) throw new Error("No speech detected");
  return data.text;
}

/** Synthesize speech for `text`; resolves to an MP3 blob ready to play. */
export async function synthesizeSpeech(text: string): Promise<Blob> {
  const res = await authFetch(`${apiBase()}/v1/voice/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, 4000) }),
    signal: AbortSignal.timeout(100000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { message?: string } | null;
    throw new Error(err?.message || `Read-aloud failed (${res.status})`);
  }
  return res.blob();
}

/** Pick the best supported recording MIME type (Opus-in-WebM where possible). */
export function pickRecordingMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/mp4",
  ];
  if (typeof MediaRecorder === "undefined") return "";
  for (const c of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(c)) return c;
    } catch {
      // isTypeSupported can throw on odd implementations
    }
  }
  return "";
}

/** Convert markdown to plain prose so TTS doesn't read symbols. */
export function stripMarkdownForSpeech(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " (code block) ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|.*\|\s*$/gm, "")
    .replace(/^\s*[-=]{3,}\s*$/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1$2")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
