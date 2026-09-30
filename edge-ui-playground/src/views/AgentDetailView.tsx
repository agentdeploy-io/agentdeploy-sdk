/**
 * AgentDetailView Component
 * ─────────────────────────
 * Detail view for a single agent with tabbed sub-navigation.
 *
 * Layout (from edge.pen mockups L7Qz4 / oChJg):
 *   ┌─────────────────────────────────────────────┐
 *   │ ← Back  Agent Name  Status Badge            │
 *   │ Icon + description + capabilities           │
 *   ├──────────────────────────────────────────────┤
 *   │ Chat | Monitor | Config | Schedules | ...   │
 *   ├──────────────────────────────────────────────┤
 *   │                                              │
 *   │ Tab Content                                  │
 *   │                                              │
 *   └──────────────────────────────────────────────┘
 *
 * Tabs: Chat, Monitor, Configuration, Schedules, Storage, Logs, Traces, Versions
 */

import React from "react";
import { Card, Badge, Button, Tabs, StatusDot, MetricCard, CodeBlock } from "../components/ui";
import { LoadingState, EmptyState, ErrorBoundary } from "../components/shared";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import {
  AGENT_STATUS_LABELS,
  AGENT_STATUS_BADGE_VARIANT,
  type AgentRegistryEntry,
} from "../constants/agents";
import { AGENT_TABS } from "../constants/navigation";
import { useAgentConnection } from "../hooks/useAgentConnection";
import { useAgentHealth } from "../hooks/useAgentHealth";
import { useAgentInfo } from "../hooks/useAgentInfo";
import { useAgentRegistry } from "../hooks/useAgentRegistry";
import { renderMarkdown } from "../lib/markdown";
import {
  getVoiceStatus,
  transcribeAudio,
  synthesizeSpeech,
  stripMarkdownForSpeech,
  pickRecordingMimeType,
} from "../lib/voice";
import { toast } from "../hooks/useToast";
import { DEPLOYMENT_API_URL } from "../constants/auth";
import { authFetch } from "../hooks/useAuthFetch";
import { AppErrors } from "../errors/AppError";
import {
  TOAST_RECONNECT_EVENT,
  TOAST_RETRY_EVENT,
} from "../components/layout/ToastContainer";
import type { ChatMessage } from "../types/agent";

// ─── Props ───────────────────────────────────────────────────────

export interface AgentDetailViewProps {
  agentId: string;
  tab: string;
  onNavigateTab: (tabId: string) => void;
  onNavigateBack: () => void;
}

// ─── Main Component ──────────────────────────────────────────────

export const AgentDetailView: React.FC<AgentDetailViewProps> = ({
  agentId,
  tab,
  onNavigateTab,
  onNavigateBack,
}) => {
  const { getAgentById, loading, error, refetch } = useAgentRegistry();
  const agent = getAgentById(agentId);

  // ─── Loading / Error (registry not ready) ─────────────────────
  // The registry is fetched from /v1/deployments on load; showing
  // "Agent Not Found" while it is still in flight (or after a JWT
  // expiry 401) is indistinguishable from a real removal.

  if (!agent && loading) {
    return <LoadingState message="Loading agent…" />;
  }

  if (!agent && error) {
    return (
      <EmptyState
        icon="⚠️"
        title="Couldn't Load Agents"
        message={`${error} Your session may have expired — refresh to sign in again.`}
        action={{ label: "Retry", onClick: refetch }}
      />
    );
  }

  // ─── Agent Not Found ──────────────────────────────────────────

  if (!agent) {
    return (
      <EmptyState
        icon="🔍"
        title="Agent Not Found"
        message={`The agent "${agentId}" does not exist or has been removed.`}
        action={{ label: "Back to Agents", onClick: onNavigateBack }}
      />
    );
  }

  // ─── Tab Config ───────────────────────────────────────────────

  const availableTabs = AGENT_TABS.filter((t) => {
    // Hide schedules tab for non-cron agents
    if (t.id === "schedules" && !agent.hasCron) return false;
    return true;
  }).map((t) => ({
    id: t.id,
    label: t.label,
  }));

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "0" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <AgentDetailHeader agent={agent} onBack={onNavigateBack} />

      {/* ─── Tabs ─────────────────────────────────────────────── */}
      <div style={{ marginTop: "16px" }}>
        <Tabs tabs={availableTabs} activeTab={tab} onChange={onNavigateTab} />
      </div>

      {/* ─── Tab Content ──────────────────────────────────────── */}
      <div style={{ marginTop: "24px" }}>
        <ErrorBoundary key={`${agentId}-${tab}`}>
          {tab === "chat" && <AgentChatTab agent={agent} />}
          {tab === "monitor" && <AgentMonitorTab agent={agent} />}
          {tab === "config" && <AgentConfigTab agent={agent} />}
          {tab === "schedules" && <AgentSchedulesTab agent={agent} />}
          {tab === "storage" && <AgentStorageTab agent={agent} />}
          {tab === "logs" && <AgentLogsTab agent={agent} />}
          {tab === "traces" && <AgentTracesTab agent={agent} />}
          {tab === "versions" && <AgentVersionsTab agent={agent} />}
        </ErrorBoundary>
      </div>
    </div>
  );
};

// ─── Header Sub-Component ────────────────────────────────────────

const AgentDetailHeader: React.FC<{
  agent: AgentRegistryEntry;
  onBack: () => void;
}> = ({ agent, onBack }) => {
  const { status } = useAgentHealth(agent);
  const { info } = useAgentInfo(agent);

  return (
    <div>
      {/* Back button */}
      <Button variant="ghost" size="sm" onClick={onBack} leftIcon={<span>←</span>}>
        Back to Agents
      </Button>

      {/* Agent info */}
      <div
        style={{
          display: "flex",
          alignItems: "flex-start",
          gap: "16px",
          marginTop: "12px",
        }}
      >
        <div
          style={{
            width: "56px",
            height: "56px",
            borderRadius: RADIUS.lg,
            backgroundColor: COLORS.secondary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.75rem",
            flexShrink: 0,
          }}
        >
          {agent.icon}
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "12px", marginBottom: "4px" }}>
            <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground }}>
              {agent.name}
            </h1>
            <Badge variant={AGENT_STATUS_BADGE_VARIANT[status]} dot>
              {AGENT_STATUS_LABELS[status]}
            </Badge>
          </div>
          <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            {agent.description}
          </p>
          <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
            <Badge variant="neutral">{agent.kind}</Badge>
            <Badge variant="neutral">port:{agent.port}</Badge>
            {/* Show real model from /health endpoint */}
            {info && (
              <>
                <Badge variant="info">model:{info.model}</Badge>
                {info.templateId && (
                  <Badge variant="info">template:{info.templateId}</Badge>
                )}
                {info.version && (
                  <Badge variant="success">v{info.version}</Badge>
                )}
              </>
            )}
            {agent.capabilities
              .filter((cap) => !cap.startsWith("rpc:") && !cap.startsWith("cron:"))
              .map((cap) => (
                <Badge key={cap} variant="info">
                  {cap}
                </Badge>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
};

// ─── Chat Tab ────────────────────────────────────────────────────

const AgentChatTab: React.FC<{ agent: AgentRegistryEntry }> = ({
  agent,
}) => {
  const { status, messages, isStreaming, sendMessage, appendMessage, regenerate, stopChat, clearChat, reconnect, reconnectAttempts, lastError, lastToolCall, commands } = useAgentConnection(agent);
  const [input, setInput] = React.useState("");
  // ── Console slash commands (platform primitive; per-template manifest) ──
  const [commandBusy, setCommandBusy] = React.useState(false);
  const slashMatch = React.useMemo(() => {
    const m = input.match(/^\/([\w-]*)$/);
    return m ? m[1] : null;
  }, [input]);
  const slashCandidates = React.useMemo(() => {
    if (slashMatch === null || commands.length === 0) return [];
    if (slashMatch === "") return commands;
    return commands.filter((c) => c.name.startsWith(slashMatch));
  }, [slashMatch, commands]);
  const agentPrefix = React.useMemo(() => {
    const p = agent.wsPath.split("/agents/")[0];
    return p && p.startsWith("/d/") ? p : null;
  }, [agent.wsPath]);
  // File attachments staged in the composer (upload → R2 → file parts).
  const [attachments, setAttachments] = React.useState<
    Array<{ id: string; name: string; mimeType: string; sizeBytes: number; url?: string; status: "uploading" | "ready" | "error"; error?: string }>
  >([]);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const inputRef = React.useRef<HTMLTextAreaElement>(null);
  // ── Voice (fish.audio via /v1/voice/*) ──────────────────────────
  const [voiceEnabled, setVoiceEnabled] = React.useState(false);
  const [isRecording, setIsRecording] = React.useState(false);
  const [transcribing, setTranscribing] = React.useState(false);
  const [speakingId, setSpeakingId] = React.useState<string | null>(null);
  const mediaRecorderRef = React.useRef<MediaRecorder | null>(null);
  const recordingChunksRef = React.useRef<BlobPart[]>([]);
  const audioRef = React.useRef<HTMLAudioElement | null>(null);
  const [isTyping, setIsTyping] = React.useState(false);
  const [showScrollButton, setShowScrollButton] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const prevMessageCountRef = React.useRef(0);
  const prevContentLenRef = React.useRef(0);
  const typingTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  // Track if user sent a message and is waiting for a response
  const waitingForResponse = React.useRef(false);

  // ─── Listen for toast action events (reconnect/retry from toast buttons) ───
  React.useEffect(() => {
    const handleReconnect = () => reconnect();
    window.addEventListener(TOAST_RECONNECT_EVENT, handleReconnect);
    window.addEventListener(TOAST_RETRY_EVENT, handleReconnect);
    return () => {
      window.removeEventListener(TOAST_RECONNECT_EVENT, handleReconnect);
      window.removeEventListener(TOAST_RETRY_EVENT, handleReconnect);
    };
  }, [reconnect]);

  // Auto-scroll to bottom on new messages (only if already at bottom)
  const scrollToBottom = React.useCallback((smooth = true) => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: smooth ? "smooth" : "auto",
    });
  }, []);

  // Check if user is near the bottom of the scroll area
  const isNearBottom = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return true;
    const threshold = 100; // pixels from bottom
    return el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  }, []);

  // Track scroll position
  const handleScroll = React.useCallback(() => {
    setShowScrollButton(!isNearBottom());
  }, [isNearBottom]);

  // Auto-scroll and typing detection
  React.useEffect(() => {
    const wasNearBottom = isNearBottom();
    const newCount = messages.length;
    const oldCount = prevMessageCountRef.current;
    prevMessageCountRef.current = newCount;

    // Streaming assistant responses update the LAST message's content in
    // place — the message count never changes. Track total content length so
    // long responses follow to the bottom while streaming.
    const totalContentLen = messages.reduce(
      (n, m) => n + (m.content ? m.content.length : 0),
      0,
    );
    const contentGrew = totalContentLen > prevContentLenRef.current;
    prevContentLenRef.current = totalContentLen;

    // New message arrived
    if (newCount > oldCount) {
      const lastMsg = messages[messages.length - 1];

      // If user was waiting for a response and got an assistant message
      if (waitingForResponse.current && lastMsg?.role === "assistant") {
        waitingForResponse.current = false;
        setIsTyping(false);
        if (typingTimerRef.current) {
          clearTimeout(typingTimerRef.current);
          typingTimerRef.current = null;
        }
      }

      // If user sent a message, show typing indicator while waiting
      if (lastMsg?.role === "user" && status === "connected") {
        waitingForResponse.current = true;
        setIsTyping(true);
        // Safety timeout: clear typing after 30s even if no response
        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
          setIsTyping(false);
          waitingForResponse.current = false;
        }, 30000);
      }

      if (lastMsg?.role === "user") {
        // User's own (possibly long) message — always jump to the bottom,
        // after layout settles so the target position is correct.
        requestAnimationFrame(() => scrollToBottom(false));
      } else if (wasNearBottom) {
        // Auto-scroll only if user was already near bottom
        scrollToBottom();
      }
      return;
    }

    // No new message — follow streaming content growth while near bottom.
    if (contentGrew && isNearBottom()) {
      // Instant (not smooth) so long streams don't visibly lag behind.
      scrollToBottom(false);
    }
  }, [messages, status, isNearBottom, scrollToBottom]);

  // Clear typing timer on unmount
  React.useEffect(() => {
    return () => {
      if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
    };
  }, []);

  // Reset typing when connection drops
  React.useEffect(() => {
    if (status !== "connected") {
      setIsTyping(false);
      waitingForResponse.current = false;
    }
  }, [status]);

  /** Upload a staged file to the platform (R2) and return its signed URL. */
  const uploadFile = React.useCallback(async (file: File): Promise<void> => {
    const tempId = `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setAttachments((prev) => [...prev, { id: tempId, name: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size, status: "uploading" }]);
    try {
      const dataBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result ?? "");
          // Strip the data URL prefix — the API takes raw base64.
          resolve(result.startsWith("data:") ? result.slice(result.indexOf(",") + 1) : result);
        };
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
      const apiBase = DEPLOYMENT_API_URL.replace(/\/+$/, "");
      const res = await authFetch(`${apiBase}/v1/uploads`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: file.name, mimeType: file.type || "application/octet-stream", dataBase64 }),
        signal: AbortSignal.timeout(60000),
      });
      if (!res.ok) {
        const errBody = await res.json().catch(() => null);
        throw new Error(errBody?.error?.message || `Upload failed (${res.status})`);
      }
      const data = await res.json();
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === tempId
            ? { ...a, url: data.upload.url, sizeBytes: data.upload.sizeBytes, status: "ready" }
            : a,
        ),
      );
    } catch (err) {
      setAttachments((prev) =>
        prev.map((a) =>
          a.id === tempId ? { ...a, status: "error", error: err instanceof Error ? err.message : "Upload failed" } : a,
        ),
      );
    }
  }, []);

  const handleFilesPicked = (files: FileList | null) => {
    if (!files) return;
    for (const file of Array.from(files).slice(0, 5)) {
      void uploadFile(file);
    }
  };

  // ─── Voice: availability ────────────────────────────────────────
  React.useEffect(() => {
    let live = true;
    void getVoiceStatus().then((s) => {
      if (live && s) setVoiceEnabled(s.enabled && s.hasVoice);
    });
    return () => {
      live = false;
    };
  }, []);

  // ─── Voice: cleanup on unmount ──────────────────────────────────
  React.useEffect(() => {
    return () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== "inactive") {
        mediaRecorderRef.current.stop();
      }
      audioRef.current?.pause();
    };
  }, []);

  /** Toggle the mic. On stop, transcribes and fills the composer for review. */
  const toggleRecording = React.useCallback(async () => {
    if (isRecording) {
      mediaRecorderRef.current?.stop();
      return;
    }
    if (typeof navigator === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      return;
    }
    const mimeType = pickRecordingMimeType();
    if (!mimeType) {
      toast.error("Voice input", "Audio recording is not supported in this browser.");
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      recordingChunksRef.current = [];
      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) recordingChunksRef.current.push(e.data);
      };
      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        setIsRecording(false);
        const blob = new Blob(recordingChunksRef.current, { type: mimeType || "audio/webm" });
        recordingChunksRef.current = [];
        if (blob.size === 0) return;
        setTranscribing(true);
        try {
          const text = await transcribeAudio(blob);
          setInput((prev) => (prev.trim() ? `${prev.trim()} ${text}` : text));
          requestAnimationFrame(() => {
            inputRef.current?.focus();
            inputRef.current?.setSelectionRange(inputRef.current.value.length, inputRef.current.value.length);
          });
        } catch (err) {
          // Surface the transcript failure without losing the draft.
          toast.error("Voice input", err instanceof Error ? err.message : "Transcription failed");
        } finally {
          setTranscribing(false);
        }
      };
      recorder.start(250);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err) {
      setIsRecording(false);
      toast.error(
        "Voice input",
        err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError")
          ? "Microphone access was denied."
          : "Could not start the microphone.",
      );
    }
  }, [isRecording]);

  /** Read-aloud for an assistant message (toggle: click again to stop). */
  const handleReadAloud = React.useCallback(async (messageId: string, text: string) => {
    if (speakingId === messageId) {
      audioRef.current?.pause();
      audioRef.current = null;
      setSpeakingId(null);
      return;
    }
    audioRef.current?.pause();
    const speech = stripMarkdownForSpeech(text);
    if (!speech) return;
    setSpeakingId(messageId);
    try {
      const blob = await synthesizeSpeech(speech);
      const url = URL.createObjectURL(blob);
      const audio = new Audio(url);
      audioRef.current = audio;
      const cleanup = () => {
        URL.revokeObjectURL(url);
        if (audioRef.current === audio) audioRef.current = null;
        setSpeakingId((cur) => (cur === messageId ? null : cur));
      };
      audio.onended = cleanup;
      audio.onerror = () => {
        cleanup();
        toast.error("Read aloud", "Playback failed.");
      };
      await audio.play();
    } catch (err) {
      audioRef.current = null;
      setSpeakingId(null);
      toast.error("Read aloud", err instanceof Error ? err.message : "Speech generation failed");
    }
  }, [speakingId]);

  /**
   * Console slash command: /name arg=value "quoted value".
   * Deterministic (no model) — POSTs to the agent's /cmd/<name> route, which
   * runs a pipeline or tool and returns its JSON result.
   */
  const runSlashCommand = React.useCallback(
    async (text: string): Promise<boolean> => {
      const tokens = text.slice(1).trim().split(/\s+/).filter(Boolean);
      if (tokens.length === 0) return false;
      const cmd = commands.find((c) => c.name === tokens[0]);
      if (!cmd) return false;
      if (!agentPrefix) {
        toast.error("Command", "No agent proxy route available.");
        return true;
      }
      const args: Record<string, string | number> = {};
      for (let i = 1; i < tokens.length; i++) {
        const eq = tokens[i].indexOf("=");
        if (eq <= 0) {
          toast.error(`/${cmd.name}`, `Malformed argument: ${tokens[i]} (expected key=value)`);
          return true;
        }
        const key = tokens[i].slice(0, eq);
        let value: string = tokens[i].slice(eq + 1);
        if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Re-join any following tokens consumed by a quoted value.
        args[key] = value;
        if (value === "" && i + 1 < tokens.length) {
          // Quoted empty value — merge the rest of this argument.
          const rest = tokens.slice(i + 1).join(" ");
          args[key] = rest.replace(/^["']|["']$/g, "");
          break;
        }
      }
      // Validate declared args.
      const missing = cmd.args.filter((a) => !a.optional && !(a.name in args));
      if (missing.length > 0) {
        toast.error(`/${cmd.name}`, `Missing required argument: ${missing.map((a) => a.name).join(", ")}`);
        return true;
      }
      setCommandBusy(true);
      appendMessage({ id: `cmd-${Date.now()}-in`, role: "user", content: text, timestamp: new Date().toISOString() });
      try {
        const res = await authFetch(`${agentPrefix}/cmd/${cmd.name}`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(args),
          signal: AbortSignal.timeout(120000),
        });
        const payload: unknown = await res.json().catch(() => null);
        let content: string;
        if (!res.ok) {
          const msg =
            payload && typeof payload === "object" && "error" in payload
              ? String((payload as { error: unknown }).error)
              : `Command failed (${res.status})`;
          content = `**/${cmd.name}** failed: ${msg}`;
        } else if (cmd.render === "json") {
          content = "```json\n" + JSON.stringify(payload, null, 2) + "\n```";
        } else {
          const textish =
            payload && typeof payload === "object" && "result" in payload
              ? JSON.stringify((payload as { result: unknown }).result, null, 2)
              : JSON.stringify(payload, null, 2);
          content = `**/${cmd.name}**\n\n${textish}`;
        }
        appendMessage({ id: `cmd-${Date.now()}-out`, role: "assistant", content, timestamp: new Date().toISOString() });
      } catch (err) {
        appendMessage({
          id: `cmd-${Date.now()}-err`,
          role: "assistant",
          content: `**/${cmd.name}** failed: ${err instanceof Error ? err.message : "network error"}`,
          timestamp: new Date().toISOString(),
        });
      } finally {
        setCommandBusy(false);
      }
      return true;
    },
    [commands, agentPrefix],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const text = input.trim();
    if (!text || isStreaming || commandBusy) return;
    if (attachments.some((a) => a.status === "uploading")) return; // wait for uploads
    // Only treat as a command when it names a registered one; otherwise it's
    // a normal chat message (e.g. "why is /health 404?").
    if (text.startsWith("/") && commands.some((c) => text.slice(1).split(/\s+/)[0] === c.name)) {
      void runSlashCommand(text);
      setInput("");
      return;
    }
    const ready = attachments.filter((a) => a.status === "ready" && a.url);
    const sent = sendMessage(
      text,
      ready.map((a) => ({ id: a.id, name: a.name, mimeType: a.mimeType, sizeBytes: a.sizeBytes, url: a.url! })),
    );
    if (sent) {
      setInput("");
      setAttachments([]);
    }
  };

  const isConnected = status === "connected";
  const isConnecting = status === "connecting";
  const isError = status === "error";
  // Regenerate is available when the conversation ends on an assistant
  // reply that follows a user turn.
  const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const canRegenerate =
    lastMessage?.role === "assistant" && messages.some((m) => m.role === "user");

  // Connection banner style based on status
  const bannerConfig = React.useMemo(() => {
    if (isError) {
      return {
        bg: "var(--color-error-bg)",
        border: STATUS_COLORS.error,
        icon: "⚠",
        message: lastError ?? "Connection failed. The agent may be offline.",
      };
    }
    if (isConnecting) {
      return {
        bg: "var(--color-warning-bg)",
        border: STATUS_COLORS.warning,
        icon: "↻",
        message: reconnectAttempts > 0
          ? `Reconnecting… (attempt ${reconnectAttempts})`
          : "Establishing connection…",
      };
    }
    if (status === "disconnected") {
      return {
        bg: "var(--color-warning-bg)",
        border: STATUS_COLORS.warning,
        icon: "⇋",
        message: "Disconnected from agent.",
      };
    }
    return null;
  }, [status, isError, isConnecting, lastError, reconnectAttempts]);

  return (
    <Card padding="none" style={{ height: "600px", display: "flex", flexDirection: "column" }}>
      {/* ─── Connection Bar ────────────────────────────────── */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "12px 16px",
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <StatusDot variant={AGENT_STATUS_BADGE_VARIANT[status]} pulse={isConnected} />
          <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            {AGENT_STATUS_LABELS[status]}
            {reconnectAttempts > 0 && !isConnected && ` · attempt ${reconnectAttempts}`}
          </span>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          {isStreaming && (
            <Button variant="secondary" size="sm" onClick={() => stopChat()}>
              Stop
            </Button>
          )}
          {isConnected && !isStreaming && canRegenerate && (
            <Button variant="ghost" size="sm" onClick={() => regenerate()} title="Re-run the last question">
              ↻ Regenerate
            </Button>
          )}
          {isConnected && messages.length > 0 && !isStreaming && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                // Wipes the server-side persisted conversation too, so the
                // next reconnect replays a clean slate.
                clearChat();
              }}
            >
              Clear
            </Button>
          )}
          {!isConnected && (
            <Button
              variant={isError ? "primary" : "secondary"}
              size="sm"
              onClick={reconnect}
              loading={isConnecting}
            >
              {isConnecting ? "Connecting…" : "Reconnect"}
            </Button>
          )}
        </div>
      </div>

      {/* ─── Connection State Banner ───────────────────────── */}
      {bannerConfig && (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "8px 16px",
            backgroundColor: bannerConfig.bg,
            borderBottom: `1px solid ${COLORS.border}`,
            fontSize: "0.75rem",
            color: COLORS.foreground,
          }}
        >
          <span style={{ color: bannerConfig.border, fontSize: "0.875rem", flexShrink: 0 }}>
            {bannerConfig.icon}
          </span>
          <span style={{ flex: 1 }}>{bannerConfig.message}</span>
          {isError && (
            <span style={{ fontSize: "0.6875rem", color: COLORS.mutedForeground }}>
              ws://{agent.id}:{agent.port}
            </span>
          )}
        </div>
      )}

      {/* ─── Messages ───────────────────────────────────────── */}
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        style={{
          flex: 1,
          overflowY: "auto",
          padding: "16px",
          display: "flex",
          flexDirection: "column",
          gap: "12px",
          position: "relative",
        }}
      >
        {messages.length === 0 ? (
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              gap: "12px",
              color: COLORS.mutedForeground,
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: "2.5rem", opacity: 0.6 }}>{agent.icon}</span>
            <div>
              <div style={{ fontSize: "0.9375rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "4px" }}>
                {isConnected ? "Ready to chat" : "Awaiting connection"}
              </div>
              <span style={{ fontSize: "0.8125rem" }}>
                {isConnected
                  ? `Send a message to start talking with ${agent.name}`
                  : `${agent.name} will be available once connected`}
              </span>
            </div>
          </div>
        ) : (
          <>
            {messages.map((msg, i) => (
              <MessageBubble
                key={msg.id}
                message={msg}
                showTimestamp={
                  i === 0 ||
                  new Date(messages[i - 1].timestamp).getTime() +
                    5 * 60 * 1000 < new Date(msg.timestamp).getTime()
                }
                onReadAloud={voiceEnabled ? handleReadAloud : undefined}
                speakingId={speakingId}
              />
            ))}

            {/* Typing indicator */}
            {isTyping && (
              <div style={{ display: "flex", justifyContent: "flex-start" }}>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "4px",
                    padding: "10px 14px",
                    borderRadius: "12px 12px 12px 2px",
                    backgroundColor: COLORS.secondary,
                  }}
                >
                  <TypingDot delay={0} />
                  <TypingDot delay={150} />
                  <TypingDot delay={300} />
                </div>
              </div>
            )}

            {/* Tool call indicator — shows when agent is executing a tool */}
            {isTyping && lastToolCall && (
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 12px",
                  fontSize: "0.75rem",
                  color: COLORS.mutedForeground,
                  backgroundColor: COLORS.secondary,
                  borderRadius: RADIUS.md,
                  alignSelf: "flex-start",
                  marginLeft: "4px",
                }}
              >
                <StatusDot
                  variant={
                    lastToolCall.status === "done"
                      ? "success"
                      : lastToolCall.status === "error"
                        ? "error"
                        : "warning"
                  }
                  pulse={lastToolCall.status === "running"}
                  size={6}
                />
                <span>
                  {lastToolCall.status === "running"
                    ? `Calling ${lastToolCall.name}…`
                    : lastToolCall.status === "done"
                      ? `${lastToolCall.name} completed`
                      : `${lastToolCall.name} failed`}
                </span>
              </div>
            )}

            {/* Scroll to bottom button */}
            {showScrollButton && (
              <button
                onClick={() => scrollToBottom()}
                style={{
                  position: "sticky",
                  bottom: "0",
                  alignSelf: "center",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "32px",
                  height: "32px",
                  borderRadius: "50%",
                  backgroundColor: COLORS.card,
                  border: `1px solid ${COLORS.border}`,
                  boxShadow: "0 2px 8px rgba(0,0,0,0.12)",
                  cursor: "pointer",
                  color: COLORS.foreground,
                  zIndex: 1,
                }}
                aria-label="Scroll to latest"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </button>
            )}
          </>
        )}
      </div>

      {/* ─── Input ──────────────────────────────────────────── */}
      <div style={{ borderTop: `1px solid ${COLORS.border}`, padding: "12px 16px", position: "relative" }}>
        {/* Slash-command autocomplete (manifest from cf_agent_meta) */}
        {slashCandidates.length > 0 && !commandBusy && (
          <div
            style={{
              position: "absolute",
              bottom: "100%",
              left: "16px",
              right: "16px",
              marginBottom: "4px",
              maxHeight: "220px",
              overflowY: "auto",
              backgroundColor: COLORS.card,
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
              boxShadow: "0 -4px 16px rgba(0,0,0,0.12)",
              zIndex: 20,
            }}
          >
            {slashCandidates.map((c) => (
              <button
                key={c.name}
                type="button"
                onClick={() => {
                  setInput(`/${c.name} `);
                  inputRef.current?.focus();
                }}
                style={{
                  display: "block",
                  width: "100%",
                  textAlign: "left",
                  padding: "8px 12px",
                  border: "none",
                  borderBottom: `1px solid ${COLORS.border}`,
                  background: "none",
                  cursor: "pointer",
                  color: COLORS.foreground,
                  fontFamily: "inherit",
                }}
              >
                <span style={{ fontSize: "0.8125rem", fontWeight: 500, fontFamily: "monospace" }}>
                  /{c.name}
                  {c.args.length > 0 && (
                    <span style={{ color: COLORS.mutedForeground, fontWeight: 400 }}>
                      {" "}{c.args.map((a) => `<${a.name}${a.optional ? "?" : ""}>`).join(" ")}
                    </span>
                  )}
                </span>
                <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginTop: "2px" }}>{c.description}</div>
              </button>
            ))}
          </div>
        )}
        {/* Staged attachments */}
        {attachments.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px", marginBottom: "8px" }}>
            {attachments.map((a) => (
              <span
                key={a.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: "6px",
                  padding: "3px 8px",
                  borderRadius: RADIUS.md,
                  fontSize: "0.75rem",
                  backgroundColor: a.status === "error" ? "var(--color-error-bg, rgba(239,68,68,0.12))" : COLORS.secondary,
                  color: COLORS.foreground,
                  border: `1px solid ${COLORS.border}`,
                }}
                title={a.error || `${a.name} (${Math.round(a.sizeBytes / 1024)} KB)`}
              >
                {a.status === "uploading" ? "⏳" : a.status === "error" ? "⚠️" : "📎"}
                <span style={{ maxWidth: "160px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {a.name}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${a.name}`}
                  onClick={() => setAttachments((prev) => prev.filter((x) => x.id !== a.id))}
                  style={{ border: "none", background: "none", color: COLORS.mutedForeground, cursor: "pointer", padding: 0, fontSize: "0.875rem" }}
                >
                  ✕
                </button>
              </span>
            ))}
          </div>
        )}
        <form
          onSubmit={handleSubmit}
          style={{ display: "flex", gap: "8px", alignItems: "flex-end" }}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="image/png,image/jpeg,image/webp,image/gif,text/*,.txt,.md,.csv,.json,.js,.ts,.py,.yaml,.yml,.xml,.log,.sh,.html,.css,.toml,.sql,.ini,.go,.rs,.java,.c,.h,.cpp,.rb"
            style={{ display: "none" }}
            onChange={(e) => {
              handleFilesPicked(e.target.files);
              e.target.value = "";
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            title="Attach files (images or text)"
            disabled={!isConnected || isStreaming}
            onClick={() => fileInputRef.current?.click()}
          >
            📎
          </Button>
          {voiceEnabled && (
            <Button
              type="button"
              variant={isRecording ? "destructive" : "ghost"}
              size="sm"
              title={isRecording ? "Stop recording" : transcribing ? "Transcribing…" : "Dictate (voice to text)"}
              disabled={!isConnected || isStreaming || transcribing}
              onClick={() => void toggleRecording()}
            >
              {transcribing ? "⏳" : isRecording ? "⏹" : "🎙"}
            </Button>
          )}
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={(e) => {
              // Pasted images become attachments automatically.
              const files = Array.from(e.clipboardData?.files ?? []).filter((f) => f.type.startsWith("image/"));
              if (files.length > 0) {
                e.preventDefault();
                handleFilesPicked(files as unknown as FileList);
              }
            }}
            onKeyDown={(e) => {
              // Tab completes the active slash candidate.
              if (e.key === "Tab" && slashCandidates.length > 0) {
                e.preventDefault();
                const pick = slashCandidates[0];
                setInput(`/${pick.name} `);
                return;
              }
              // Escape dismisses the slash popup (clears to the bare slash).
              if (e.key === "Escape" && slashMatch !== null) {
                e.preventDefault();
                setInput("");
                return;
              }
              // Enter sends; Shift+Enter inserts a newline.
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                if (isConnected && input.trim() && !isStreaming && !commandBusy) handleSubmit(e);
              }
            }}
            rows={Math.min(5, Math.max(1, input.split("\n").length))}
            placeholder={isConnected ? `Message ${agent.name}… (Enter to send, Shift+Enter for newline, paste images to attach)` : isConnecting ? "Connecting…" : "Connect to send messages"}
            disabled={!isConnected || isStreaming}
            style={{
              flex: 1,
              padding: "10px 12px",
              borderRadius: RADIUS.md,
              border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.background,
              color: COLORS.foreground,
              fontSize: "0.875rem",
              lineHeight: 1.4,
              outline: "none",
              resize: "none",
              fontFamily: "inherit",
              opacity: !isConnected || isStreaming ? 0.6 : 1,
            }}
          />
          <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
            {isStreaming ? (
              <Button type="button" variant="secondary" size="sm" onClick={() => stopChat()}>
                Stop
              </Button>
            ) : (
              <Button
                type="submit"
                variant="primary"
                disabled={!isConnected || !input.trim() || commandBusy || attachments.some((a) => a.status === "uploading")}
              >
                {commandBusy ? "Running…" : input.trim().startsWith("/") && commands.some((c) => input.trim().slice(1).split(/\s+/)[0] === c.name) ? "Run" : "Send"}
              </Button>
            )}
          </div>
        </form>
      </div>
    </Card>
  );
};

// ─── Typing Dot ──────────────────────────────────────────────────

const TypingDot: React.FC<{ delay: number }> = ({ delay }) => (
  <span
    style={{
      width: "6px",
      height: "6px",
      borderRadius: "50%",
      backgroundColor: COLORS.mutedForeground,
      animation: "typingPulse 1.4s infinite ease-in-out",
      animationDelay: `${delay}ms`,
    }}
  />
);

// ─── Message Bubble ──────────────────────────────────────────────

const MessageBubble: React.FC<{
  message: ChatMessage;
  showTimestamp?: boolean;
  onReadAloud?: (id: string, text: string) => void;
  speakingId?: string | null;
}> = ({ message, showTimestamp = false, onReadAloud, speakingId }) => {
  const isUser = message.role === "user";
  const isSystem = message.role === "system";
  const speaking = speakingId === message.id;
  const time = React.useMemo(() => {
    try {
      return new Date(message.timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
    } catch {
      return "";
    }
  }, [message.timestamp]);

  // System notices (agent error notices, protocol messages) render as a
  // centered muted line — not a chat bubble.
  if (isSystem) {
    return (
      <div
        style={{
          textAlign: "center",
          fontSize: "0.75rem",
          color: COLORS.mutedForeground,
          margin: "8px 16px",
          padding: "6px 10px",
          borderRadius: RADIUS.md,
          backgroundColor: "var(--color-warning-bg, rgba(245, 158, 11, 0.08))",
          wordBreak: "break-word",
        }}
      >
        {message.content}
        {time && (
          <span style={{ opacity: 0.6, marginLeft: "8px" }}>{time}</span>
        )}
      </div>
    );
  }

  const html = React.useMemo(() => renderMarkdown(message.content), [message.content]);

  return (
    <div>
      {/* Timestamp separator */}
      {showTimestamp && time && (
        <div
          style={{
            textAlign: "center",
            fontSize: "0.6875rem",
            color: COLORS.mutedForeground,
            margin: "8px 0 4px",
          }}
        >
          {time}
        </div>
      )}
      <div
        style={{
          display: "flex",
          justifyContent: isUser ? "flex-end" : "flex-start",
        }}
      >
        <div
          style={{
            maxWidth: "70%",
            padding: "8px 14px",
            borderRadius: isUser ? "12px 12px 2px 12px" : "12px 12px 12px 2px",
            backgroundColor: isUser ? COLORS.primary : COLORS.secondary,
            color: isUser ? COLORS.primaryForeground : COLORS.foreground,
            fontSize: "0.875rem",
            lineHeight: 1.5,
            wordBreak: "break-word",
            overflowWrap: "break-word",
            overflowX: "auto",
          }}
        >
          {isUser && message.attachmentNames && message.attachmentNames.length > 0 && (
            <div style={{ marginBottom: "4px", fontSize: "0.75rem", opacity: 0.85 }}>
              {message.attachmentNames.map((n) => (
                <div key={n} style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  📎 {n}
                </div>
              ))}
            </div>
          )}
          {message.content && (
            <div
              className="chat-markdown"
              // Sanitized by renderMarkdown (DOMPurify) — safe to inject.
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
          {!isUser && !isSystem && onReadAloud && message.content && !message.streaming && (
            <button
              type="button"
              onClick={() => onReadAloud(message.id, message.content)}
              title={speaking ? "Stop read-aloud" : "Read aloud"}
              aria-label={speaking ? "Stop read-aloud" : "Read aloud"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "4px",
                marginTop: "6px",
                padding: "2px 8px",
                fontSize: "0.72rem",
                borderRadius: "999px",
                border: `1px solid ${speaking ? "var(--color-error, #ef4444)" : COLORS.border}`,
                backgroundColor: "transparent",
                color: speaking ? "var(--color-error, #ef4444)" : COLORS.mutedForeground,
                cursor: "pointer",
              }}
            >
              {speaking ? "⏹ stop" : "🔊 read aloud"}
            </button>
          )}
          {time && (
            <div
              style={{
                fontSize: "0.625rem",
                color: COLORS.mutedForeground,
                marginTop: "4px",
                textAlign: "right",
                opacity: 0.7,
              }}
            >
              {time}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

// ─── Monitor Tab ─────────────────────────────────────────────────

const AgentMonitorTab: React.FC<{ agent: AgentRegistryEntry }> = ({
  agent,
}) => {
  const { status, latencyMs } = useAgentHealth(agent);
  const { messages, reconnectAttempts, agentState, agentIdentity, lastToolCall } =
    useAgentConnection(agent);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {/* Metrics */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
          gap: "16px",
        }}
      >
        <MetricCard label="Status" value={AGENT_STATUS_LABELS[status]} />
        <MetricCard label="Latency" value={latencyMs !== null ? `${latencyMs}ms` : "—"} />
        <MetricCard label="Messages" value={messages.length} />
        <MetricCard label="Reconnects" value={reconnectAttempts} />
      </div>

      {/* Agent Identity + Last Tool Call */}
      {(agentIdentity || lastToolCall) && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
            gap: "16px",
          }}
        >
          {agentIdentity && (agentIdentity.id || agentIdentity.name) && (
            <Card padding="md">
              <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.04em", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Agent Identity
              </div>
              {agentIdentity.name && (
                <div style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground }}>
                  {agentIdentity.name}
                </div>
              )}
              {agentIdentity.id && (
                <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)" }}>
                  {agentIdentity.id}
                </div>
              )}
            </Card>
          )}
          {lastToolCall && (
            <Card padding="md">
              <div style={{ fontSize: "0.6875rem", textTransform: "uppercase", letterSpacing: "0.04em", color: COLORS.mutedForeground, marginBottom: "4px" }}>
                Last Tool Call
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                <StatusDot
                  variant={
                    lastToolCall.status === "done"
                      ? "success"
                      : lastToolCall.status === "error"
                        ? "error"
                        : "warning"
                  }
                  pulse={lastToolCall.status === "running"}
                />
                <span style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground, fontFamily: "var(--font-mono)" }}>
                  {lastToolCall.name}
                </span>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* Live Agent State from WS sync */}
      <Card>
        <Card.Header
          title="Agent State"
          subtitle={
            agentState
              ? "Live Durable Object state synced via WebSocket"
              : "No state synced yet — connect via chat to see live DO state"
          }
        />
        <CodeBlock
          code={JSON.stringify(
            agentState ?? {
              agentId: agent.id,
              note: "State will appear here once the agent pushes cf_agent_state messages.",
              messageCount: messages.length,
              lastMessages: messages.slice(-5).map((m) => ({
                role: m.role,
                content: m.content.slice(0, 100),
                timestamp: m.timestamp,
              })),
            },
            null,
            2,
          )}
          language="json"
          title="agent-state.json"
          showLineNumbers
        />
      </Card>
    </div>
  );
};

// ─── Config Tab ──────────────────────────────────────────────────

const AgentConfigTab: React.FC<{ agent: AgentRegistryEntry }> = ({
  agent,
}) => {
  const { info, loading, refetch } = useAgentInfo(agent);

  return (
    <Card>
      <Card.Header
        title="Configuration"
        subtitle="Agent settings and model parameters"
        actions={
          <Button variant="secondary" size="sm" onClick={refetch} loading={loading}>
            Refresh
          </Button>
        }
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <ConfigRow label="Agent ID" value={agent.id} />
        <ConfigRow label="Kind" value={agent.kind} />
        <ConfigRow label="Port" value={String(agent.port)} />
        <ConfigRow label="WebSocket Path" value={agent.wsPath} />
        <ConfigRow label="Supports Chat" value={agent.supportsChat ? "Yes" : "No"} />
        <ConfigRow label="Has Cron" value={agent.hasCron ? "Yes" : "No"} />
        <ConfigRow label="Capabilities" value={agent.capabilities.join(", ") || "—"} />
      </div>

      {/* Deployment Info from live /health endpoint */}
      <div style={{ marginTop: "24px" }}>
        <h4 style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
          Deployment Info
        </h4>
        {loading ? (
          <div style={{ padding: "12px 0" }}>
            <LoadingState message="Fetching deployment info…" />
          </div>
        ) : info ? (
          <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
            <ConfigRow label="Model" value={info.model} />
            <ConfigRow label="Template ID" value={info.templateId} />
            <ConfigRow label="Deployment ID" value={info.deploymentId} />
            <ConfigRow label="Version" value={info.version} />
            <ConfigRow label="Available Agents" value={info.agents.join(", ") || "—"} />
          </div>
        ) : (
          <div style={{ padding: "12px 0", fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            Deployment info is temporarily unavailable. Check the Monitor tab for the connection status.
          </div>
        )}
      </div>

      <div style={{ marginTop: "24px" }}>
        <h4 style={{ fontSize: "0.875rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "12px" }}>
          Model Configuration
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
          <ConfigRow label="Model" value={info?.model ?? "— (not reachable)"} />
          {/* Temperature / max-tokens are baked into the deployed worker by the
              blueprint at publish time — they are not runtime-configurable
              from the console, so we don't show placeholder values. */}
          <ConfigRow label="Streaming" value="Enabled" />
        </div>
      </div>
    </Card>
  );
};

const ConfigRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "8px 0",
      borderBottom: `1px solid ${COLORS.border}`,
    }}
  >
    <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>{label}</span>
    <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, fontFamily: "var(--font-mono)" }}>
      {value}
    </span>
  </div>
);

// ─── Schedules Tab ───────────────────────────────────────────────

const AgentSchedulesTab: React.FC<{ agent: AgentRegistryEntry }> = ({
  agent,
}) => {
  if (!agent.hasCron) {
    return (
      <EmptyState
        icon="🕐"
        title="No Schedules"
        message="This agent does not have any cron schedules configured."
      />
    );
  }

  const cronCap = agent.capabilities.find((c) => c.startsWith("cron:"));

  return (
    <Card>
      <Card.Header
        title="Cron Schedules"
        subtitle="Scheduled task execution for this agent"
        actions={<Button variant="primary" size="sm">+ Add Schedule</Button>}
      />
      <table style={{ width: "100%", borderCollapse: "collapse" }}>
        <thead>
          <tr>
            {["Schedule", "Status", "Last Run", "Next Run", "Actions"].map((h) => (
              <th
                key={h}
                style={{
                  height: "44px",
                  padding: "0 16px",
                  fontSize: "0.75rem",
                  fontWeight: 600,
                  textTransform: "uppercase",
                  letterSpacing: "0.04em",
                  color: COLORS.mutedForeground,
                  textAlign: "left",
                  borderBottom: `1px solid ${COLORS.border}`,
                }}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr style={{ height: "48px" }}>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, fontFamily: "var(--font-mono)", fontSize: "0.8125rem" }}>
              {cronCap?.replace("cron:", "") ?? "—"}
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
              <Badge variant="success" dot>Active</Badge>
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
              —
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}`, color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
              —
            </td>
            <td style={{ padding: "0 16px", borderBottom: `1px solid ${COLORS.border}` }}>
              <Button variant="ghost" size="sm">Edit</Button>
            </td>
          </tr>
        </tbody>
      </table>
    </Card>
  );
};

// ─── Storage Tab ─────────────────────────────────────────────────

const AgentStorageTab: React.FC<{ agent: AgentRegistryEntry }> = ({ agent }) => (
  <Card>
    <Card.Header
      title="Storage"
      subtitle="Durable Object storage and bindings"
    />
    {agent.port === 0 && agent.className ? (
      <div style={{ display: "flex", flexDirection: "column", gap: "12px", fontSize: "14px" }}>
        <div>
          <b>Durable Object</b>
          <p style={{ margin: "4px 0 0", color: COLORS.mutedForeground }}>
            This agent runs as the Durable Object class{" "}
            <code style={{ fontFamily: "ui-monospace, monospace", fontSize: "13px" }}>{agent.className}</code>.
            State (conversation history, pipeline data, SQLite rows) persists
            on that object and survives redeploys.
          </p>
        </div>
        <div>
          <b>External bindings (KV / R2 / D1)</b>
          <p style={{ margin: "4px 0 0", color: COLORS.mutedForeground }}>
            No additional KV, R2, or D1 bindings are configured for this agent.
          </p>
        </div>
      </div>
    ) : (
      <EmptyState
        icon="📦"
        title="No Storage Bindings"
        message="This agent does not have any KV namespaces or Durable Object bindings configured."
        action={{ label: "Add Binding", onClick: () => {} }}
      />
    )}
  </Card>
);

// ─── Logs Tab ────────────────────────────────────────────────────

const AgentLogsTab: React.FC<{ agent: AgentRegistryEntry }> = ({
  agent,
}) => (
  <Card>
    <Card.Header
      title="Logs"
      subtitle={`Recent log entries for ${agent.name}`}
    />
    <EmptyState
      icon="📋"
      title="No Logs Available"
      message="Agent logs are not streamed to this console. In production, connect a logging backend (e.g. Cloudflare Workers Analytics, Logpush) to view real-time log output here."
    />
  </Card>
);

// ─── Traces Tab ──────────────────────────────────────────────────

const AgentTracesTab: React.FC<{ agent: AgentRegistryEntry }> = () => (
  <Card>
    <Card.Header
      title="Traces"
      subtitle="Execution traces and spans"
    />
    <EmptyState
      icon="🔍"
      title="No Traces Available"
      message="Enable tracing in your agent configuration to see execution spans here."
    />
  </Card>
);

// ─── Versions Tab ────────────────────────────────────────────────

const AgentVersionsTab: React.FC<{ agent: AgentRegistryEntry }> = () => (
  <Card>
    <Card.Header
      title="Version History"
      subtitle="Deployment history and rollback points"
    />
    <EmptyState
      icon="🏷️"
      title="No Version History"
      message="Deployment versions are managed by Wrangler and your CI/CD pipeline, not by this console. Use `wrangler deployments list` or check your Git history for deployment records."
    />
  </Card>
);
