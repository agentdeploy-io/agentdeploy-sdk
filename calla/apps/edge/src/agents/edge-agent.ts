import { Agent, callable } from "agents";
import type { DynamicAgentClass, DynamicAgentStub } from "agents";
import {
  CALLA_EVENTS,
  INITIAL_CALLA_STATE,
  callaFrame,
  type ApprovalRequest,
  type ApprovalStatus,
  type CallaState,
  type CallaStep,
  type CallaWsFrame,
  type CompletedStep,
  type PendingApproval,
  type RiskLevel,
  type StepResult,
} from "@calla/shared";
import type { Env } from "../env";
import { bookAppointment, brainConfigFromEnv } from "./brain-client";
import type { AuditKind } from "./event-hub";

/** Shape returned by the placeholder sandbox runner. */
export interface SandboxOutput {
  echo: string;
  params: Record<string, unknown>;
  ranAt: number;
}

/** Result of the workflow-driven expiry check. */
export interface ExpiryResult {
  approvalId: string;
  expired: boolean;
  status: ApprovalStatus | "not_found";
}

const DEFAULT_TIMEOUT_MS = 86_400_000; // 24h
const HUB_NAME = "hub";

/** Deterministic JSON (recursively key-sorted) for step-param identity. */
function canonicalParams(value: unknown): string {
  const canonicalize = (v: unknown): unknown =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(
          Object.keys(v as Record<string, unknown>)
            .sort()
            .map((k) => [k, canonicalize((v as Record<string, unknown>)[k])]),
        )
      : Array.isArray(v)
        ? v.map(canonicalize)
        : v;
  return JSON.stringify(canonicalize(value));
}

/**
 * CallaEdgeAgent — one Durable Object per edge agent identity.
 *
 * Owns the HITL gate for cheap, isolated step tasks. Extends the Agents SDK
 * `Agent`, so `setState()` transparently broadcasts CallaState to any UI
 * connected over the Agents WebSocket protocol (`/agents/calla-edge-agent/:name`).
 * Every gate transition and completed sandbox run is also appended to the hub's
 * hash-chained audit log (best-effort; see `appendAudit`).
 *
 * RPC surface (all `@callable`, reachable over WS-RPC *and* native DO RPC):
 *  - executeStep(step)                          → StepResult
 *  - approvePendingAction({approvalId,updatedArgs?}) → StepResult
 *  - declinePendingAction({approvalId})         → StepResult
 *  - getState()                                 → CallaState
 *  - expireApprovalIfPending({approvalId})      → ExpiryResult   (called by the workflow)
 */
export class CallaEdgeAgent extends Agent<Env, CallaState> {
  initialState: CallaState = INITIAL_CALLA_STATE;

  // ── Public RPC ───────────────────────────────────────────────────────────

  /**
   * Execute a step. If it requires approval, open a HITL gate and return
   * `awaiting_approval`; otherwise run it immediately in the sandbox.
   */
  @callable()
  async executeStep(step: CallaStep): Promise<StepResult> {
    if (step.requiresApproval) {
      return this.requestApproval(step);
    }
    try {
      const output = await this.runInSandbox(step);
      await this.recordCompleted(step, output);
      return { status: "completed", stepId: step.id, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, status: "error" });
      await this.publishFrame(
        callaFrame(
          CALLA_EVENTS.error,
          { stepId: step.id, error: message },
          { agentId: this.name },
        ),
      );
      return { status: "failed", stepId: step.id, error: message };
    }
  }

  /** Approve a pending gate (optionally with edited arguments) and run it. */
  @callable()
  async approvePendingAction(input: {
    approvalId: string;
    updatedArgs?: Record<string, unknown>;
  }): Promise<StepResult> {
    return this.resolveApproval(input.approvalId, "approved", input.updatedArgs);
  }

  /** Decline a pending gate. */
  @callable()
  async declinePendingAction(input: { approvalId: string }): Promise<StepResult> {
    return this.resolveApproval(input.approvalId, "declined");
  }

  /** Current CallaState (also streamed live via setState broadcasts). */
  @callable()
  async getState(): Promise<CallaState> {
    return this.state;
  }

  /**
   * Invoked by CallaApprovalWorkflow after the approval window elapses.
   * If the gate is still pending it is marked `expired` and a resolution frame
   * is published; otherwise it is a no-op (the human already decided).
   */
  @callable()
  async expireApprovalIfPending(input: { approvalId: string }): Promise<ExpiryResult> {
    const { approvalId } = input;
    const state = this.state;
    const approval = state.pendingApprovals.find((a) => a.id === approvalId);

    if (!approval) {
      return { approvalId, expired: false, status: "not_found" };
    }
    if (approval.status !== "pending") {
      return { approvalId, expired: false, status: approval.status };
    }

    const pendingApprovals = state.pendingApprovals.map((a) =>
      a.id === approvalId
        ? { ...a, status: "expired" as ApprovalStatus, decidedAt: Date.now() }
        : a,
    );
    const stillPending = pendingApprovals.some((a) => a.status === "pending");
    this.setState({
      ...state,
      status: stillPending ? "awaiting_approval" : "idle",
      currentTask: stillPending ? state.currentTask : null,
      pendingApprovals,
    });

    await this.publishFrame(
      callaFrame(
        CALLA_EVENTS.approvalResolved,
        { id: approvalId, status: "expired", stepId: approval.step.id },
        { agentId: this.name },
      ),
    );
    await this.appendAudit("approval.expired", {
      approvalId,
      stepId: approval.step.id,
      action: approval.step.action,
      requestedAt: approval.requestedAt,
    });

    return { approvalId, expired: true, status: "expired" };
  }

  /**
   * Sub-agent dispatch for parallel work (spec §3.1). `subAgent()` opens a
   * co-located child DO with isolated storage and returns a typed RPC stub.
   */
  async delegateToSubAgent<R>(
    agentClass: DynamicAgentClass<CallaEdgeAgent>,
    name: string,
    work: (agent: DynamicAgentStub<CallaEdgeAgent>) => Promise<R>,
  ): Promise<R> {
    const child = await this.subAgent(agentClass, name);
    return work(child);
  }

  // ── HITL internals ─────────────────────────────────────────────────────────

  /**
   * Two steps gate the same work when they share an id, or an action with
   * canonically-equal params — re-running such a step while its gate is still
   * PENDING must return the existing gate, not open a duplicate (a declined
   * gate is terminal, so a later re-run correctly opens a fresh one).
   */
  private sameGatedStep(a: CallaStep, b: CallaStep): boolean {
    if (a.id && a.id === b.id) return true;
    return a.action === b.action && canonicalParams(a.params) === canonicalParams(b.params);
  }

  private async requestApproval(step: CallaStep): Promise<StepResult> {
    const existing = this.state.pendingApprovals.find(
      (a) => a.status === "pending" && this.sameGatedStep(a.step, step),
    );
    if (existing) {
      return { status: "awaiting_approval", stepId: step.id, approvalId: existing.id };
    }

    const timeoutMs = step.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const approval: PendingApproval = {
      id: crypto.randomUUID(),
      step,
      requestedAt: Date.now(),
      risk: (step.risk ?? "medium") as RiskLevel,
      status: "pending",
    };

    this.setState({
      ...this.state,
      status: "awaiting_approval",
      currentTask: step.action,
      pendingApprovals: [...this.state.pendingApprovals, approval],
    });

    // Surface the gate on the event bus so the unified Approval Inbox sees it.
    await this.publishFrame(
      callaFrame(
        CALLA_EVENTS.approvalRequest,
        this.toApprovalRequest(approval, timeoutMs),
        { agentId: this.name },
      ),
    );

    await this.appendAudit("approval.requested", {
      approvalId: approval.id,
      step: { id: step.id, action: step.action },
      risk: approval.risk,
      timeoutMs,
    });

    // Arm the durable expiry timer. Workflows may be unavailable in local dev,
    // so this is best-effort — the gate still works, it just never auto-expires.
    try {
      await this.env.CALLA_APPROVAL_WORKFLOW.create({
        id: `approval-${approval.id}`,
        params: {
          agentName: this.name,
          approvalId: approval.id,
          timeoutMs,
        },
      });
    } catch (err) {
      console.error("[calla] approval workflow unavailable (continuing):", err);
    }

    return { status: "awaiting_approval", stepId: step.id, approvalId: approval.id };
  }

  private async resolveApproval(
    approvalId: string,
    decision: "approved" | "declined",
    updatedArgs?: Record<string, unknown>,
  ): Promise<StepResult> {
    const state = this.state;
    const approval = state.pendingApprovals.find((a) => a.id === approvalId);

    if (!approval) {
      return { status: "failed", stepId: approvalId, error: "unknown_approval" };
    }
    if (approval.status !== "pending") {
      // Idempotent replay of an already-resolved gate.
      if (approval.status === "approved") {
        return {
          status: "completed",
          stepId: approval.step.id,
          output: { note: "already_approved" },
        };
      }
      if (approval.status === "declined") {
        return { status: "declined", stepId: approval.step.id, approvalId };
      }
      return { status: "expired", stepId: approval.step.id, approvalId };
    }

    const decidedAt = Date.now();
    const pendingApprovals = state.pendingApprovals.map((a) =>
      a.id === approvalId ? { ...a, status: decision as ApprovalStatus, decidedAt } : a,
    );
    const stillPending = pendingApprovals.some((a) => a.status === "pending");

    if (decision === "declined") {
      this.setState({
        ...state,
        status: stillPending ? "awaiting_approval" : "idle",
        currentTask: stillPending ? state.currentTask : null,
        pendingApprovals,
      });
      await this.publishFrame(
        callaFrame(
          CALLA_EVENTS.approvalResolved,
          { id: approvalId, status: "declined", stepId: approval.step.id },
          { agentId: this.name },
        ),
      );
      await this.appendAudit("approval.decided", {
        approvalId,
        approved: false,
        stepId: approval.step.id,
        action: approval.step.action,
      });
      return { status: "declined", stepId: approval.step.id, approvalId };
    }

    // Approved — flip to running, announce resolution, then execute.
    this.setState({
      ...state,
      status: stillPending ? "awaiting_approval" : "running",
      currentTask: approval.step.action,
      pendingApprovals,
    });
    await this.publishFrame(
      callaFrame(
        CALLA_EVENTS.approvalResolved,
        { id: approvalId, status: "approved", stepId: approval.step.id },
        { agentId: this.name },
      ),
    );
    await this.appendAudit("approval.decided", {
      approvalId,
      approved: true,
      stepId: approval.step.id,
      action: approval.step.action,
      updatedArgs: updatedArgs ?? null,
    });

    const stepToRun: CallaStep = updatedArgs
      ? { ...approval.step, params: { ...approval.step.params, ...updatedArgs } }
      : approval.step;

    try {
      const output = await this.runInSandbox(stepToRun);
      await this.recordCompleted(stepToRun, output, approvalId);
      if (!this.state.pendingApprovals.some((a) => a.status === "pending")) {
        this.setState({ ...this.state, status: "idle", currentTask: null });
      }
      return { status: "completed", stepId: stepToRun.id, output };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.setState({ ...this.state, status: "error" });
      await this.publishFrame(
        callaFrame(
          CALLA_EVENTS.error,
          { stepId: stepToRun.id, error: message },
          { agentId: this.name },
        ),
      );
      return { status: "failed", stepId: stepToRun.id, error: message };
    }
  }

  /**
   * SANDBOX INTEGRATION POINT.
   *
   * Dispatches into real integrations keyed off `step.action`; anything
   * unknown still gets the deterministic echo so the full HITL loop (gate →
   * approve → execute → record) stays testable end-to-end.
   *
   *  - "voice.book_appointment" (B2): the voice DO opened this gate for a
   *    risky booking; after human approval the brain's booking REST is
   *    called for real (POST /booking/appointments).
   */
  private async runInSandbox(step: CallaStep): Promise<SandboxOutput | Record<string, unknown>> {
    if (step.action === "voice.book_appointment") {
      return await this.runVoiceBooking(step);
    }
    return { echo: step.action, params: step.params, ranAt: Date.now() };
  }

  /**
   * Post-approval voice booking dispatch (B2). Params set by the voice DO:
   * { repId, start, attendee:{name,phone?,email?}, context:{leadKey,notes}, callId }.
   */
  private async runVoiceBooking(step: CallaStep): Promise<Record<string, unknown>> {
    const cfg = brainConfigFromEnv(this.env);
    if (!cfg) {
      throw new Error("BRAIN_URL not configured — cannot complete voice booking");
    }
    const p = step.params as {
      repId?: string;
      start?: string;
      attendee?: { name: string; email?: string; phone?: string };
      context?: { leadKey?: string; notes?: string };
      callId?: string;
    };
    if (!p.repId || !p.start || !p.attendee?.name) {
      throw new Error("voice.book_appointment step is missing repId/start/attendee");
    }
    const out = await bookAppointment(cfg, {
      repId: p.repId,
      start: p.start,
      attendee: p.attendee,
      ...(p.context ? { context: p.context } : {}),
    });
    const callId = p.callId ?? "unknown";
    if (!out.ok) {
      await this.publishBookingEvent(callId, "failed", out.error);
      await this.recordVoiceThread(callId, `Booking attempt after approval failed: ${out.error}.`, "system");
      return {
        booked: false,
        status: out.status,
        error: out.error,
        ranAt: Date.now(),
      };
    }
    if (out.kind === "handoff") {
      await this.publishBookingEvent(callId, "handoff", out.link ?? undefined);
      await this.recordVoiceThread(
        callId,
        `Booking link shared (Calendly hand-off): ${out.link ?? "no link"}.`,
        "system",
      );
      return {
        booked: false,
        handoff: true,
        link: out.link ?? null,
        start: p.start,
        ranAt: Date.now(),
      };
    }
    await this.publishBookingEvent(callId, "booked", out.appointmentId ?? undefined);
    await this.recordVoiceThread(
      callId,
      `Appointment confirmed after approval: ${p.attendee.name}, ${p.start}.`,
      "system",
    );
    return {
      booked: true,
      appointmentId: out.appointmentId,
      start: p.start,
      ranAt: Date.now(),
    };
  }

  /** Best-effort `calla:voice:booking` frame (UI Calls history). */
  private async publishBookingEvent(
    callId: string,
    status: string,
    detail?: string,
  ): Promise<void> {
    try {
      const hub = this.env.CALLA_EVENTS.getByName(HUB_NAME);
      await hub.publish(
        callaFrame(CALLA_EVENTS.voiceBooking, { callId, status, detail }, {
          agentId: this.name,
        }),
      );
    } catch (err) {
      console.error("[calla] booking event publish failed:", err);
    }
  }

  /** Best-effort append to the `voice:<callId>` conversation thread. */
  private async recordVoiceThread(
    callId: string,
    text: string,
    kind: string,
  ): Promise<void> {
    const cfg = brainConfigFromEnv(this.env);
    if (!cfg) return;
    try {
      const id = `voice:${encodeURIComponent(callId)}`;
      const res = await fetch(`${cfg.url.replace(/\/+$/, "")}/conversations/${id}/transcript`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}),
        },
        body: JSON.stringify({ dir: "outbound", text, kind }),
      });
      if (!res.ok) {
        console.warn(`[calla] voice thread record ${res.status} for ${id}`);
      }
    } catch (err) {
      console.warn("[calla] voice thread record failed:", err);
    }
  }

  private async recordCompleted(
    step: CallaStep,
    output: unknown,
    approvalId?: string,
  ): Promise<void> {
    const entry: CompletedStep = {
      stepId: step.id,
      action: step.action,
      output,
      completedAt: Date.now(),
    };
    this.setState({
      ...this.state,
      completedSteps: [...this.state.completedSteps, entry],
    });
    await this.appendAudit("step.executed", {
      stepId: step.id,
      action: step.action,
      approvalId: approvalId ?? null,
      completedAt: entry.completedAt,
    });
  }

  /** Map an internal PendingApproval to the shared wire ApprovalRequest. */
  private toApprovalRequest(a: PendingApproval, timeoutMs: number): ApprovalRequest {
    return {
      id: a.id,
      source: "cloudflare",
      agentId: this.name,
      approvalId: a.id,
      toolName: a.step.action,
      arguments: a.step.params,
      risk: a.risk,
      summary: `Edge step "${a.step.action}" requires approval`,
      requestedAt: new Date(a.requestedAt).toISOString(),
      expiresAt: new Date(a.requestedAt + timeoutMs).toISOString(),
      status: a.status,
    };
  }

  /** Best-effort publish of a frame to the CallaEventHub DO ("hub"). */
  private async publishFrame(frame: CallaWsFrame): Promise<void> {
    try {
      const hub = this.env.CALLA_EVENTS.getByName(HUB_NAME);
      await hub.publish(frame);
    } catch (err) {
      console.error("[calla] event hub publish failed:", err);
    }
  }

  /**
   * Best-effort append to the hub's hash-chained audit trail. Audit writes never
   * fail the operation they describe — a broken audit link is logged, not thrown.
   */
  private async appendAudit(
    kind: AuditKind,
    entry: Record<string, unknown>,
  ): Promise<void> {
    try {
      const hub = this.env.CALLA_EVENTS.getByName(HUB_NAME);
      await hub.appendAudit({ agentId: this.name, kind, entry });
    } catch (err) {
      console.error(`[calla] audit append failed (${kind}):`, err);
    }
  }
}
