/**
 * useApprovals — Unified HITL Approval State
 * ──────────────────────────────────────────
 * The core Calla differentiator: ONE inbox over every human-in-the-loop
 * gate in the system. Merges four approval sources into a single
 * ApprovalRequest[] list (@calla/shared) with one decide() entry point:
 *
 *   1. "data"       — data-plane review queues via useDataApi. LOW-VOLUME
 *                      per-item decisions only:
 *                      • reply drafts awaiting send (stage: sent, status: pending)
 *                      • flagged websites (website_status unreachable|timeout|
 *                        error — filtered CLIENT-SIDE, the engine silently
 *                        ignores website_status params)
 *                      Lead batches are deliberately NOT here — they're
 *                      bulk-reviewed in the Data section (/data).
 *                      decide() → useUpdateLead patch.
 *   2. "core"       — core VM tasks awaiting input (state: awaiting_input)
 *                      via useCoreDeployment. decide() → resumeTask.
 *   3. "cloudflare" — edge agent HITL gates. The DURABLE agent DO state
 *                      (`agentStates` → state.pendingApprovals, authoritative
 *                      status incl. decided gates) is the source of truth;
 *                      live/replayed calla:approval:* frames from
 *                      useCallaEvents are a push channel that may only add
 *                      ids the loaded snapshot lacks (they carry no status,
 *                      so replayed request frames must never resurrect a
 *                      decided gate after a refresh). decide() →
 *                      edge-client decideApproval.
 *   4. "mastra"     — brain suspended runs, polled every 5s via
 *                      mastra-client (plain useEffect+setInterval — works
 *                      WITHOUT a QueryClientProvider). decide() →
 *                      approve/declineToolCall.
 *
 * Optimistic updates: decide() flips the local status immediately and
 * rolls back (with an error toast) if the underlying call fails.
 * Live prepend: calla:approval:request frames arrive through the events
 * buffer the instant the edge publishes them — no wait for the next poll.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalSource,
  ApprovalStatus,
  PendingApproval,
  RiskLevel,
} from "@calla/shared";
import { AUTH_DISABLED } from "@/constants/auth";
import { CALLA_DEV_AGENTS } from "@/constants/agents";
import { useLeads, useUpdateLead, type DataFilters } from "@/hooks/useDataApi";
import { authFetch } from "@/hooks/useAuthFetch";
import { useCoreDeployment } from "@/hooks/useCoreDeployment";
import { useCallaEvents } from "@/hooks/useCallaEvents";
import { toast } from "@/hooks/useToast";
import { mastraClient } from "@/lib/mastra-client";
import { edgeClient } from "@/lib/edge-client";

// ─── Types ───────────────────────────────────────────────────────

export interface UseApprovalsOptions {
  /** Selected deployment for the data + core sources. */
  deploymentId?: string;
  /**
   * Live agent DO states keyed by agentId (e.g. from useAgentConnection's
   * agentState). When present, their pendingApprovals[] entries feed the
   * "cloudflare" source without waiting for event frames.
   */
  agentStates?: Record<string, Record<string, unknown> | null>;
  /** Brain agent ids polled for suspended runs (default: fleet brain agents). */
  brainAgentIds?: string[];
  /** Enable/disable the edge events WS feed (default true). */
  eventsEnabled?: boolean;
  /** Events WS URL override (default same-origin /events). */
  eventsUrl?: string;
  /** Page size for the reply-draft review queue (default 100). Flagged
   *  websites always use one broad 500-row fetch (engine pageSize cap). */
  dataPageSize?: number;
}

export interface ApprovalCounts {
  all: number;
  pending: number;
  /** Decided approvals (sent / discarded) — the read-only history view. */
  history: number;
  /** Pending approvals per source. */
  bySource: Record<ApprovalSource, number>;
  /** Pending approvals per risk level. */
  byRisk: Record<RiskLevel, number>;
}

export interface UseApprovalsResult {
  /** Merged approvals — pending first, then newest requestedAt first. */
  approvals: ApprovalRequest[];
  counts: ApprovalCounts;
  isLoading: boolean;
  error: string | null;
  /**
   * Decide one approval. Optimistic: local status flips immediately and
   * rolls back with an error toast on failure.
   *
   * Data-plane extras: pass updatedArgs.intent (or .action) as
   * "approve" | "reject" | "discard" | "confirm" to select the patch —
   * discard = reject + drop the reply draft, confirm = mark a flagged
   * website reachable. Approving a website row maps to "confirm".
   */
  decide: (id: string, decision: ApprovalDecision) => Promise<void>;
  /** Force-refresh every polled source (data, core, mastra). */
  refetch: () => void;
}

// ─── Constants ───────────────────────────────────────────────────

const MASTRA_POLL_INTERVAL_MS = 5_000;

/** How often the inbox re-polls the engine for pending reply drafts. */
const REPLY_DRAFT_POLL_MS = 15_000;

/** Engine cap for GET /cmd/data pageSize. */
const WEBSITE_POOL_PAGE_SIZE = 500;

/** website_status values that surface as review-website approvals. */
const FLAGGED_WEBSITE_STATUSES = new Set(["unreachable", "timeout", "error"]);

const EMPTY_COUNTS_BY_SOURCE: Record<ApprovalSource, number> = {
  mastra: 0,
  cloudflare: 0,
  core: 0,
  data: 0,
};

const EMPTY_COUNTS_BY_RISK: Record<RiskLevel, number> = {
  low: 0,
  medium: 0,
  high: 0,
  critical: 0,
};

const RISK_LEVELS: RiskLevel[] = ["low", "medium", "high", "critical"];

const DEFAULT_BRAIN_AGENT_IDS = CALLA_DEV_AGENTS.filter((a) => a.runtime === "brain").map(
  (a) => a.id,
);

// ─── Helpers ─────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asRisk(value: unknown, fallback: RiskLevel): RiskLevel {
  return typeof value === "string" && (RISK_LEVELS as string[]).includes(value)
    ? (value as RiskLevel)
    : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rowTimestamp(row: Record<string, unknown>): string {
  for (const key of ["updated_at", "updatedAt", "created_at", "createdAt", "at"]) {
    const v = str(row[key]);
    if (v) return v;
  }
  return new Date().toISOString();
}

function rowSummary(row: Record<string, unknown>, fallback: string): string {
  return str(row.company) ?? str(row.name) ?? str(row.company_name) ?? str(row.title) ?? fallback;
}

/** Normalize one data-plane row into an ApprovalRequest (replies + websites only). */
function rowToApproval(
  row: Record<string, unknown>,
  opts: {
    toolName: "review-reply" | "review-website";
    risk: RiskLevel;
    deploymentId?: string;
  },
): ApprovalRequest | null {
  const rowKey = str(row.key) ?? str(row.id);
  if (!rowKey) return null;

  const base = {
    id: `data:${opts.toolName}:${rowKey}`,
    source: "data" as const,
    agentId: opts.deploymentId ?? "data-plane",
    rowKey,
    toolName: opts.toolName,
    arguments: row,
    risk: opts.risk,
    requestedAt: rowTimestamp(row),
    expiresAt: null,
    status: "pending" as const,
    ...(opts.deploymentId ? { deploymentId: opts.deploymentId } : {}),
  };

  switch (opts.toolName) {
    case "review-reply": {
      const from = str(row.reply_from);
      const intent = str(row.intent);
      const isDm = str(row.channel) === "manychat";
      const who = from ? `from ${from}` : "reply draft";
      return {
        ...base,
        summary: `${isDm ? "DM " : ""}Reply ${who}${intent ? ` (${intent})` : ""} — ${rowSummary(row, rowKey)}: ${str(row.draft) ? `“${str(row.draft)!.slice(0, 120)}${(str(row.draft)!.length ?? 0) > 120 ? "…" : ""}”` : "(no draft text)"}`,
      };
    }
    case "review-website":
      return {
        ...base,
        summary: `Website flagged ${str(row.website_status) ?? "unreachable"}: ${rowSummary(row, rowKey)}`,
      };
  }
}

/** Normalize an edge PendingApproval (DO state) into an ApprovalRequest. */
function pendingApprovalToApproval(
  p: PendingApproval,
  agentId: string,
  deploymentId?: string,
): ApprovalRequest {
  return {
    id: `cloudflare:${p.id}`,
    source: "cloudflare",
    agentId,
    approvalId: p.id,
    toolName: p.step?.action ?? "edge-step",
    arguments: (p.step?.params ?? {}) as Record<string, unknown>,
    risk: asRisk(p.risk ?? p.step?.risk, "medium"),
    summary: `Edge step "${p.step?.action ?? p.id}" awaiting approval`,
    requestedAt: new Date(p.requestedAt ?? Date.now()).toISOString(),
    expiresAt:
      p.step?.timeoutMs && p.requestedAt
        ? new Date(p.requestedAt + p.step.timeoutMs).toISOString()
        : null,
    status: p.status === "pending" ? "pending" : ((p.status ?? "pending") as ApprovalStatus),
    ...(deploymentId ? { deploymentId } : {}),
  };
}

/** Normalize a calla:approval:request frame payload (ApprovalRequest or PendingApproval shape). */
function eventPayloadToApproval(
  payload: Record<string, unknown>,
  agentId: string,
  deploymentId?: string,
): ApprovalRequest | null {
  const approvalId = str(payload.id) ?? str(payload.approvalId);
  if (!approvalId) return null;

  // The edge publishes full ApprovalRequest entities when it can.
  if (payload.source === "cloudflare" || str(payload.toolName)) {
    return {
      id: str(payload.id) && String(payload.id).startsWith("cloudflare:")
        ? (payload.id as string)
        : `cloudflare:${approvalId}`,
      source: "cloudflare",
      agentId: str(payload.agentId) ?? agentId,
      approvalId: str(payload.approvalId) ?? approvalId,
      runId: str(payload.runId),
      toolCallId: str(payload.toolCallId),
      rowKey: str(payload.rowKey),
      taskId: str(payload.taskId),
      toolName: str(payload.toolName) ?? "edge-step",
      arguments: asRecord(payload.arguments),
      risk: asRisk(payload.risk, "medium"),
      summary: str(payload.summary) ?? `Edge approval "${str(payload.toolName) ?? approvalId}"`,
      requestedAt: str(payload.requestedAt) ?? new Date().toISOString(),
      expiresAt: str(payload.expiresAt) ?? null,
      status: "pending",
      ...(deploymentId ? { deploymentId } : {}),
    };
  }

  // Fallback: PendingApproval DO shape.
  const step = asRecord(payload.step);
  return {
    id: `cloudflare:${approvalId}`,
    source: "cloudflare",
    agentId,
    approvalId,
    toolName: str(step.action) ?? "edge-step",
    arguments: asRecord(step.params),
    risk: asRisk(payload.risk ?? step.risk, "medium"),
    summary: `Edge step "${str(step.action) ?? approvalId}" awaiting approval`,
    requestedAt:
      typeof payload.requestedAt === "number"
        ? new Date(payload.requestedAt).toISOString()
        : new Date().toISOString(),
    expiresAt: null,
    status: "pending",
    ...(deploymentId ? { deploymentId } : {}),
  };
}

/** Dedupe identity for the merged list (see baseApprovals). */
function dedupeKeyFor(a: ApprovalRequest): string {
  if (a.rowKey) return `${a.source}:row:${a.rowKey}`;
  if (a.runId && a.toolCallId) return `${a.source}:run:${a.runId}:${a.toolCallId}`;
  if (a.approvalId) return `${a.source}:approval:${a.approvalId}`;
  return a.id;
}

/** Map a decision to the data-plane patch (see useUpdateLead). */
function dataPatchFor(
  approval: ApprovalRequest,
  decision: ApprovalDecision,
): Record<string, unknown> {
  const raw = str(decision.updatedArgs?.intent) ?? str(decision.updatedArgs?.action);
  let intent: "approve" | "reject" | "discard" | "confirm" =
    raw === "approve" || raw === "reject" || raw === "discard" || raw === "confirm"
      ? raw
      : decision.approved
        ? "approve"
        : "reject";
  // Approving a flagged website means "confirmed reachable".
  if (approval.toolName === "review-website" && intent === "approve") {
    intent = "confirm";
  }

  switch (intent) {
    case "approve":
      return { status: "approved" };
    case "reject":
      return { status: "rejected" };
    case "discard":
      return { status: "rejected", reply_draft: null };
    case "confirm":
      return { website_status: "confirmed" };
  }
}

// ─── Hook ────────────────────────────────────────────────────────

export function useApprovals(options: UseApprovalsOptions = {}): UseApprovalsResult {
  const {
    deploymentId,
    agentStates,
    eventsEnabled = true,
    eventsUrl,
    dataPageSize = 100,
  } = options;

  const brainAgentIds = options.brainAgentIds ?? DEFAULT_BRAIN_AGENT_IDS;
  const brainAgentIdsKey = brainAgentIds.join(",");

  const [refreshKey, setRefreshKey] = useState(0);
  /** Optimistic status overrides, keyed by ApprovalRequest.id. */
  const [overrides, setOverrides] = useState<Map<string, ApprovalStatus>>(() => new Map());

  // ─── Source 1: data plane (reply drafts + flagged websites) ───
  // Lead batches live in the Data section (/data) with bulk approval —
  // the inbox only carries these low-volume per-item decisions.
  //
  // Reply drafts come from the engine's replies_log (GET /cmd/replies?
  // status=pending) — the ACTUAL drafted replies, not leads. Approving one
  // runs /send-reply (sends it via Brevo, honours dryRun); rejecting runs
  // /discard-reply. Both go through /cmd/supervisor below in decide().
  //
  // The engine silently ignores website_status params, so fetch a broad
  // page and flag websites client-side (phantom-approvals fix). Filter
  // objects are re-created on refreshKey so useLeads' effect re-fires.
  // Engine constraint: GET /cmd/data supports ONLY single-value exact
  // filters — keep every array facet to ONE value.

  const websitePoolFilters = useMemo<DataFilters>(() => ({}), [refreshKey]);

  const websitePool = useLeads(websitePoolFilters, 1, WEBSITE_POOL_PAGE_SIZE, deploymentId);
  const { update: updateRow } = useUpdateLead(deploymentId);

  // ── Reply drafts (replies_log) — polled, independent of the leads fetch ──
  const [replyDrafts, setReplyDrafts] = useState<Record<string, unknown>[]>([]);
  const fetchReplyDrafts = useCallback(async () => {
    if (!deploymentId) {
      setReplyDrafts([]);
      return;
    }
    try {
      const res = await authFetch(`/d/${deploymentId}/cmd/replies?status=pending`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return; // keep last known list on transient errors
      const json = (await res.json()) as { replies?: Record<string, unknown>[] };
      // rowToApproval resolves rowKey via str(row.key) — normalise the
      // numeric replies_log id into a string key.
      setReplyDrafts((json.replies ?? []).map((r) => ({ ...r, key: String(r.id) })));
    } catch {
      // network down — keep last known list, surface nothing (best effort)
    }
  }, [deploymentId]);

  // ── Reply history (sent + discarded drafts — read-only audit view) ──
  const [replyHistory, setReplyHistory] = useState<Record<string, unknown>[]>([]);
  const fetchReplyHistory = useCallback(async () => {
    if (!deploymentId) {
      setReplyHistory([]);
      return;
    }
    try {
      const res = await authFetch(`/d/${deploymentId}/cmd/replies?status=resolved&limit=50`, {
        headers: { Accept: "application/json" },
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as { replies?: Record<string, unknown>[] };
      setReplyHistory((json.replies ?? []).map((r) => ({ ...r, key: String(r.id) })));
    } catch {
      // best effort — history is a nice-to-have
    }
  }, [deploymentId]);

  useEffect(() => {
    fetchReplyDrafts();
    fetchReplyHistory();
    const interval = setInterval(fetchReplyDrafts, REPLY_DRAFT_POLL_MS);
    const historyInterval = setInterval(fetchReplyHistory, REPLY_DRAFT_POLL_MS * 2);
    return () => {
      clearInterval(interval);
      clearInterval(historyInterval);
    };
  }, [fetchReplyDrafts, fetchReplyHistory, refreshKey]);

  const dataApprovals = useMemo<ApprovalRequest[]>(() => {
    const out: ApprovalRequest[] = [];
    for (const row of replyDrafts) {
      const a = rowToApproval(row, { toolName: "review-reply", risk: "high", deploymentId });
      if (a) out.push(a);
    }
    for (const row of websitePool.data.rows) {
      const ws = str(row.website_status)?.toLowerCase();
      if (!ws || !FLAGGED_WEBSITE_STATUSES.has(ws)) continue;
      // Leads that are already decided must not keep re-appearing: the
      // website flag is sticky, but a rejected/archived/opted-out lead is
      // out of scope for review.
      const st = str(row.status)?.toLowerCase();
      const stage = str(row.stage)?.toLowerCase();
      if (st === "rejected" || st === "opted_out" || st === "archived") continue;
      if (stage === "archived" || stage === "opted_out") continue;
      const a = rowToApproval(row, { toolName: "review-website", risk: "low", deploymentId });
      if (a) out.push(a);
    }
    return out;
  }, [replyDrafts, websitePool.data.rows, deploymentId]);

  // Decided reply drafts (sent / discarded) — read-only history entries.
  const historyApprovals = useMemo<ApprovalRequest[]>(() => {
    const out: ApprovalRequest[] = [];
    for (const row of replyHistory) {
      const key = String(row.id);
      const sent = row.draft_status === "sent";
      const from = str(row.reply_from);
      const leadName = str(row.lead_name);
      const draft = str(row.draft);
      const snippet = draft
        ? `“${draft.slice(0, 120)}${draft.length > 120 ? "…" : ""}”`
        : "(no draft text)";
      out.push({
        id: `data:reply-history:${key}`,
        source: "data",
        agentId: deploymentId ?? "data-plane",
        rowKey: key,
        toolName: "review-reply",
        arguments: row,
        risk: "high",
        requestedAt: rowTimestamp(row),
        expiresAt: null,
        status: sent ? "approved" : "declined",
        summary: `${sent ? "Sent" : "Discarded"} reply${from ? ` from ${from}` : ""}${leadName ? ` — ${leadName}` : ""}: ${snippet}`,
        ...(deploymentId ? { deploymentId } : {}),
      });
    }
    return out;
  }, [replyHistory, deploymentId]);

  const dataError = websitePool.error;
  const dataLoading = deploymentId ? websitePool.loading : false;

  // ─── Source 2: core VM tasks ──────────────────────────────────

  const coreEnabled = !AUTH_DISABLED && !!deploymentId;
  const coreDeploymentId = coreEnabled && deploymentId ? deploymentId : "";
  const core = useCoreDeployment(coreDeploymentId);

  const coreApprovals = useMemo<ApprovalRequest[]>(() => {
    if (!coreEnabled) return [];
    return core.tasks
      .filter((t) => t.state === "awaiting_input")
      .map((t) => ({
        id: `core:${t.id}`,
        source: "core" as const,
        agentId: deploymentId ?? "core",
        taskId: t.id,
        toolName: "core-task",
        arguments: {
          taskType: t.taskType,
          ...(t.outputTail ? { outputTail: t.outputTail } : {}),
        },
        risk: "medium" as const,
        summary: `Core task "${t.taskType}" awaiting input`,
        requestedAt: t.updatedAt ?? t.startedAt ?? new Date().toISOString(),
        expiresAt: null,
        status: "pending" as const,
        ...(deploymentId ? { deploymentId } : {}),
      }));
  }, [core.tasks, coreEnabled, deploymentId]);

  const coreError = coreEnabled ? core.error : null;
  const coreLoading = coreEnabled ? core.loading : false;

  // ─── Source 3: cloudflare edge ────────────────────────────────

  const callaEvents = useCallaEvents({ enabled: eventsEnabled, url: eventsUrl });

  /** approvalId → resolved status, from calla:approval:resolved frames. */
  const resolvedByFrame = useMemo(() => {
    const map = new Map<string, ApprovalStatus>();
    for (const evt of callaEvents.events) {
      if (evt.type !== "approval_resolved") continue;
      const payload = asRecord(evt.payload);
      const id = str(payload.id) ?? str(payload.approvalId);
      const status = str(payload.status);
      if (!id) continue;
      map.set(
        id,
        status === "approved" || status === "declined" || status === "expired"
          ? status
          : status === "rejected"
            ? "declined"
            : "expired",
      );
    }
    return map;
  }, [callaEvents.events]);

  const cloudflareApprovals = useMemo<ApprovalRequest[]>(() => {
    const byKey = new Map<string, ApprovalRequest>();
    const stateLoadedFor = new Set<string>();

    // (a) Durable DO state — the SOURCE OF TRUTH for every agent whose
    //     snapshot loaded: pendingApprovals carries the authoritative status
    //     (decided gates keep their terminal status), so a decided gate can
    //     never resurrect from a replayed request frame after a refresh.
    if (agentStates) {
      for (const [agentId, state] of Object.entries(agentStates)) {
        stateLoadedFor.add(agentId);
        const pending = state?.pendingApprovals;
        if (!Array.isArray(pending)) continue;
        for (const item of pending) {
          const p = asRecord(item) as unknown as PendingApproval;
          if (!p?.id) continue;
          byKey.set(p.id, pendingApprovalToApproval(p, agentId, deploymentId));
        }
      }
    }

    // (b) Live/replayed calla:approval:request frames — the push channel.
    //     They carry no status of their own ("pending" by construction).
    //     For an agent whose state snapshot loaded, a frame may only add an
    //     id the snapshot lacks (fresh gate requested after the snapshot was
    //     taken — the next poll folds it in with its real status). For agents
    //     without a loaded snapshot, frames remain the best-effort source.
    for (const evt of callaEvents.events) {
      if (evt.type !== "approval_request") continue;
      const a = eventPayloadToApproval(asRecord(evt.payload), evt.agentId, deploymentId);
      if (!a) continue;
      const key = a.approvalId ?? a.id;
      if (byKey.has(key)) continue;
      if (stateLoadedFor.size > 0 && a.agentId && stateLoadedFor.has(a.agentId)) continue;
      byKey.set(key, a);
    }

    // (c) Resolved frames pin terminal statuses (covers agents whose state
    //     fetch failed and the decision happened in this session).
    for (const a of byKey.values()) {
      const key = a.approvalId ?? a.id;
      const resolved = resolvedByFrame.get(key);
      if (resolved) a.status = resolved;
    }

    return Array.from(byKey.values());
  }, [callaEvents.events, agentStates, deploymentId, resolvedByFrame]);

  const eventsError = callaEvents.status === "error" ? "Event feed disconnected" : null;

  // ─── Source 4: mastra brain ───────────────────────────────────
  // Plain useEffect + setInterval — deliberately NOT react-query so the
  // hook works without a QueryClientProvider in the tree.

  const mastraEnabled = mastraClient.enabled && brainAgentIds.length > 0;
  const [mastraApprovals, setMastraApprovals] = useState<ApprovalRequest[]>([]);
  const [mastraLoading, setMastraLoading] = useState(mastraEnabled);
  const [mastraError, setMastraError] = useState<string | null>(null);

  useEffect(() => {
    if (!mastraEnabled) {
      setMastraApprovals([]);
      setMastraLoading(false);
      return;
    }
    let cancelled = false;

    const fetchAll = async () => {
      try {
        const results = await Promise.all(
          brainAgentIds.map((agentId) => mastraClient.listSuspendedRuns(agentId)),
        );
        if (cancelled) return;
        setMastraApprovals(results.flat());
        setMastraError(null);
      } catch (err) {
        if (cancelled) return;
        setMastraError(err instanceof Error ? err.message : "Failed to poll brain approvals");
      } finally {
        if (!cancelled) setMastraLoading(false);
      }
    };

    fetchAll();
    const interval = setInterval(fetchAll, MASTRA_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mastraEnabled, brainAgentIdsKey, refreshKey]);

  // ─── Merge ─────────────────────────────────────────────────────

  /** Deduped source-of-truth list (no optimistic overrides applied). */
  const baseApprovals = useMemo<ApprovalRequest[]>(() => {
    const all = [
      ...dataApprovals,
      ...historyApprovals,
      ...coreApprovals,
      ...cloudflareApprovals,
      ...mastraApprovals,
    ];

    // Map-based dedupe — never emit two approvals for the same underlying
    // entity: source+rowKey (data rows), source+runId+toolCallId (brain),
    // source+approvalId (edge), falling back to the id itself.
    const seen = new Map<string, ApprovalRequest>();
    for (const a of all) {
      const key = dedupeKeyFor(a);
      if (!seen.has(key)) seen.set(key, a);
    }
    return Array.from(seen.values());
  }, [dataApprovals, historyApprovals, coreApprovals, cloudflareApprovals, mastraApprovals]);

  const merged = useMemo<ApprovalRequest[]>(() => {
    // Apply optimistic overrides non-mutatively, and only while the source
    // still reports "pending" — once the backend catches up, its status wins.
    const withOverrides = baseApprovals.map((a) => {
      const override = overrides.get(a.id);
      return override && a.status === "pending" ? { ...a, status: override } : a;
    });

    // Pending first, then newest requestedAt first.
    return withOverrides.sort((a, b) => {
      const ap = a.status === "pending" ? 0 : 1;
      const bp = b.status === "pending" ? 0 : 1;
      if (ap !== bp) return ap - bp;
      return new Date(b.requestedAt).getTime() - new Date(a.requestedAt).getTime();
    });
  }, [baseApprovals, overrides]);

  // Drop overrides once the source of truth catches up (row resolved or gone).
  useEffect(() => {
    if (overrides.size === 0) return;
    setOverrides((prev) => {
      let changed = false;
      const next = new Map(prev);
      for (const id of prev.keys()) {
        const base = baseApprovals.find((a) => a.id === id);
        if (!base || base.status !== "pending") {
          next.delete(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [baseApprovals, overrides]);

  const counts = useMemo<ApprovalCounts>(() => {
    const bySource: Record<ApprovalSource, number> = { ...EMPTY_COUNTS_BY_SOURCE };
    const byRisk: Record<RiskLevel, number> = { ...EMPTY_COUNTS_BY_RISK };
    let pending = 0;
    let history = 0;
    for (const a of merged) {
      if (a.status !== "pending") {
        history += 1;
        continue;
      }
      pending += 1;
      bySource[a.source] += 1;
      byRisk[a.risk] += 1;
    }
    return { all: merged.length, pending, history, bySource, byRisk };
  }, [merged]);

  // ─── decide ────────────────────────────────────────────────────

  const mergedRef = useRef(merged);
  mergedRef.current = merged;

  // Stable action handles (the wrapper objects re-create every render).
  const coreResumeTask = core.resumeTask;
  const coreRefetch = core.refetch;
  const websitePoolRefetch = websitePool.refetch;

  /** Approve/reject a reply draft via the engine supervisor (G3). */
  const decideReplyDraft = useCallback(
    async (draftId: string, approve: boolean): Promise<void> => {
      if (!deploymentId) throw new Error("No deployment selected");
      const cmd = approve ? "/send-reply" : "/discard-reply";
      const res = await authFetch(`/d/${deploymentId}/cmd/supervisor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: `${cmd} ${draftId}` }),
        signal: AbortSignal.timeout(30000),
      });
      const json = (await res.json()) as { reply?: string; error?: string };
      if (!res.ok) throw new Error(json.error ?? `${res.status} ${res.statusText}`.trim());
      const detail = json.reply ?? "";
      if (approve) {
        const failed = detail.startsWith("Reply") && /not found|no draft|opted out|rejected|paused|sendEnabled is false|Daily cap|failed to send/i.test(detail);
        if (failed) throw new Error(detail);
        toast.success("Reply draft approved", detail);
      } else {
        toast.success("Reply draft discarded", detail);
      }
    },
    [deploymentId],
  );

  const decide = useCallback(
    async (id: string, decision: ApprovalDecision): Promise<void> => {
      const approval = mergedRef.current.find((a) => a.id === id);
      if (!approval || approval.status !== "pending") return;

      // Optimistic flip.
      const optimistic: ApprovalStatus = decision.approved ? "approved" : "declined";
      setOverrides((prev) => new Map(prev).set(id, optimistic));

      try {
        switch (approval.source) {
          case "data": {
            if (!approval.rowKey) throw new Error("Missing data row key");
            if (approval.toolName === "review-reply") {
              // Approving a reply draft SENDS it (G3); rejecting discards it.
              await decideReplyDraft(approval.rowKey, decision.approved);
            } else {
              const ok = await updateRow(approval.rowKey, dataPatchFor(approval, decision));
              if (!ok) throw new Error("Data-plane update failed");
            }
            break;
          }
          case "core": {
            if (!approval.taskId) throw new Error("Missing core task id");
            const ok = await coreResumeTask(approval.taskId, {
              action: decision.approved ? "approve" : "reject",
              input: decision.input,
            });
            if (!ok) throw new Error("Core task resume failed");
            break;
          }
          case "cloudflare": {
            if (!approval.approvalId) throw new Error("Missing edge approval id");
            await edgeClient.decideApproval(approval.agentId, approval.approvalId, {
              approved: decision.approved,
              updatedArgs: decision.updatedArgs,
            });
            break;
          }
          case "mastra": {
            if (!approval.runId || !approval.toolCallId) {
              throw new Error("Missing brain run/tool-call id");
            }
            const input = {
              runId: approval.runId,
              toolCallId: approval.toolCallId,
              updatedArgs: decision.updatedArgs,
            };
            if (decision.approved) {
              await mastraClient.approveToolCall(approval.agentId, input);
            } else {
              await mastraClient.declineToolCall(approval.agentId, input);
            }
            break;
          }
        }

        // Success — keep the optimistic status; the source refresh confirms it.
        if (approval.source === "mastra") {
          setRefreshKey((k) => k + 1);
        }
        if (approval.source === "data" && approval.toolName === "review-reply") {
          // Draft left the pending set (sent/discarded) — pull it now.
          fetchReplyDrafts();
          fetchReplyHistory();
        }
      } catch (err) {
        // Roll back + surface.
        setOverrides((prev) => {
          const next = new Map(prev);
          next.delete(id);
          return next;
        });
        toast.error(
          "Approval decision failed",
          err instanceof Error ? err.message : "Unknown error",
        );
      }
    },
    [updateRow, coreResumeTask, decideReplyDraft, fetchReplyDrafts, fetchReplyHistory],
  );

  // ─── refetch ───────────────────────────────────────────────────

  const refetch = useCallback(() => {
    // Bumping refreshKey re-creates the data-plane filter identities, which
    // re-fires useLeads' effects; the extra refetch() calls clear stale errors.
    setRefreshKey((k) => k + 1);
    fetchReplyDrafts();
    websitePoolRefetch();
    if (coreEnabled) coreRefetch();
  }, [fetchReplyDrafts, websitePoolRefetch, coreRefetch, coreEnabled]);

  const error = dataError ?? coreError ?? mastraError ?? eventsError;
  const isLoading = dataLoading || coreLoading || (mastraEnabled ? mastraLoading : false);

  return { approvals: merged, counts, isLoading, error, decide, refetch };
}
