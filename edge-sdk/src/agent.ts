// ── Agent Factory ───────────────────────────────────────────────────────────
// createAgent() produces a Durable Object class that wraps the Cloudflare
// Agents SDK Agent class with AgentDeploy billing, telemetry, and gateway hooks.

import { Agent } from "@agentdeploy/agents";
import type {
  AgentConfig,
  AgentContext,
  AgentDeployAgent,
  AgentSchedule,
} from "./types.js";
import { recordTelemetry, reportUsage } from "./internal/telemetry.js";

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
 * import { createAgent, createHandler } from "@agentdeploy/edge-sdk";
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

  class AgentDeployAgentImpl extends Agent<TState> implements AgentDeployAgent<TState> {
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

    async schedule(
      when: string | Date,
      name: string,
      ...args: unknown[]
    ): Promise<string> {
      // Delegate to the Agents SDK's scheduling
      const id = await super.schedule(when, name, ...args);
      recordTelemetry("schedule.create", { id, name, when: String(when) });
      return id;
    }

    async scheduleEvery(
      cron: string,
      name: string,
      ...args: unknown[]
    ): Promise<string> {
      const id = await super.scheduleEvery(cron, name, ...args);
      recordTelemetry("schedule.recurring", { id, name, cron });
      return id;
    }

    getSchedules(): AgentSchedule[] {
      const raw = super.getSchedules();
      return raw.map((s: unknown) => {
        const obj = s as Record<string, unknown>;
        return {
          schedule: String(obj.cron ?? obj.when ?? ""),
          name: String(obj.name ?? ""),
          description: obj.description ? String(obj.description) : undefined,
          createdAt: obj.createdAt ? String(obj.createdAt) : new Date().toISOString(),
        };
      });
    }

    cancelSchedule(id: string): void {
      super.cancelSchedule(id);
      recordTelemetry("schedule.cancel", { id });
    }

    // ── Lifecycle Hooks (delegate to user config) ────────────────────────

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
