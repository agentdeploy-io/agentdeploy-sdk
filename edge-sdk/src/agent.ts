// ── Agent Factory ───────────────────────────────────────────────────────────
// createAgent() produces a Durable Object class that wraps the Cloudflare
// Agents SDK Agent class with AgentDeploy billing, telemetry, and gateway hooks.

import { Agent } from "@agentdeploy-io/agents";
import type {
  RetryOptions,
  Schedule,
  ScheduleCriteria,
} from "@agentdeploy-io/agents";
import type {
  AgentConfig,
  AgentContext,
  AgentDeployAgent,
  AgentSchedule,
} from "./types.js";
import { recordTelemetry, reportUsage } from "./internal/telemetry.js";
import { runtimeErrorFromStackText, runtimeErrorResponse } from "./runtime-error.js";

/**
 * Creates a Durable Object class for a general-purpose agent.
 *
 * The returned class extends the Cloudflare Agents SDK `Agent` class and
 * automatically:
 *   - Routes LLM calls through the AgentDeploy gateway (billing + metering)
 *   - Records telemetry events (start, request, tool calls)
 *   - Provides typed secret access via useSecrets()
 *   - Supports scheduling via the Agents SDK
 *   - Supports MCP tool servers
 *
 * The class should be exported from your worker entry point:
 *
 * @example
 * ```ts
 * import { createAgent, createHandler } from "@agentdeploy-io/edge-sdk";
 *
 * export const Monitor = createAgent({
 *   name: "monitor",
 *   onStart() {
 *     this.scheduleEvery("0 * * * *", "hourlyCheck");
 *   },
 *   async onSchedule(task) {
 *     if (task.name === "healthCheck") {
 *       // Check uptime, send alerts...
 *     }
 *   },
 * });
 *
 * export default createHandler(Monitor);
 * ```
 */
export function createAgent<TState = Record<string, unknown>>(
  config: AgentConfig<TState>,
) {
  // Store config statically so the class methods can access it
  const agentConfig = config;
  const agentTools = config.tools ?? {};

  // NOTE: the `implements AgentDeployAgent<TState>` clause is intentionally
  // omitted — the public interface keeps its convenience signatures (cron
  // strings, `Promise<string>` schedule ids) while the class mirrors the
  // upstream `Agent` base signatures so the overrides stay type-compatible.
  // The factory's return cast below exposes the public interface to users.
  class AgentDeployAgentImpl extends Agent<Record<string, unknown>, TState> {
    static agentName = agentConfig.name;
    static agentTools = agentTools;
    static agentMcpServers = agentConfig.mcpServers ?? [];

    // ── AgentDeploy Platform Methods ──────────────────────────────────────

    __adContext(): AgentContext {
      return {
        deploymentId: AD_DEPLOYMENT_ID,
        userId: AD_USER_ID,
        templateId: AD_TEMPLATE_ID,
        model: AD_MODEL,
        region: AD_REGION,
        gatewayBaseUrl: AD_GATEWAY_BASE_URL,
        env: this.env as Record<string, unknown>,
      };
    }

    __adReportUsage(usage: {
      tokensIn: number;
      tokensOut: number;
      totalTokens: number;
    }): void {
      reportUsage(usage);
    }

    __adTelemetry(event: string, data?: Record<string, unknown>): void {
      recordTelemetry(event, data);
    }

    // ── Tool Execution ────────────────────────────────────────────────────

    async callTool(name: string, input: unknown): Promise<unknown> {
      const tool = agentTools[name];
      if (!tool) {
        throw new Error(`Tool "${name}" not found. Available: ${Object.keys(agentTools).join(", ")}`);
      }
      const ctx = {
        agent: this as unknown as AgentDeployAgent,
        env: this.env as Record<string, unknown>,
        deploymentId: AD_DEPLOYMENT_ID,
        model: AD_MODEL,
        gatewayBaseUrl: AD_GATEWAY_BASE_URL,
      };
      return tool.execute(input, ctx);
    }

    // ── Scheduling Helpers ────────────────────────────────────────────────

    /**
     * Schedule a task (one-shot Date/delay, or cron expression).
     * Mirrors the upstream `Agent.schedule` signature so the override remains
     * type-compatible with the base class.
     */
    async schedule<T = string>(
      when: Date | string | number,
      callback: keyof this & string,
      payload?: T,
      options?: { retry?: RetryOptions; idempotent?: boolean },
    ): Promise<Schedule<T>> {
      // Delegate to the Agents SDK's scheduling
      const schedule = await super.schedule(when, callback, payload, options);
      recordTelemetry("schedule.create", {
        id: schedule.id,
        name: String(callback),
        when: String(when),
      });
      return schedule;
    }

    /**
     * Schedule a recurring task at a fixed interval (seconds).
     * Mirrors the upstream `Agent.scheduleEvery` signature. Note: upstream
     * only accepts a numeric interval — cron expressions must go through
     * `schedule(cron, ...)` instead.
     */
    async scheduleEvery<T = string>(
      intervalSeconds: number,
      callback: keyof this & string,
      payload?: T,
      options?: { retry?: RetryOptions; _idempotent?: boolean },
    ): Promise<Schedule<T>> {
      const schedule = await super.scheduleEvery(
        intervalSeconds,
        callback,
        payload,
        options,
      );
      recordTelemetry("schedule.recurring", {
        id: schedule.id,
        name: String(callback),
        cron: String(intervalSeconds),
      });
      return schedule;
    }

    /**
     * Get all scheduled tasks, mapped to the AgentDeploy `AgentSchedule`
     * view exposed via the public `AgentDeployAgent` interface.
     */
    getSchedules<T = string>(criteria?: ScheduleCriteria): Schedule<T>[] {
      const raw = super.getSchedules(criteria);
      return raw.map((s) => {
        const obj = s as unknown as Record<string, unknown>;
        return {
          schedule: String(obj.cron ?? obj.when ?? ""),
          name: String(obj.name ?? ""),
          description: obj.description ? String(obj.description) : undefined,
          createdAt: obj.createdAt ? String(obj.createdAt) : new Date().toISOString(),
        };
      }) as unknown as Schedule<T>[];
    }

    cancelSchedule(id: string): Promise<boolean> {
      const result = super.cancelSchedule(id);
      recordTelemetry("schedule.cancel", { id });
      return result;
    }

    // ── Lifecycle Hooks (delegate to user config) ────────────────────────

    /**
     * Durable-Object routes (/agents/:class/:instance/*) bypass the worker
     * script's fetch handler entirely — CF dispatches straight to this DO's
     * fetch. The base partyserver fetch swallows pipeline errors and
     * responds with `new Response(err.stack, { status: 500 })`; convert
     * that (and any genuinely thrown error) into structured, customer-safe
     * JSON. The full error/stack is logged for developers.
     */
    async fetch(request: Request): Promise<Response> {
      let response: Response;
      try {
        response = await super.fetch(request);
      } catch (err) {
        return runtimeErrorResponse(err, AD_DEPLOYMENT_ID);
      }
      const contentType = response.headers.get("content-type") || "";
      if (response.status >= 500 && !contentType.includes("application/json")) {
        const text = await response.text().catch(() => "");
        if (text.trim().startsWith("{")) {
          // Some other handler produced a JSON body — pass it through.
          return new Response(text, {
            status: response.status,
            headers: { "Content-Type": "application/json" },
          });
        }
        return runtimeErrorFromStackText(text, AD_DEPLOYMENT_ID, response.status);
      }
      return response;
    }

    async onStart(): Promise<void> {
      recordTelemetry("agent.start", { name: agentConfig.name });
      if (agentConfig.onStart) {
        await agentConfig.onStart.call(this as unknown as AgentDeployAgent<TState>);
      }
    }

    async onRequest(request: Request): Promise<Response> {
      recordTelemetry("agent.request", {
        name: agentConfig.name,
        method: request.method,
        path: new URL(request.url).pathname,
      });

      if (agentConfig.onRequest) {
        return agentConfig.onRequest.call(
          this as unknown as AgentDeployAgent<TState>,
          request,
        );
      }

      // Default response
      return new Response(
        JSON.stringify({
          status: "ok",
          agent: agentConfig.name,
          deploymentId: AD_DEPLOYMENT_ID,
          tools: Object.keys(agentTools),
        }),
        {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "X-AD-Deployment": AD_DEPLOYMENT_ID,
          },
        },
      );
    }

    onConnect(connection: WebSocket): void {
      recordTelemetry("agent.connect", { name: agentConfig.name });
      agentConfig.onConnect?.call(
        this as unknown as AgentDeployAgent<TState>,
        connection,
      );
    }

    onMessage(connection: WebSocket, message: unknown): void {
      recordTelemetry("agent.message", { name: agentConfig.name });
      agentConfig.onMessage?.call(
        this as unknown as AgentDeployAgent<TState>,
        connection,
        message,
      );
    }

    onClose(connection: WebSocket): void {
      recordTelemetry("agent.close", { name: agentConfig.name });
      agentConfig.onClose?.call(
        this as unknown as AgentDeployAgent<TState>,
        connection,
      );
    }

    async onSchedule(task: { name: string; schedule?: string }): Promise<void> {
      recordTelemetry("agent.schedule", {
        name: agentConfig.name,
        task: task.name,
      });
      if (agentConfig.onSchedule) {
        const schedule: AgentSchedule = {
          schedule: task.schedule ?? "",
          name: task.name,
          createdAt: new Date().toISOString(),
        };
        await agentConfig.onSchedule.call(
          this as unknown as AgentDeployAgent<TState>,
          schedule,
        );
      }
    }
  }

  return AgentDeployAgentImpl as unknown as (new (
    state: DurableObjectState,
    env: Record<string, unknown>,
  ) => AgentDeployAgent<TState>);
}
