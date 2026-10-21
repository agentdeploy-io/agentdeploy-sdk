/**
 * Edge Worker REST Adapter
 * ────────────────────────
 * Thin client over the Calla edge worker (Cloudflare).
 *
 * Same-origin by default — the Vite dev proxy forwards /steps, /approvals,
 * /fleet, /events to the edge worker on :8787; in production the worker
 * serves them directly. Pass { baseUrl } to target a specific worker
 * (e.g. https://{worker}.workers.dev).
 *
 * Endpoints:
 *   POST {base}/steps/{agentName}                             → StepResult
 *   POST {base}/approvals/{agentName}/{approvalId}/decision   → 200
 *   GET  {base}/fleet                                         → Agent[]
 *   POST {base}/events/ingest  (x-calla-token when configured)
 *
 * All requests go through authFetch (edge-JWT Bearer on custom domains,
 * session cookie on subdomains, nothing in local dev).
 */

import type { Agent, CallaStep, CallaWsFrame, StepResult } from "@calla/shared";
import { authFetch } from "@/hooks/useAuthFetch";
import { readStoredEdgeJwt } from "@/constants/auth";

// ─── Types ───────────────────────────────────────────────────────

export interface EdgeClientOptions {
  /** Base URL override ("" = same-origin). Trailing slashes are stripped. */
  baseUrl?: string;
  /**
   * Explicit x-calla-token for ingestEvent. Defaults to the stored edge JWT
   * when one exists (custom-domain auth); omitted otherwise.
   */
  token?: string | null;
}

export interface ApprovalDecisionInput {
  approved: boolean;
  /** "Edit & Approve" — the workflow resumes the step with these params. */
  updatedArgs?: Record<string, unknown>;
}

export interface EdgeClient {
  /** Kick off (or continue) a gated step on an edge agent. */
  executeStep(agentName: string, step: CallaStep): Promise<StepResult>;
  /** Decide a pending edge approval (HITL gate). */
  decideApproval(
    agentName: string,
    approvalId: string,
    decision: ApprovalDecisionInput,
  ): Promise<void>;
  /** The live fleet (edge worker's view of all agents). */
  getFleet(): Promise<Agent[]>;
  /** Publish a frame onto the edge event bus. */
  ingestEvent(frame: CallaWsFrame): Promise<void>;
  /**
   * Transfer a live voice call to a human (B3) — DO RPC into the
   * CallaVoiceAgent instance named by the Telnyx stream id.
   */
  transferVoiceCall(
    callId: string,
    reason?: string,
  ): Promise<{ status: string; firstTime: boolean; spoken: string }>;
}

// ─── Helpers ─────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

// ─── Factory ─────────────────────────────────────────────────────

export function createEdgeClient(options: EdgeClientOptions = {}): EdgeClient {
  const base = (options.baseUrl ?? "").trim().replace(/\/+$/, "");

  const jsonInit = (body: unknown, headers?: Record<string, string>): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });

  return {
    async executeStep(agentName: string, step: CallaStep): Promise<StepResult> {
      const res = await authFetch(
        `${base}/steps/${encodeURIComponent(agentName)}`,
        jsonInit(step),
      );
      if (!res.ok) {
        throw new Error(`executeStep failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as StepResult;
    },

    async decideApproval(
      agentName: string,
      approvalId: string,
      decision: ApprovalDecisionInput,
    ): Promise<void> {
      const res = await authFetch(
        `${base}/approvals/${encodeURIComponent(agentName)}/${encodeURIComponent(approvalId)}/decision`,
        jsonInit({
          approved: decision.approved,
          ...(decision.updatedArgs ? { updatedArgs: decision.updatedArgs } : {}),
        }),
      );
      if (!res.ok) {
        throw new Error(`decideApproval failed: ${res.status} ${res.statusText}`);
      }
    },

    async getFleet(): Promise<Agent[]> {
      const res = await authFetch(`${base}/fleet`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) {
        throw new Error(`getFleet failed: ${res.status} ${res.statusText}`);
      }
      const data: unknown = await res.json();
      // Accept either a bare array or { agents: [...] }.
      if (Array.isArray(data)) return data as Agent[];
      const wrapped = asRecord(data).agents;
      return Array.isArray(wrapped) ? (wrapped as Agent[]) : [];
    },

    async ingestEvent(frame: CallaWsFrame): Promise<void> {
      const token = options.token !== undefined ? options.token : readStoredEdgeJwt();
      const headers: Record<string, string> = {};
      if (token) headers["x-calla-token"] = token;

      const res = await authFetch(`${base}/events/ingest`, jsonInit(frame, headers));
      if (!res.ok) {
        throw new Error(`ingestEvent failed: ${res.status} ${res.statusText}`);
      }
    },

    async transferVoiceCall(
      callId: string,
      reason?: string,
    ): Promise<{ status: string; firstTime: boolean; spoken: string }> {
      const res = await authFetch(
        `${base}/voice/${encodeURIComponent(callId)}/escalate`,
        jsonInit(reason ? { reason } : {}),
      );
      if (!res.ok) {
        throw new Error(`transferVoiceCall failed: ${res.status} ${res.statusText}`);
      }
      return (await res.json()) as { status: string; firstTime: boolean; spoken: string };
    },
  };
}

/** Default same-origin client. */
export const edgeClient: EdgeClient = createEdgeClient();
