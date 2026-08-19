// ── MCP Integration ─────────────────────────────────────────────────────────
// Wraps the Agents SDK MCP client for connecting external tool servers.

import type { McpServerConfig, AgentDeployAgent } from "./types.js";

/**
 * Connect to MCP servers and retrieve tools as AI SDK-compatible tools.
 *
 * This wraps the Cloudflare Agents SDK's built-in MCP client. When called
 * inside a chat agent's onChatMessage handler, it connects to all configured
 * MCP servers and returns their tools merged with any locally-defined tools.
 *
 * @example
 * ```ts
 * export const MyAgent = createChatAgent({
 *   name: "research",
 *   systemPrompt: "You are a research assistant.",
 *   mcpServers: [
 *     { transport: { type: "sse", url: "https://mcp.example.com/sse" } }
 *   ],
 *   async onChatMessage(onFinish) {
 *     const mcpTools = await connectMcp(this, config.mcpServers);
 *     // Use mcpTools in streamText()
 *   }
 * });
 * ```
 */
export async function connectMcp(
  agent: AgentDeployAgent,
  servers: McpServerConfig[],
): Promise<Record<string, unknown>> {
  const tools: Record<string, unknown> = {};

  for (const server of servers) {
    try {
      await agent.mcp.connect(server);
      Object.assign(tools, agent.mcp.getAITools());
    } catch (error) {
      // Log but don't fail — MCP servers are optional
      console.error(
        `[AgentDeploy] Failed to connect MCP server ${server.name ?? "unnamed"}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  return tools;
}

/**
 * Disconnect from all MCP servers.
 */
export async function disconnectMcp(
  agent: AgentDeployAgent,
  name?: string,
): Promise<void> {
  await agent.mcp.disconnect(name);
}
