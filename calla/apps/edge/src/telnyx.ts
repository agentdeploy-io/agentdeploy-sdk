/**
 * Telnyx integration helpers for the edge worker (Workstream B1 — telephony).
 *
 * Telnyx (EU/UK/IE coverage; Plivo does not serve these regions).
 *
 *  - /telnyx/inbound  → TeXML answer URL: consent <Say> + <Stream> into the
 *                      CallaVoiceAgent DO (L16 16 kHz bidirectional RTP).
 *  - /telnyx/stream   → media-stream WebSocket Telnyx opens to us; bridged
 *                      here into the VoiceAgent DO (raw 16 kHz PCM).
 *  - /telnyx/status   → call-status callbacks (form-encoded TeXML status
 *                      callback AND/OR v2 JSON event envelope), both
 *                      Ed25519-verified. Also orchestrates the escalation
 *                      alert: on answer of an outbound escalation call it
 *                      plays a dynamic <speak> and hangs up.
 *
 * Ed25519 signing (webhooks + media-stream WS upgrades):
 *   headers: telnyx-signature-ed25519 (base64, 64-byte signature),
 *            telnyx-timestamp (unix seconds)
 *   signed message: `${telnyx-timestamp}|${payload}` where payload is the
 *   EXACT raw body (webhooks) or the exact stream URL incl. query (WS).
 *   Public key: 32-byte base64 from Mission Control (portal → API keys →
 *   public key). Replay window: ±300 s (mirrors the official SDK).
 *
 * Media stream WS protocol (Telnyx → us):
 *   {"event":"connected","version":"1.0.0"}
 *   {"event":"start","start":{call_control_id,from,to,
 *      media_format:{encoding, sample_rate, channels}},"stream_id":"…"}
 *   {"event":"media","media":{track,chunk,timestamp,payload(base64 RTP)}}
 *   {"event":"dtmf","dtmf":{digit}}
 *   {"event":"stop",…}   {"event":"error","payload":{…}}
 * (us → Telnyx, bidirectional rtp mode):
 *   {"event":"media","media":{"payload": base64 L16 16 kHz PCM chunk}}
 *   {"event":"clear"}                      (barge-in: stop + clear queue)
 *   {"event":"mark","mark":{"name":"…"}}   (ack bookkeeping, unused)
 *
 * Chunks 20 ms–30 s; L16 = 16-bit linear PCM (native to the DO pipeline —
 * no transcoding on the outbound leg; inbound is the call codec, PCMU 8 kHz
 * for a regular PSTN call, decoded + resampled 8→16 kHz).
 */

// ── Audio utilities (shared shape with the Plivo bridge) ────────────────────

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const view = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
  return view;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const view = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < view.length; i++) binary += String.fromCharCode(view[i]);
  return btoa(binary);
}

const MULAW_DECODE_TABLE = /* @__PURE__ */ new Int16Array(256);
for (let i = 0; i < 256; i++) {
  const mu = ~i & 255;
  const sign = mu & 128;
  const exponent = (mu >> 4) & 7;
  let sample = (((mu & 15) << 3) + 132) << exponent;
  sample -= 132;
  MULAW_DECODE_TABLE[i] = sign ? -sample : sample;
}

function decodeMulaw(data: Uint8Array): Int16Array {
  const out = new Int16Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = MULAW_DECODE_TABLE[data[i]];
  return out;
}

/** Linear-interpolating resampler between two sample rates. */
function resamplePCM(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outputLength = Math.floor(input.length / ratio);
  const output = new Int16Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const idx = Math.floor(srcIndex);
    const frac = srcIndex - idx;
    const a = input[idx] ?? 0;
    const b = input[Math.min(idx + 1, input.length - 1)] ?? 0;
    output[i] = Math.round(a + frac * (b - a));
  }
  return output;
}

const AGENT_RATE = 16_000;

/**
 * Decode an inbound Telnyx media payload (base64 RTP, no headers) to 16 kHz
 * PCM given the `start` event's media_format. PCMU → mulaw 8 kHz → resample;
 * L16 → linear, resampled when not already 16 kHz.
 */
export function telnyxMediaToPcm16(payload: string, format: TelnyxMediaFormat): Int16Array {
  const raw = base64ToUint8Array(payload);
  const rate = format.sample_rate || 8_000;
  if ((format.encoding ?? "PCMU").toUpperCase() === "L16") {
    const pcm = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 2));
    return resamplePCM(pcm, rate, AGENT_RATE);
  }
  return resamplePCM(decodeMulaw(raw), rate, AGENT_RATE);
}

/** Mean squared amplitude — caller-speech (barge-in) detection. */
function meanSquaredEnergy(pcm: Int16Array): number {
  if (pcm.length === 0) return 0;
  let sumSq = 0;
  for (let i = 0; i < pcm.length; i++) sumSq += pcm[i] * pcm[i];
  return sumSq / pcm.length;
}

const SPEECH_ENERGY_THRESHOLD = 25e4;
const SPEECH_DEBOUNCE_FRAMES = 3;
const PLAYBACK_GRACE_MS = 1_000;
const AGENT_PCM_BYTES_PER_SECOND = 16_000 * 2;

// ── Ed25519 signature verification ──────────────────────────────────────────

export interface TelnyxSignatureHeaders {
  signature: string | null;
  timestamp: string | null;
}

/** Header names as Telnyx sends them. */
export function telnyxSignatureHeaders(request: Request): TelnyxSignatureHeaders {
  const h = new Headers(request.headers);
  return {
    signature: h.get("telnyx-signature-ed25519"),
    timestamp: h.get("telnyx-timestamp"),
  };
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeStrictBase64(value: string): Uint8Array<ArrayBuffer> {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error("invalid base64");
  }
  const padding = value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0;
  const output = new Uint8Array((value.length / 4) * 3 - padding);
  let oi = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = BASE64_ALPHABET.indexOf(value[i]);
    const b = BASE64_ALPHABET.indexOf(value[i + 1]);
    const c = value[i + 2] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 2]);
    const d = value[i + 3] === "=" ? 0 : BASE64_ALPHABET.indexOf(value[i + 3]);
    if (a < 0 || b < 0 || c < 0 || d < 0) throw new Error("invalid base64");
    const chunk = (a << 18) | (b << 12) | (c << 6) | d;
    if (oi < output.length) output[oi++] = (chunk >> 16) & 0xff;
    if (oi < output.length) output[oi++] = (chunk >> 8) & 0xff;
    if (oi < output.length) output[oi++] = chunk & 0xff;
  }
  return output;
}

/**
 * Verify a Telnyx Ed25519 signature.
 * `message` must be the exact signed string: `${timestamp}|${rawBody}` for
 * webhooks, `${timestamp}|${streamUrl}` (the exact URL as set) for WS
 * upgrades. Returns false on any configuration/shape mismatch.
 */
export async function verifyTelnyxSignature(
  headers: TelnyxSignatureHeaders,
  message: string,
  publicKeyB64: string | undefined,
  maxAgeSec = 300,
): Promise<boolean> {
  const { signature, timestamp } = headers;
  if (!signature || !timestamp || !publicKeyB64?.trim()) return false;
  if (!/^\d+$/.test(timestamp)) return false;
  const t = Number(timestamp);
  if (!Number.isSafeInteger(t)) return false;
  if (Math.abs(Math.floor(Date.now() / 1000) - t) > maxAgeSec) return false;
  try {
    const sig = decodeStrictBase64(signature);
    if (sig.length !== 64) return false;
    const keyBytes = decodeStrictBase64(publicKeyB64.trim());
    if (keyBytes.length !== 32) return false;
    const key = await crypto.subtle.importKey(
      "raw",
      keyBytes,
      { name: "Ed25519" },
      false,
      ["verify"],
    );
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      sig,
      new TextEncoder().encode(message),
    );
  } catch {
    return false;
  }
}

// ── Inbound answer TeXML ────────────────────────────────────────────────────

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * TeXML for the inbound answer URL. The consent <Say> plays first, then
 * <Start><Stream> opens the bidirectional media WebSocket into this worker.
 *
 * L16 @ 16 kHz bidirectional = the DO's native format (no outbound
 * transcoding); inbound stays the call codec (PCMU 8 kHz for PSTN).
 */
export function telnyxAnswerTeXml(
  request: Request,
  consentLine: string,
  streamToken?: string,
): string {
  const url = new URL(request.url);
  let wsUrl = `wss://${url.host}/telnyx/stream`;
  if (streamToken?.trim()) {
    wsUrl += `?token=${encodeURIComponent(streamToken.trim())}`;
  }
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Say voice="woman">${xmlEscape(consentLine)}</Say>`,
    "<Start>",
    `<Stream url="${wsUrl}" track="both_tracks" bidirectionalMode="rtp" ` +
      'bidirectionalCodec="L16" bidirectionalSamplingRate="16000">',
    '<Parameter name="calla" value="1" />',
    "</Stream>",
    "</Start>",
    "</Response>",
  ].join("");
}

// ── Media-stream WebSocket bridge ───────────────────────────────────────────

export interface TelnyxMediaFormat {
  encoding?: string;
  sample_rate?: number;
  channels?: number;
}

const TELNYX_RATE_DEFAULT = 8_000;

/**
 * Bridge a Telnyx media-stream WebSocket into the CallaVoiceAgent DO.
 * One DO instance per stream (named by Telnyx `stream_id`, a UUID).
 *
 * Security: verifies the Ed25519 signature over the exact stream URL and
 * (when `streamToken` is configured) the shared `token` query param — a
 * random URL without the token is useless to an attacker even if the
 * signature check is bypassed in a misconfigured environment.
 */
export async function handleTelnyxStream<
  T extends Rpc.DurableObjectBranded | undefined = undefined,
>(
  request: Request,
  env: {
    CallaVoiceAgent?: DurableObjectNamespace<T>;
    TELNYX_PUBLIC_KEY?: string;
    TELNYX_STREAM_TOKEN?: string;
  },
): Promise<Response> {
  const upgrade = request.headers.get("Upgrade");
  if (!upgrade || upgrade.toLowerCase() !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 426 });
  }

  // 1) Ed25519 over the exact stream URL (Telnyx signs the URL as set when
  //    starting the stream — wss:// — even though the Worker sees https://).
  const { signature, timestamp } = telnyxSignatureHeaders(request);
  const publicKey = env.TELNYX_PUBLIC_KEY;
  if (publicKey) {
    const signedUrl = new URL(request.url);
    signedUrl.protocol = "wss:";
    const ok = await verifyTelnyxSignature(
      { signature, timestamp },
      `${timestamp ?? ""}|${signedUrl.toString()}`,
      publicKey,
    );
    if (!ok) {
      return new Response("Invalid Telnyx stream signature", { status: 401 });
    }
  }
  // 2) Shared secret in the query string (defense in depth).
  const token = env.TELNYX_STREAM_TOKEN?.trim();
  if (token) {
    const got = new URL(request.url).searchParams.get("token");
    if (got !== token) {
      return new Response("Invalid stream token", { status: 401 });
    }
  }

  const { 0: clientSocket, 1: serverSocket } = new WebSocketPair();
  serverSocket.accept();

  let streamId: string | null = null;
  let format: TelnyxMediaFormat = { encoding: "PCMU", sample_rate: TELNYX_RATE_DEFAULT };
  let agentSocket: WebSocket | null = null;
  let audioGated = false;
  let estimatedPlaybackEndAt = 0;
  let loudFrames = 0;
  let callControlId: string | null = null;

  const sendClear = () => {
    estimatedPlaybackEndAt = 0;
    if (serverSocket.readyState === WebSocket.OPEN) {
      serverSocket.send(JSON.stringify({ event: "clear" }));
    }
  };

  const connectToAgent = async (instanceId: string) => {
    const namespace = env.CallaVoiceAgent;
    if (!namespace) {
      console.error("[telnyx] CallaVoiceAgent DO namespace not found");
      return;
    }
    try {
      const id = namespace.idFromName(instanceId);
      const stub = namespace.get(id);
      const agentUrl = new URL(request.url);
      agentUrl.pathname = `/agents/${TELNYX_VOICE_AGENT_BINDING.toLowerCase()}/${instanceId}`;
      agentUrl.protocol = "https:";
      const res = await stub.fetch(
        new Request(agentUrl.toString(), { headers: { Upgrade: "websocket" } }),
      );
      const ws = res.webSocket;
      if (!ws) {
        console.error("[telnyx] VoiceAgent did not return a WebSocket");
        return;
      }
      ws.accept();
      agentSocket = ws;

      ws.addEventListener("message", (event: MessageEvent) => {
        if (typeof event.data === "string") {
          try {
            const msg = JSON.parse(event.data) as {
              type?: string;
              status?: string;
            };
            if (msg.type === "playback_interrupt") {
              if (!audioGated) sendClear();
              audioGated = false;
              loudFrames = 0;
              return;
            }
            if (
              msg.type === "status" &&
              (msg.status === "listening" ||
                msg.status === "thinking" ||
                msg.status === "speaking")
            ) {
              audioGated = false;
            }
          } catch {
            /* non-JSON frame — ignore */
          }
          return;
        }
        if (event.data instanceof ArrayBuffer) {
          if (audioGated) return;
          if (serverSocket.readyState !== WebSocket.OPEN) return;
          const durationMs =
            (new Uint8Array(event.data).byteLength / AGENT_PCM_BYTES_PER_SECOND) * 1000;
          estimatedPlaybackEndAt = Math.max(Date.now(), estimatedPlaybackEndAt) + durationMs;
          // L16 16 kHz = the DO's native format (stream bidirectional codec).
          serverSocket.send(
            JSON.stringify({
              event: "media",
              media: { payload: arrayBufferToBase64(event.data) },
            }),
          );
        }
      });

      ws.addEventListener("close", () => {
        if (serverSocket.readyState === WebSocket.OPEN) serverSocket.close();
      });

      ws.send(JSON.stringify({ type: "start_call" }));
    } catch (err) {
      console.error("[telnyx] agent connect failed:", err);
    }
  };

  serverSocket.addEventListener("message", (event: MessageEvent) => {
    if (typeof event.data !== "string") return;
    let msg: {
      event?: string;
      stream_id?: string;
      start?: {
        call_control_id?: string;
        from?: string;
        to?: string;
        media_format?: TelnyxMediaFormat;
      };
      media?: { track?: string; payload?: string };
      dtmf?: { digit?: string };
      error?: { code?: number; title?: string; detail?: string };
    };
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }

    switch (msg.event) {
      case "connected":
        break;
      case "start": {
        streamId = msg.stream_id ?? null;
        callControlId = msg.start?.call_control_id ?? null;
        if (msg.start?.media_format) format = msg.start.media_format;
        // DO instance name: Telnyx stream_id (UUID — safe in a DO name).
        void connectToAgent(msg.stream_id ?? "default");
        break;
      }
      case "media": {
        const media = msg.media;
        if (!media || media.track !== "inbound" || !media.payload) break;
        const pcm16k = telnyxMediaToPcm16(media.payload, format);
        loudFrames =
          meanSquaredEnergy(pcm16k) > SPEECH_ENERGY_THRESHOLD ? loudFrames + 1 : 0;
        const agentSpeaking = Date.now() < estimatedPlaybackEndAt + PLAYBACK_GRACE_MS;
        if (!audioGated && agentSpeaking && loudFrames >= SPEECH_DEBOUNCE_FRAMES) {
          audioGated = true;
          loudFrames = 0;
          sendClear();
        }
        if (agentSocket?.readyState === WebSocket.OPEN) {
          agentSocket.send(pcm16k.buffer);
        }
        break;
      }
      case "dtmf": {
        if (agentSocket?.readyState === WebSocket.OPEN && msg.dtmf?.digit) {
          agentSocket.send(
            JSON.stringify({ type: "dtmf", digit: msg.dtmf.digit, streamId, callId: callControlId }),
          );
        }
        break;
      }
      case "stop": {
        if (agentSocket?.readyState === WebSocket.OPEN) {
          agentSocket.send(JSON.stringify({ type: "end_call" }));
          agentSocket.close();
        }
        break;
      }
      case "error": {
        console.error(
          "[telnyx] stream error:",
          msg.error?.code,
          msg.error?.title,
          msg.error?.detail,
        );
        break;
      }
    }
  });

  serverSocket.addEventListener("close", () => {
    if (agentSocket?.readyState === WebSocket.OPEN) {
      agentSocket.send(JSON.stringify({ type: "end_call" }));
      agentSocket.close();
    }
  });

  return new Response(null, { status: 101, webSocket: clientSocket });
}

export const TELNYX_VOICE_AGENT_BINDING = "CallaVoiceAgent";

// ── Call Control API (outbound escalation + status orchestration) ───────────

export interface TelnyxOutboundInput {
  /** E.164 destination (the on-call number). */
  to: string;
  /** Escalated call's Calla id (the voice DO instance name). */
  callId: string;
  /** Human-readable escalation reason (spoken in the alert). */
  reason: string;
}

export interface TelnyxOutboundResult {
  ok: boolean;
  callId?: string;
  error?: string;
}

const TELNYX_API_BASE = "https://api.telnyx.com/v2";

interface TelnyxApiEnv {
  TELNYX_API_KEY?: string;
  TELNYX_CONNECTION_ID?: string;
  TELNYX_DEFAULT_NUMBER?: string;
}

/**
 * Place an outbound escalation call via the Call Control API
 * (POST /v2/calls). The `client_state` (base64 JSON) tags the call so
 * /telnyx/status can speak the dynamic alert on answer and hang up.
 * Best-effort: config gaps / API errors are returned, never thrown — the
 * escalation event + audit already fired before this dial.
 */
export async function telnyxOutboundCall(
  env: TelnyxApiEnv & { CALLA_EDGE_URL?: string },
  input: TelnyxOutboundInput,
): Promise<TelnyxOutboundResult> {
  const apiKey = env.TELNYX_API_KEY?.trim();
  const connectionId = env.TELNYX_CONNECTION_ID?.trim();
  const from = env.TELNYX_DEFAULT_NUMBER?.trim();
  if (!apiKey || !connectionId || !from) {
    return {
      ok: false,
      error: "telnyx outbound not configured (api key/connection id/number)",
    };
  }
  if (!input.to.trim()) return { ok: false, error: "no escalation destination" };
  try {
    const clientState = btoa(
      JSON.stringify({ source: "calla-escalation", callId: input.callId, reason: input.reason }),
    );
    const edgeUrl = env.CALLA_EDGE_URL?.replace(/\/+$/, "");
    const res = await fetch(`${TELNYX_API_BASE}/calls`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        connection_id: connectionId,
        to: input.to.trim(),
        from,
        client_state: clientState,
        ...(edgeUrl ? { webhook_url: `${edgeUrl}/telnyx/status` } : {}),
      }),
    });
    const body = (await res.json().catch(() => ({}))) as {
      data?: { call_control_id?: string };
      errors?: Array<{ title?: string; detail?: string }>;
    };
    if (!res.ok) {
      const detail = body.errors?.[0]
        ? `${body.errors[0].title ?? ""} ${body.errors[0].detail ?? ""}`.trim()
        : `http ${res.status}`;
      return { ok: false, error: `telnyx dial failed: ${detail}` };
    }
    return { ok: true, callId: body.data?.call_control_id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Speak a message on an active call (Call Control `speak` action). Used by
 * the escalation flow to alert the on-call person with the escalated call's
 * id + reason. `voice` defaults to a Telnyx Natural voice.
 */
export async function telnyxSpeak(
  env: { TELNYX_API_KEY?: string; TELNYX_TTS_VOICE?: string },
  callControlId: string,
  text: string,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = env.TELNYX_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "telnyx api key not configured" };
  try {
    const res = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/speak`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        payload: text.slice(0, 3000),
        payload_type: "text",
        voice: env.TELNYX_TTS_VOICE?.trim() || "Telnyx.Natural.abbie",
        stop: "current",
      }),
    });
    if (!res.ok) return { ok: false, error: `telnyx speak ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Hang up a call (Call Control `hangup` action). */
export async function telnyxHangup(
  env: { TELNYX_API_KEY?: string },
  callControlId: string,
): Promise<{ ok: boolean; error?: string }> {
  const apiKey = env.TELNYX_API_KEY?.trim();
  if (!apiKey) return { ok: false, error: "telnyx api key not configured" };
  try {
    const res = await fetch(`${TELNYX_API_BASE}/calls/${encodeURIComponent(callControlId)}/actions/hangup`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({}),
    });
    if (!res.ok) return { ok: false, error: `telnyx hangup ${res.status}` };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Decode a base64 `client_state` into an object (or null). */
export function decodeClientState(clientState: string | null | undefined): Record<string, unknown> | null {
  if (!clientState) return null;
  try {
    const obj = JSON.parse(atob(clientState.trim()));
    return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// ── Status callback parsing ─────────────────────────────────────────────────

export interface TelnyxStatusEvent {
  /** Calla call id — the DO instance name when known (Telnyx stream_id). */
  callId?: string;
  /** Telnyx call_control_id (for speaking/hanging up). */
  callControlId?: string;
  status: string;
  from?: string;
  to?: string;
  durationSec?: number;
  clientState?: Record<string, unknown> | null;
}

/**
 * Parse a /telnyx/status callback body — either form-encoded (TeXML
 * status_callback: CallSid/CallStatus/From/To/Duration) or the v2 JSON
 * event envelope ({data:{event_type,payload:{call_control_id,state,…}}}).
 */
export function parseTelnyxStatusEvent(rawBody: string): TelnyxStatusEvent | null {
  const trimmed = rawBody.trim();
  if (!trimmed) return null;

  // v2 JSON envelope
  if (trimmed.startsWith("{")) {
    try {
      const env2 = JSON.parse(trimmed) as {
        data?: {
          event_type?: string;
          id?: string;
          payload?: Record<string, unknown>;
        };
      };
      const data = env2.data;
      if (!data?.event_type) return null;
      const p = (data.payload ?? {}) as Record<string, unknown>;
      const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
      return {
        callControlId:
          str(p.call_control_id) ?? str(p.call_id) ?? str(p.id) ?? (str(data.id) ?? undefined),
        callId: str(p.call_id),
        status: normalizeTelnyxStatus(str(data.event_type) ?? data.event_type),
        from: str(p.from),
        to: str(p.to),
        durationSec: typeof p.duration === "number" ? p.duration : undefined,
        clientState: decodeClientState(str(p.client_state) ?? undefined),
      };
    } catch {
      return null;
    }
  }

  // Form-encoded (TeXML status callback)
  const form = new URLSearchParams(trimmed);
  const status = form.get("CallStatus");
  if (!status) return null;
  return {
    callId: form.get("CallSid") ?? form.get("CallSidLegacy") ?? undefined,
    callControlId: form.get("CallControlId") ?? form.get("CallSid") ?? undefined,
    status,
    from: form.get("From") ?? undefined,
    to: form.get("To") ?? undefined,
    durationSec: form.get("Duration") ? Number(form.get("Duration")) : undefined,
    clientState: decodeClientState(form.get("ClientState") ?? undefined),
  };
}

/** v2 event_type → Calla-style status word. */
function normalizeTelnyxStatus(eventType: string): string {
  switch (eventType) {
    case "call.initiated":
    case "call.ringing":
      return "in-progress";
    case "call.answered":
      return "answered";
    case "call.completed":
      return "completed";
    case "call.canceled":
      return "canceled";
    case "call.failed":
      return "failed";
    case "streaming.started":
      return "streaming.started";
    case "streaming.stopped":
      return "streaming.stopped";
    default:
      return eventType;
  }
}
