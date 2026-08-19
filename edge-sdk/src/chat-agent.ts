// ── Chat Agent Factory ──────────────────────────────────────────────────────
// createChatAgent() produces a Durable Object class that wraps AIChatAgent
// with AgentDeploy gateway routing, billing, and telemetry.

import { AIChatAgent } from "@cloudflare/ai-chat";
import { streamText, createUIMessageStream, createUIMessageStreamResponse, convertToModelMessages, stepCountIs } from "ai";
import type {
  ChatAgentConfig,
  AgentContext,
  AgentDeployChatAgent,
  AgentDeployTool,
} from "./types.js";
import { useGateway } from "./gateway.js";
import { recordTelemetry, reportUsage } from "./internal/telemetry.js";
import { connectMcp } from "./mcp.js";

/**
 * Tracks incremental token usage during streaming so that if the connection
 * is aborted mid-stream, we can still report the partial usage to the platform.
 *
 * IMPORTANT: The AgentDeploy Gateway is the authoritative source for token
 * metering — it intercepts every upstream LLM HTTP response and counts tokens
 * regardless of whether the client stream completes. This tracker is a
 * secondary signal that ensures the SDK's onAfterChat hook fires even on
 * abort, so agent developers can react to partial usage in their code.
 */
interface StreamUsageTracker {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  reported: boolean;
}

function createUsageTracker(): StreamUsageTracker {
  return { promptTokens: 0, completionTokens: 0, totalTokens: 0, reported: false };
}

function reportTrackedUsage(
  tracker: StreamUsageTracker,
  ctx: AgentContext,
  config: ChatAgentConfig,
): void {
  if (tracker.reported) return;
  tracker.reported = true;

  const usageReport = {
    tokensIn: tracker.promptTokens,
    tokensOut: tracker.completionTokens,
    totalTokens: tracker.totalTokens,
  };
  reportUsage(usageReport);
  recordTelemetry("chat.usage_reported", { ...usageReport, aborted: tracker.completionTokens > 0 && !tracker.reported });

  if (config.onAfterChat) {
    config.onAfterChat(ctx, usageReport).catch(() => {
      // Don't let after-chat hooks crash the stream
    });
  }
}

/**
 * Creates a Durable Object class for a chat agent backed by AIChatAgent.
 *
 * The returned class extends @cloudflare/ai-chat's `AIChatAgent` and
 * automatically:
 *   - Routes LLM calls through the AgentDeploy gateway via useGateway()
 *   - Persists chat messages in the Durable Object's SQLite
 *   - Supports streaming responses via the Vercel AI SDK
 *   - Merges local tools with MCP server tools
 *   - Reports token usage to the platform for billing
 *
 * @example
 * ```ts
 * import { createChatAgent, createHandler, defineTool } from "@agentdeploy/edge-sdk";
 * import { z } from "zod";
 *
 * const getTime = defineTool({
 *   description: "Get the current time",
 *   inputSchema: z.object({ timezone: z.string().optional() }),
 *   execute: async () => ({ time: new Date().toISOString() }),
 * });
 *
 * export const Chat = createChatAgent({
 *   name: "chat",
 *   systemPrompt: "You are a helpful assistant.",
 *   tools: { getTime },
 *   maxSteps: 10,
 * });
 *
 * export default createHandler(Chat);
 * ```
 */
export function createChatAgent(config: ChatAgentConfig) {
  const agentConfig = config;
  const agentTools: Record<string, AgentDeployTool<any, any>> = config.tools ?? {};

  class AgentDeployChatAgentImpl extends AIChatAgent implements AgentDeployChatAgent {
    static agentName = agentConfig.name;
    static agentConfig = agentConfig;

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

    async callTool(name: string, input: unknown): Promise<unknown> {
      const tool = agentTools[name];
      if (!tool) {
        throw new Error(
          `Tool "${name}" not found. Available: ${Object.keys(agentTools).join(", ")}`,
        );
      }
      return tool.execute(input, {
        agent: this as unknown as AgentDeployChatAgent,
        env: this.env as Record<string, unknown>,
        deploymentId: AD_DEPLOYMENT_ID,
        model: AD_MODEL,
        gatewayBaseUrl: AD_GATEWAY_BASE_URL,
      });
    }

    // ── Chat Handler ──────────────────────────────────────────────────────

    async onChatMessage(
      onFinish: (result: unknown) => void | Promise<void>,
      _options?: unknown,
    ): Promise<Response> {
      recordTelemetry("chat.message", { agent: agentConfig.name });

      // Pre-chat hook
      const ctx = this.__adContext();
      if (agentConfig.onBeforeChat) {
        await agentConfig.onBeforeChat(ctx);
      }

      // Usage tracker — ensures we report partial usage even on abort
      const tracker = createUsageTracker();

      // Build tool set: local tools + MCP tools
      const localTools: Record<string, unknown> = {};
      for (const [name, tool] of Object.entries(agentTools)) {
        // Wrap in AI SDK tool format
        localTools[name] = {
          description: tool.description,
          inputSchema: tool.inputSchema,
          needsApproval: tool.needsApproval,
          execute: async (input: unknown) => {
            return tool.execute(input, {
              agent: this as unknown as AgentDeployChatAgent,
              env: this.env as Record<string, unknown>,
              deploymentId: AD_DEPLOYMENT_ID,
              model: AD_MODEL,
              gatewayBaseUrl: AD_GATEWAY_BASE_URL,
            });
          },
        };
      }

      // Connect MCP servers for additional tools
      let allTools = { ...localTools };
      if (agentConfig.mcpServers?.length) {
        try {
          const mcpTools = await connectMcp(
            this as unknown as AgentDeployChatAgent,
            agentConfig.mcpServers,
          );
          allTools = { ...allTools, ...mcpTools };
        } catch (error) {
          recordTelemetry("chat.mcp_error", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }

      // Resolve system prompt
      const systemPrompt =
        typeof agentConfig.systemPrompt === "function"
          ? await agentConfig.systemPrompt(ctx)
          : agentConfig.systemPrompt;

      // Get model from gateway (routes through platform billing)
      const model = useGateway(agentConfig.model);

      // Convert stored messages to AI SDK format
      const messages = (this.messages ?? []).filter(
        (m: { role: string }) => m.role !== "system",
      );

      const modelMessages = await convertToModelMessages(messages);

      // Stream the response
      const stream = createUIMessageStream({
        execute: async ({ writer }) => {
          const result = streamText({
            model,
            system: systemPrompt,
            messages: modelMessages,
            tools: allTools as Record<string, unknown>,
            stopWhen: stepCountIs(agentConfig.maxSteps ?? 10),
            temperature: agentConfig.temperature,
            maxTokens: agentConfig.maxTokens,
            // Track usage incrementally via onChunk — ensures we capture
            // partial usage even if the stream is aborted by the client
            onChunk: ({ chunk }: { chunk: { type?: string; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } } }) => {
              // Some providers send usage updates in chunks
              if (chunk?.usage) {
                tracker.promptTokens = chunk.usage.promptTokens ?? tracker.promptTokens;
                tracker.completionTokens = chunk.usage.completionTokens ?? tracker.completionTokens;
                tracker.totalTokens = chunk.usage.totalTokens ?? tracker.totalTokens;
              }
            },
            onError: (error: { error?: unknown }) => {
              // Stream errored — report whatever usage we have so far
              recordTelemetry("chat.stream_error", {
                error: error?.error instanceof Error ? error.error.message : String(error?.error),
                partialUsage: {
                  tokensIn: tracker.promptTokens,
                  tokensOut: tracker.completionTokens,
                },
              });
              reportTrackedUsage(tracker, ctx, agentConfig);
            },
            onFinish: async (result: {
              usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
            }) => {
              // Normal completion — update tracker with final usage
              const usage = result.usage ?? {};
              tracker.promptTokens = usage.promptTokens ?? tracker.promptTokens;
              tracker.completionTokens = usage.completionTokens ?? tracker.completionTokens;
              tracker.totalTokens = usage.totalTokens ?? tracker.totalTokens;

              // Report usage (idempotent — safe even if onError already fired)
              reportTrackedUsage(tracker, ctx, agentConfig);
              recordTelemetry("chat.complete", {
                tokensIn: tracker.promptTokens,
                tokensOut: tracker.completionTokens,
                totalTokens: tracker.totalTokens,
              });

              await onFinish(result);
            },
          });
          writer.merge(result.toUIMessageStream());
        },
        onError: (error: { error?: unknown }) => {
          // Top-level stream error (e.g., client disconnect) — report partial usage
          recordTelemetry("chat.aborted", {
            error: error?.error instanceof Error ? error.error.message : "stream aborted",
            partialUsage: {
              tokensIn: tracker.promptTokens,
              tokensOut: tracker.completionTokens,
            },
          });
          reportTrackedUsage(tracker, ctx, agentConfig);
        },
      });

      // Use the AI SDK helper to convert the UIMessageStream into a proper
      // SSE-formatted Response that AIChatAgent can read.
      return createUIMessageStreamResponse({
        stream,
        headers: {
          "X-AD-Deployment": AD_DEPLOYMENT_ID,
        },
      });
    }
  }

  return AgentDeployChatAgentImpl as unknown as (new (
    state: DurableObjectState,
    env: Record<string, unknown>,
  ) => AgentDeployChatAgent);
}
