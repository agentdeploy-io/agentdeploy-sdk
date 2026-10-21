/**
 * voice-events — shared /events socket access for the Calls module (B3).
 * ────────────────────────────────────────────────────────────────────
 * Acquires the SAME ref-counted WsLifecycleManager the console shell uses
 * (identical registry key = resolved /events URL, no token/since), so the
 * Calls screen's `calla:voice:*` frame tracking costs zero extra
 * connections. Factory options mirror useCallaEvents exactly (the factory
 * only runs if this hook acquires first).
 */

import * as React from "react";
import { CALLA_PING_TEXT, CALLA_PONG_TEXT } from "@calla/shared";
import { DEFAULT_AGENT_CONFIG } from "@/constants/agents";
import { buildAuthedWsUrl } from "@/hooks/useAuthFetch";
import { buildCallaEventsUrl } from "@/hooks/useCallaEvents";
import { AppErrors } from "@/errors/AppError";
import { errorHandler } from "@/errors/errorHandler";
import { acquireManager, type AcquiredManager } from "@/lib/ws-registry";

/** Heartbeat mirrors useCallaEvents (the hub answers raw ping with raw pong). */
const HEARTBEAT_INTERVAL_MS = 25_000;
const HEARTBEAT_TIMEOUT_MS = 10_000;

/**
 * The shared /events manager. Use inside a component:
 *   const { manager, release } = useVoiceEventsManager();
 * and in an effect: `manager.addListener({ onMessage, onStateChange })` —
 * cleanup must call the listener's remove AND `release()`.
 */
export function useVoiceEventsManager(): AcquiredManager {
  const acquired = React.useRef<AcquiredManager | null>(null);

  if (!acquired.current) {
    const resolvedUrl = buildCallaEventsUrl();
    acquired.current = acquireManager(resolvedUrl, () => ({
      url: () => buildAuthedWsUrl(resolvedUrl),
      heartbeat: {
        intervalMs: HEARTBEAT_INTERVAL_MS,
        timeoutMs: HEARTBEAT_TIMEOUT_MS,
        pingText: CALLA_PING_TEXT,
        isPong: (message) => message === CALLA_PONG_TEXT,
      },
      backoff: { baseMs: DEFAULT_AGENT_CONFIG.reconnectBaseDelay, maxMs: 30_000, jitter: "full" },
      maxAttempts: DEFAULT_AGENT_CONFIG.autoReconnect ? Number.POSITIVE_INFINITY : 0,
      slowRetryMs: 60_000,
      connectionTimeoutMs: 8_000,
      minUptimeMs: 5_000,
      queue: { enabled: true, maxSize: 100 },
      label: "calla-events",
      onMessage: () => {},
      onError: (error) => {
        const appError = AppErrors.connectionFailed("calla-events", new Error(error.message));
        errorHandler.handleError(appError, { showToast: false });
      },
    }));
  }

  React.useEffect(() => {
    return () => {
      acquired.current?.release();
      acquired.current = null;
    };
  }, []);

  return acquired.current;
}
