/**
 * Channels configuration + the dependency factory the integrator wires up.
 *
 * readConfig() is pure env -> ChannelsConfig. buildChannelsDeps(mastra, store,
 * edgeBaseUrl?) returns the ChannelDeps with sensible DEFAULT implementations:
 *   - decideEdgeApproval  → fetch POST {edge}/approvals/{agent}/{id}/decision
 *   - decideMastraApproval→ fetch POST to the brain's OWN loopback route
 *                           (http://127.0.0.1:${PORT}/agents/orchestrator/…)
 *   - listPendingMastra   → store.listApprovals({status:"pending"}) filtered to
 *                           source "mastra", mapped to ApprovalRequest
 *
 * LOOPBACK CHOICE: the brain decides its own Mastra approvals via
 * agent.approveToolCall/declineToolCall, which live behind the routes in
 * server.ts. To avoid reaching into server.ts internals (and to inherit its
 * store hooks + auth), we call those routes over loopback instead, forwarding
 * `Authorization: Bearer ${CALLA_TOKEN}` when the brain is secured. The
 * integrator can override decideMastraApproval with a direct agent call if they
 * prefer to skip the HTTP hop.
 */
import type { CallaStore } from "../store/types.js";
import type { ChannelDeps, ChannelsConfig, MastraLike } from "./types.js";
import { rowToApprovalRequest } from "./decisions.js";
import { truncate } from "./util.js";

const DEFAULT_TELEGRAM_API = "https://api.telegram.org";
const DEFAULT_WHATSAPP_API = "https://graph.facebook.com/v21.0";
const DEFAULT_EDGE = "http://127.0.0.1:8787";

function clean(value: string | undefined): string | undefined {
  const v = value?.trim();
  return v ? v : undefined;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

/** Read + normalize the channels config from the environment (pure). */
export function readConfig(): ChannelsConfig {
  const env = process.env;
  const telegramToken = clean(env.TELEGRAM_BOT_TOKEN) ?? clean(env.TELEGRAM_TOKEN);
  // WHATSAPP_ACCESS_TOKEN is the @chat-adapter/whatsapp convention; accept both.
  const waToken = clean(env.WHATSAPP_TOKEN) ?? clean(env.WHATSAPP_ACCESS_TOKEN);
  const waPhone = clean(env.WHATSAPP_PHONE_NUMBER_ID);
  const edgeEventsUrl = stripTrailingSlash(
    clean(env.CHANNELS_EDGE_EVENTS_URL) ?? clean(env.CALLA_EDGE_URL) ?? DEFAULT_EDGE,
  );

  return {
    telegram: {
      enabled: Boolean(telegramToken),
      botToken: telegramToken,
      apiBase: stripTrailingSlash(clean(env.TELEGRAM_API_BASE) ?? DEFAULT_TELEGRAM_API),
      webhookUrl: clean(env.TELEGRAM_WEBHOOK_URL),
      webhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET),
    },
    whatsapp: {
      // WhatsApp needs both a token AND a phone-number id to send.
      enabled: Boolean(waToken && waPhone),
      token: waToken,
      phoneNumberId: waPhone,
      verifyToken: clean(env.WHATSAPP_VERIFY_TOKEN),
      appSecret: clean(env.WHATSAPP_APP_SECRET),
      apiBase: stripTrailingSlash(clean(env.WHATSAPP_API_BASE) ?? DEFAULT_WHATSAPP_API),
    },
    edgeEventsUrl,
  };
}

/** Resolve a Mastra agent by key, defaulting to the orchestrator. */
function resolveMastraAgent(mastra: MastraLike, id?: string): any {
  const key = id ?? "orchestratorAgent";
  try {
    if (typeof mastra.getAgent === "function") {
      const agent = mastra.getAgent(key);
      if (agent) return agent;
    }
  } catch {
    // fall through to listAgents
  }
  const agents =
    (typeof mastra.listAgents === "function" ? mastra.listAgents() : undefined) ?? {};
  return agents[key] ?? agents["orchestratorAgent"] ?? Object.values(agents)[0];
}

/**
 * Build ChannelDeps with default fetch-based decision routing.
 * @param mastra        the brain's Mastra instance (agent accessor for /ask)
 * @param store         the existing CallaStore (cache + approvals + audit)
 * @param edgeBaseUrl   edge worker base URL (defaults to config.edgeEventsUrl)
 */
export function buildChannelsDeps(
  mastra: MastraLike,
  store: CallaStore,
  edgeBaseUrl?: string,
): ChannelDeps {
  const cfg = readConfig();
  const edge = stripTrailingSlash(edgeBaseUrl ?? cfg.edgeEventsUrl);

  return {
    store,
    getAgent: (id?: string) => resolveMastraAgent(mastra, id),
    edgeBaseUrl: edge,

    decideEdgeApproval: async (agentName, approvalId, approved) => {
      const url = `${edge}/approvals/${encodeURIComponent(agentName)}/${encodeURIComponent(
        approvalId,
      )}/decision`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved }),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`edge decision ${res.status}: ${truncate(detail, 200)}`);
      }
    },

    decideMastraApproval: async (runId, toolCallId, approved, reason) => {
      const port = Number(process.env.PORT) || 3000;
      const base = stripTrailingSlash(
        clean(process.env.CHANNELS_BRAIN_LOOPBACK) ?? `http://127.0.0.1:${port}`,
      );
      const path = approved ? "approve-tool-call" : "decline-tool-call";
      const headers: Record<string, string> = { "content-type": "application/json" };
      const token = process.env.CALLA_TOKEN;
      if (token) headers.Authorization = `Bearer ${token}`;
      const body = approved
        ? { runId, ...(toolCallId ? { toolCallId } : {}) }
        : {
            runId,
            ...(toolCallId ? { toolCallId } : {}),
            ...(reason ? { reason } : {}),
          };
      const res = await fetch(`${base}/agents/orchestrator/${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const detail = await res.text().catch(() => "");
        throw new Error(`brain decision ${res.status}: ${truncate(detail, 200)}`);
      }
    },

    listPendingMastra: async () => {
      const rows = await store.listApprovals({ status: "pending", limit: 100 });
      return rows.filter((r) => r.source === "mastra").map(rowToApprovalRequest);
    },
  };
}
