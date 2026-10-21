/**
 * CallsSection — /calls (gated by the "voice" module; Workstream B)
 * ─────────────────────────────────────────────────────────────────
 * The dental voice module's operator console:
 *
 *   Active call   — live `calla:voice:*` frames from the edge event bus
 *                   (call_start/call_end/escalation/booking/transcript).
 *                   "Join call" connects the operator's browser to the DO
 *                   (live audio + transcript + text participation via the
 *                   SDK's useVoiceAgent — a first-class voice participant);
 *                   "Transfer to human" fires the deterministic escalation
 *                   (audit + event + Plivo outbound Dial to on-call).
 *   Monitor       — start/end a browser call, status, live + interim
 *                   transcript, turn metrics, text fallback (B0 surface).
 *   History       — call threads from the brain's `voice:` conversation
 *                   channel (one thread per Plivo call id), with derived
 *                   outcome (booked / escalated / booking failed / …) and
 *                   the full transcript incl. system notices.
 *
 * Notes:
 *   - Join on a Plivo-originated call is monitor + text participation:
 *     the PSTN audio path stays with Plivo; a true three-way bridge is a
 *     post-B3 extension (Plivo Conference).
 *   - Active-call state comes from the shared /events socket (ref-counted
 *     ws-registry — the same socket the console shell and approvals use),
 *     so there is no extra connection.
 */

import * as React from "react";
import {
  History,
  Loader2,
  Mic,
  MicOff,
  Phone,
  PhoneCall,
  PhoneOff,
  RefreshCw,
  TextCursorInput,
  Timer,
  UserRound,
  Volume2,
  Zap,
} from "lucide-react";
import { useVoiceAgent, type VoiceStatus } from "agents/voice/react";
import { CALLA_PING_TEXT, CALLA_PONG_TEXT, type CallaWsFrame } from "@calla/shared";
import { Badge, Button } from "@/components/ui";
import { cn } from "@/lib/utils";
import { useVoiceEventsManager } from "@/lib/voice-events";
import { conversationsClient, type ConversationDetail, type ConversationSummary } from "@/lib/conversations-client";
import { edgeClient } from "@/lib/edge-client";

/** Agents-SDK DO routing: kebab-case of the `CallaVoiceAgent` binding. */
const VOICE_AGENT = "calla-voice-agent";

const STATUS_META: Record<VoiceStatus, { label: string; className: string }> = {
  idle: { label: "Idle", className: "text-muted-foreground" },
  listening: { label: "Listening", className: "text-info" },
  thinking: { label: "Thinking", className: "text-warning" },
  speaking: { label: "Speaking", className: "text-success" },
};

// ─── Active-call state from the edge event bus ───────────────────────

interface LiveTranscriptLine {
  dir: "in" | "out";
  text: string;
  ts: number;
}

export interface VoiceCallInfo {
  callId: string;
  active: boolean;
  startedAt: number | null;
  /** "do" (voice DO onCallStart) | "plivo" (status callback). */
  source?: string;
  from?: string;
  to?: string;
  durationSec?: number;
  escalated?: { reason: string; source: string } | null;
  booking?: { status: string; detail?: string } | null;
  transcript: LiveTranscriptLine[];
}

const TRANSCRIPT_CAP = 200;

function applyVoiceFrame(
  prev: Record<string, VoiceCallInfo>,
  type: string,
  payload: Record<string, unknown>,
  callId: string,
  ts: number,
): Record<string, VoiceCallInfo> {
  const cur = prev[callId] ?? {
    callId,
    active: false,
    startedAt: null,
    transcript: [],
    escalated: null,
    booking: null,
  };
  const next: VoiceCallInfo = { ...cur };

  switch (type) {
    case "calla:voice:call_start":
      next.active = true;
      next.startedAt = cur.startedAt ?? ts;
      if (typeof payload.source === "string") next.source = payload.source;
      else if (payload.status === "started") next.source = "plivo";
      if (typeof payload.from === "string") next.from = payload.from;
      if (typeof payload.to === "string") next.to = payload.to;
      break;
    case "calla:voice:call_end":
      next.active = false;
      if (typeof payload.durationSec === "number") next.durationSec = payload.durationSec;
      break;
    case "calla:voice:call_active":
      next.active = true;
      next.startedAt = cur.startedAt ?? ts;
      next.source = next.source ?? "plivo";
      if (typeof payload.from === "string") next.from = payload.from;
      if (typeof payload.to === "string") next.to = payload.to;
      break;
    case "calla:voice:escalation":
      next.escalated = {
        reason: typeof payload.reason === "string" ? payload.reason : "escalated",
        source: typeof payload.source === "string" ? payload.source : "unknown",
      };
      break;
    case "calla:voice:booking":
      next.booking = {
        status: typeof payload.status === "string" ? payload.status : "unknown",
        ...(typeof payload.detail === "string" ? { detail: payload.detail } : {}),
      };
      break;
    case "calla:voice:transcript": {
      const text = typeof payload.text === "string" ? payload.text : "";
      if (text) {
        next.transcript = [
          ...cur.transcript,
          { dir: payload.dir === "outbound" ? ("out" as const) : ("in" as const), text, ts },
        ].slice(-TRANSCRIPT_CAP);
      }
      break;
    }
    default:
      return prev;
  }
  return { ...prev, [callId]: next };
}

/**
 * Tracks `calla:voice:*` frames on the shared /events socket (the same
 * ref-counted manager the console shell uses — no extra connection).
 */
function useVoiceCallFrames(): Record<string, VoiceCallInfo> {
  const [calls, setCalls] = React.useState<Record<string, VoiceCallInfo>>({});

  const { manager, release } = useVoiceEventsManager();
  React.useEffect(() => {
    const remove = manager.addListener({
      onMessage: (raw: string) => {
        let frame: CallaWsFrame;
        try {
          frame = JSON.parse(raw) as CallaWsFrame;
        } catch {
          return; // raw-text ping/pong
        }
        if (typeof frame.type !== "string" || !frame.type.startsWith("calla:voice:")) return;
        const payload =
          frame.payload && typeof frame.payload === "object"
            ? (frame.payload as Record<string, unknown>)
            : {};
        const callId =
          typeof payload.callId === "string"
            ? payload.callId
            : typeof frame.agentId === "string" && frame.agentId.startsWith("voice:")
              ? frame.agentId.slice("voice:".length)
              : undefined;
        if (!callId) return;
        setCalls((prev) => applyVoiceFrame(prev, frame.type, payload, callId, frame.ts ?? Date.now()));
      },
      onStateChange: () => {},
    });
    return () => {
      remove();
      release();
    };
  }, [manager, release]);

  return calls;
}

// ─── History: outcome derivation + list/detail ─────────────────────────

type CallOutcome = "booked" | "escalated" | "booking_failed" | "awaiting_approval" | "completed";

const OUTCOME_META: Record<CallOutcome, { label: string; className: string }> = {
  booked: { label: "Booked", className: "bg-success/15 text-success" },
  escalated: { label: "Escalated", className: "bg-destructive/15 text-destructive" },
  booking_failed: { label: "Booking failed", className: "bg-warning/15 text-warning" },
  awaiting_approval: { label: "Approval pending", className: "bg-info/15 text-info" },
  completed: { label: "Completed", className: "bg-surface-tag text-muted-foreground" },
};

/** Derive the call outcome from its transcript (system notices are the record). */
export function deriveCallOutcome(detail: ConversationDetail): CallOutcome {
  const sys = detail.messages.filter((m) => m.kind === "system").map((m) => m.text.toLowerCase());
  const all = detail.messages.map((m) => m.text.toLowerCase()).join("\n");
  if (sys.some((t) => /appointment booked|appointment confirmed/.test(t))) return "booked";
  if (all.includes("escalated") || detail.messages.some((m) => /escalat/i.test(m.text) && m.kind === "system"))
    return "escalated";
  if (sys.some((t) => /booking attempt after approval failed|booking failed/.test(t))) return "booking_failed";
  if (sys.some((t) => /sent for approval/.test(t))) return "awaiting_approval";
  return "completed";
}

function formatWhen(iso: string): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// ─── The section ──────────────────────────────────────────────────────

export const CallsSection: React.FC = () => {
  const [instance, setInstance] = React.useState("default");
  const [running, setRunning] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const [transferReason, setTransferReason] = React.useState("");
  const [transferring, setTransferring] = React.useState<string | null>(null);
  const [transferError, setTransferError] = React.useState<string | null>(null);

  // History
  const [history, setHistory] = React.useState<ConversationSummary[] | null>(null);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [selectedId, setSelectedId] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<ConversationDetail | null>(null);
  const [detailLoading, setDetailLoading] = React.useState(false);

  const voice = useVoiceAgent({
    agent: VOICE_AGENT,
    name: instance.trim() || "default",
    enabled: running,
  });

  const frames = useVoiceCallFrames();
  const activeCalls = Object.values(frames).filter((c) => c.active);
  const recentEnded = Object.values(frames)
    .filter((c) => !c.active && c.startedAt !== null)
    .sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0))
    .slice(0, 3);

  // The operator's own browser call counts as an active call too.
  const joinedCallId = running && instance.trim() && instance.trim() !== "default" ? instance.trim() : null;

  const loadHistory = React.useCallback(async () => {
    setHistoryLoading(true);
    setHistoryError(null);
    const res = await conversationsClient.list("voice", 50);
    setHistoryLoading(false);
    if (res.data) {
      setHistory(res.data.conversations);
    } else {
      setHistoryError(res.error ?? "The brain didn't answer.");
    }
  }, []);

  React.useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  // Refresh history when a call on the bus ends (transcripts are final then).
  React.useEffect(() => {
    if (activeCalls.length === 0) void loadHistory();
  }, [activeCalls.length, loadHistory]);

  const openThread = React.useCallback(
    async (id: string) => {
      setSelectedId(id);
      setSelected(null);
      setDetailLoading(true);
      const res = await conversationsClient.get(id);
      setDetailLoading(false);
      if (res.data) setSelected(res.data);
      else setSelectedId(null);
    },
    [],
  );

  // ── Actions ────────────────────────────────────────────────────

  const startOwn = React.useCallback(() => {
    setRunning(true);
    void voice.startCall().catch((err: unknown) => {
      setRunning(false);
      console.error("[calls] startCall failed:", err);
    });
  }, [voice]);

  const stop = React.useCallback(() => {
    voice.endCall();
    setRunning(false);
  }, [voice]);

  const joinCall = React.useCallback(
    (callId: string) => {
      setInstance(callId);
      setRunning(true);
      // For a Plivo-originated call the DO is already in a call — the mixin
      // ignores start_call ("already_active") and we stay a monitor + text
      // participant. For a browser call this starts the full mic loop.
      void voice.startCall().catch(() => {
        /* monitor-only join — expected for active Plivo calls */
      });
    },
    [voice],
  );

  const leaveCall = React.useCallback(() => {
    voice.endCall();
    setRunning(false);
    setInstance("default");
  }, [voice]);

  const transfer = React.useCallback(
    async (callId: string) => {
      setTransferring(callId);
      setTransferError(null);
      try {
        const reason = transferReason.trim();
        await edgeClient.transferVoiceCall(callId, reason || undefined);
        setTransferReason("");
      } catch (err) {
        setTransferError(err instanceof Error ? err.message : "Transfer failed");
      } finally {
        setTransferring(null);
      }
    },
    [transferReason],
  );

  const sendText = React.useCallback(() => {
    const text = draft.trim();
    if (!text || !voice.connected) return;
    voice.sendText(text);
    setDraft("");
  }, [draft, voice]);

  const status = STATUS_META[voice.status] ?? STATUS_META.idle;
  const m = voice.metrics;
  const selectedOutcome = selected ? deriveCallOutcome(selected) : null;

  return (
    <div className="mx-auto w-full max-w-5xl space-y-4 pb-8">
      {/* ─── Header ─────────────────────────────────────────── */}
      <header className="space-y-1">
        <h1 className="text-xl font-bold tracking-tight text-foreground">Calls</h1>
        <p className="text-[0.8125rem] text-muted-foreground">
          AI dental receptionist — Flux STT, Mistral Nemo (Chutes), Aura-2 TTS over the
          calla-voice-agent Durable Object.
        </p>
      </header>

      {/* ─── Active calls ───────────────────────────────────── */}
      {activeCalls.length > 0 && (
        <div className="space-y-2">
          {activeCalls.map((call) => (
            <div
              key={call.callId}
              className="rounded-xl border border-info/40 bg-info/5 p-4"
            >
              <div className="flex flex-wrap items-center gap-3">
                <PhoneCall className="size-4 animate-pulse-dot text-info" aria-hidden />
                <span className="text-sm font-semibold text-foreground">
                  Live call · <span className="font-mono text-[0.8125rem]">{call.callId}</span>
                </span>
                {call.source && (
                  <Badge variant="outline" className="text-[0.625rem]">
                    {call.source === "plivo" ? "Plivo / PSTN" : "browser"}
                  </Badge>
                )}
                {(call.from || call.to) && (
                  <span className="text-[0.6875rem] tabular-nums text-muted-foreground">
                    {call.from ? `from ${call.from}` : ""}
                    {call.to ? ` → ${call.to}` : ""}
                  </span>
                )}
                {call.escalated && (
                  <Badge className="bg-destructive/15 px-1.5 py-0 text-[0.625rem] text-destructive">
                    escalated
                  </Badge>
                )}
                {call.booking && (
                  <Badge
                    className={cn(
                      "px-1.5 py-0 text-[0.625rem]",
                      call.booking.status === "booked"
                        ? "bg-success/15 text-success"
                        : "bg-warning/15 text-warning",
                    )}
                  >
                    booking: {call.booking.status}
                  </Badge>
                )}
                <span className="ml-auto text-[0.6875rem] tabular-nums text-faint">
                  {call.startedAt ? `started ${formatWhen(new Date(call.startedAt).toISOString())}` : ""}
                </span>
              </div>

              {/* Live transcript from the event bus (when not joined — the
                  monitor panel shows the WS transcript when joined). */}
              {call.transcript.length > 0 && !joinedCallId && (
                <div className="scrollbar-thin mt-3 max-h-40 space-y-1 overflow-y-auto rounded-lg border border-border bg-surface-canvas p-2">
                  {call.transcript.slice(-30).map((line, i) => (
                    <div
                      key={i}
                      className={cn("flex text-[0.8125rem]", line.dir === "out" ? "justify-start" : "justify-end")}
                    >
                      <span
                        className={cn(
                          "max-w-[85%] rounded-lg px-2.5 py-1",
                          line.dir === "out"
                            ? "bg-surface-tag text-body"
                            : "bg-primary/10 text-foreground",
                        )}
                      >
                        <span className="mr-1.5 text-[0.625rem] font-semibold uppercase text-faint">
                          {line.dir === "out" ? "Agent" : "Caller"}
                        </span>
                        {line.text}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button size="sm" onClick={() => joinCall(call.callId)}>
                  <UserRound className="size-3.5" />
                  Join call
                </Button>
                <input
                  value={transferReason}
                  onChange={(e) => setTransferReason(e.target.value)}
                  placeholder="Transfer reason (optional)"
                  aria-label="Transfer reason"
                  className="h-8 w-44 rounded-md border border-border bg-surface-tag px-2 text-xs text-foreground placeholder:text-faint focus:outline-none"
                />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => transfer(call.callId)}
                  disabled={transferring === call.callId}
                >
                  {transferring === call.callId ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Zap className="size-3.5" />
                  )}
                  Transfer to human
                </Button>
                {transferError && (
                  <span className="text-xs text-destructive">{transferError}</span>
                )}
                <span className="ml-auto text-[0.625rem] text-faint">
                  Transfer = audit + event + Plivo Dial to on-call
                </span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── Monitor (join / own browser call) ───────────────── */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border bg-surface-canvas p-4">
        <label className="flex items-center gap-2 text-sm text-muted-foreground">
          Instance
          <input
            value={instance}
            onChange={(e) => setInstance(e.target.value)}
            disabled={running}
            aria-label="Voice agent instance name"
            className="h-8 w-32 rounded-md border border-border bg-surface-tag px-2 text-sm text-foreground focus:outline-none"
          />
        </label>

        {!running ? (
          <Button size="sm" onClick={startOwn} disabled={voice.connected && voice.status === "speaking"}>
            <Phone className="size-3.5" />
            Start call
          </Button>
        ) : (
          <Button size="sm" variant="destructive" onClick={stop}>
            <PhoneOff className="size-3.5" />
            End call
          </Button>
        )}

        {joinedCallId && (
          <Button size="sm" variant="ghost" onClick={leaveCall}>
            Leave {joinedCallId}
          </Button>
        )}

        <Badge variant="outline" className="tabular-nums">
          {voice.connected ? "connected" : "disconnected"}
        </Badge>
        <span className={cn("flex items-center gap-1.5 text-xs font-semibold", status.className)}>
          <span
            className={cn(
              "inline-block size-2 rounded-full bg-current",
              (voice.status === "listening" || voice.status === "speaking") && "animate-pulse-dot",
            )}
          />
          {status.label}
        </span>

        {running && (
          <div className="ml-auto flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={voice.toggleMute}
              aria-label={voice.isMuted ? "Unmute microphone" : "Mute microphone"}
              title={voice.isMuted ? "Unmute (M)" : "Mute"}
            >
              {voice.isMuted ? <MicOff className="size-3.5" /> : <Mic className="size-3.5" />}
            </Button>
            <span
              className="text-[0.6875rem] tabular-nums text-faint"
              title="Microphone level (0–1)"
            >
              mic {voice.audioLevel.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* ─── Errors ─────────────────────────────────────────── */}
      {(voice.error || voice.outputDeviceError) && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {voice.outputDeviceError ?? voice.error}
        </div>
      )}

      {/* ─── Transcript ─────────────────────────────────────── */}
      <div className="flex min-h-60 flex-col rounded-xl border border-border bg-surface-canvas">
        <div className="flex items-center justify-between border-b border-border px-4 py-2">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
            {joinedCallId ? `Live transcript — ${joinedCallId}` : "Live transcript"}
          </span>
          <span className="text-[0.6875rem] tabular-nums text-faint">
            {voice.transcript.length} message{voice.transcript.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="scrollbar-thin flex-1 space-y-2 overflow-y-auto p-4" style={{ maxHeight: "36vh" }}>
          {voice.transcript.length === 0 && !voice.interimTranscript && (
            <div className="py-8 text-center text-sm text-muted-foreground">
              {running ? "Waiting for speech…" : "Start or join a call to begin."}
            </div>
          )}
          {voice.transcript.map((msg, i) => (
            <div
              key={i}
              className={cn(
                "flex",
                msg.role === "user" ? "justify-end" : "justify-start",
              )}
            >
              <div
                className={cn(
                  "max-w-[85%] rounded-lg px-3 py-1.5 text-sm",
                  msg.role === "user"
                    ? "bg-primary/10 text-foreground"
                    : "bg-surface-tag text-body",
                )}
              >
                <span className="mr-1.5 text-[0.625rem] font-semibold uppercase text-faint">
                  {msg.role === "user" ? "You" : "Agent"}
                </span>
                {msg.text}
              </div>
            </div>
          ))}
          {voice.interimTranscript && (
            <div className="flex justify-end">
              <div className="max-w-[85%] rounded-lg bg-primary/5 px-3 py-1.5 text-sm text-muted-foreground italic">
                {voice.interimTranscript}
              </div>
            </div>
          )}
        </div>
        {/* Text fallback — the voice pipeline also accepts typed turns. */}
        <div className="flex items-center gap-2 border-t border-border p-3">
          <TextCursorInput className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") sendText();
            }}
            placeholder={voice.connected ? "Type a message (Enter to send)…" : "Connect a call first…"}
            disabled={!voice.connected}
            aria-label="Send a text message to the voice agent"
            className="h-8 flex-1 rounded-md border border-border bg-surface-tag px-3 text-sm text-foreground placeholder:text-faint focus:outline-none disabled:opacity-50"
          />
          <Button size="sm" variant="outline" onClick={sendText} disabled={!voice.connected || !draft.trim()}>
            Send
          </Button>
        </div>
      </div>

      {/* ─── Turn metrics ───────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border bg-surface-canvas p-4">
        <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
          <Timer className="size-3.5" />
          Last turn
        </span>
        {m ? (
          <>
            <Metric label="LLM" value={m.llm_ms} />
            <Metric label="TTS" value={m.tts_ms} />
            <Metric label="First audio" value={m.first_audio_ms} />
            <Metric label="Total" value={m.total_ms} />
          </>
        ) : (
          <span className="text-sm text-muted-foreground">No turns yet.</span>
        )}
        <span className="ml-auto flex items-center gap-1.5 text-[0.6875rem] text-faint">
          <Volume2 className="size-3.5" aria-hidden />
          Aura-2 via Workers AI
        </span>
      </div>

      {/* ─── Recently ended (bus) ───────────────────────────── */}
      {recentEnded.length > 0 && activeCalls.length === 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-border bg-surface-canvas p-3">
          <span className="text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
            Recently ended
          </span>
          {recentEnded.map((c) => (
            <button
              key={c.callId}
              onClick={() => openThread(`voice:${c.callId}`)}
              className="flex items-center gap-1.5 rounded-md border border-border bg-surface-tag px-2 py-1 text-[0.75rem] text-body hover:border-info/50"
            >
              <span className="font-mono text-[0.6875rem]">{c.callId}</span>
              {c.durationSec !== undefined && (
                <span className="tabular-nums text-faint">{c.durationSec}s</span>
              )}
              {c.escalated && <span className="text-destructive">escalated</span>}
            </button>
          ))}
        </div>
      )}

      {/* ─── History (brain voice threads) ──────────────────── */}
      <div className="grid gap-4 lg:grid-cols-2">
        {/* List */}
        <div className="rounded-xl border border-border bg-surface-canvas">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="flex items-center gap-1.5 text-[0.6875rem] font-semibold uppercase tracking-[0.06em] text-faint">
              <History className="size-3.5" />
              Call history
            </span>
            <button
              onClick={() => void loadHistory()}
              disabled={historyLoading}
              className="flex items-center gap-1 text-[0.6875rem] text-muted-foreground hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className={cn("size-3", historyLoading && "animate-spin")} />
              Refresh
            </button>
          </div>
          <div className="scrollbar-thin max-h-96 overflow-y-auto">
            {history === null && !historyError && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            )}
            {historyError && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                {historyError}
              </div>
            )}
            {history !== null && history.length === 0 && (
              <div className="px-4 py-8 text-center text-sm text-muted-foreground">
                No voice calls recorded yet.
              </div>
            )}
            {history?.map((c) => {
              const callId = c.id.split(":")[1] ?? c.id;
              return (
                <button
                  key={c.id}
                  onClick={() => void openThread(c.id)}
                  className={cn(
                    "flex w-full items-center gap-3 border-b border-border/50 px-4 py-2.5 text-left last:border-b-0 hover:bg-surface-tag/50",
                    selectedId === c.id && "bg-surface-tag",
                  )}
                >
                  <Phone className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[0.75rem] text-foreground">{callId}</div>
                    <div className="truncate text-[0.75rem] text-muted-foreground">
                      {c.phone ? `${c.phone} · ` : ""}
                      {c.lastMessage}
                    </div>
                  </div>
                  <span className="shrink-0 text-[0.625rem] tabular-nums text-faint">
                    {formatWhen(c.lastAt)}
                  </span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Detail */}
        <div className="rounded-xl border border-border bg-surface-canvas">
          <div className="flex items-center justify-between border-b border-border px-4 py-2">
            <span className="font-mono text-[0.75rem] text-foreground">
              {selectedId ? selectedId.replace(/^voice:/, "") : "Transcript"}
            </span>
            {selectedOutcome && (
              <Badge className={cn("px-1.5 py-0 text-[0.625rem]", OUTCOME_META[selectedOutcome].className)}>
                {OUTCOME_META[selectedOutcome].label}
              </Badge>
            )}
          </div>
          <div className="scrollbar-thin max-h-96 overflow-y-auto p-4">
            {detailLoading && (
              <div className="flex items-center justify-center gap-2 py-10 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" /> Loading…
              </div>
            )}
            {!selected && !detailLoading && (
              <div className="py-10 text-center text-sm text-muted-foreground">
                Select a call to read its transcript.
              </div>
            )}
            {selected && (
              <div className="space-y-2">
                {selected.contact.phone && (
                  <div className="text-[0.6875rem] text-faint">
                    caller {selected.contact.phone}
                    {selected.takeover ? " · takeover ON" : ""}
                  </div>
                )}
                {selected.messages.map((msg, i) => {
                  const out = msg.dir === "out";
                  const system = msg.kind === "system";
                  if (system) {
                    return (
                      <div
                        key={`${msg.ts}-${i}`}
                        className="rounded-md border border-border bg-surface-tag/60 px-3 py-1.5 text-[0.6875rem] text-muted-foreground"
                      >
                        {msg.text}
                      </div>
                    );
                  }
                  return (
                    <div
                      key={`${msg.ts}-${i}`}
                      className={cn("flex", out ? "justify-start" : "justify-end")}
                    >
                      <div
                        className={cn(
                          "max-w-[85%] rounded-lg px-3 py-1.5 text-[0.8125rem]",
                          out ? "bg-surface-tag text-body" : "bg-primary/10 text-foreground",
                        )}
                      >
                        <span className="mr-1.5 text-[0.625rem] font-semibold uppercase text-faint">
                          {out ? "Agent" : "Caller"}
                        </span>
                        {msg.text}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

const Metric: React.FC<{ label: string; value: number }> = ({ label, value }) => (
  <span className="flex items-baseline gap-1 text-sm">
    <span className="text-faint">{label}</span>
    <span className="font-semibold tabular-nums text-foreground">{Math.round(value)}ms</span>
  </span>
);

CallsSection.displayName = "CallsSection";
