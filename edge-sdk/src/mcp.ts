// ── MCP Integration ─────────────────────────────────────────────────────────
// Wraps the Agents SDK MCP client for connecting external tool servers.
//
// Target: Cloudflare Agents SDK 0.20+ MCPClientManager, whose API is
// `connect(url, { transport })` (0.20 split the legacy connect(serverConfig)
// into connect(url, options) + registerServer/connectToServer).

import type { McpServerConfig, AgentDeployAgent } from "./types.js";

/**
 * Resolve "${KEY}" placeholders in transport headers from the agent's env
 * bindings (secrets never appear in generated code).
 */
function resolveTransportHeaders(
  headers: Record<string, string> | undefined,
  env: Record<string, unknown>,
): Record<string, string> | undefined {
  if (!headers) return headers;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    out[k] = v.replace(/\$\{([A-Z][A-Z0-9_]*)\}/g, (_, key: string) =>
      String(env[key] ?? ""),
    );
  }
  return out;
}

/**
 * Map a blueprint transport to the Agents SDK 0.20 transport options.
 * Returns null for transports a Worker cannot use (stdio) or that the SDK
 * client does not support (ws) — the caller logs and skips.
 */
function toSdkTransport(
  server: McpServerConfig,
  env: Record<string, unknown>,
): { type: "sse" | "streamable-http"; headers?: Record<string, string> } | null {
  const t = server.transport;
  if (t.type === "sse") {
    return { type: "sse", headers: resolveTransportHeaders(t.headers, env) };
  }
  if (t.type === "streamable-http") {
    return { type: "streamable-http", headers: resolveTransportHeaders(t.headers, env) };
  }
  return null;
}

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
 *     { transport: { type: "streamable-http", url: "https://mcp.example.com/mcp", headers: { "api-key": "${MY_KEY}" } } }
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
  const env = agent.env ?? {};

  for (const server of servers) {
    const t = server.transport;
    try {
      if (t.type === "stdio") {
        console.warn(
          `[AgentDeploy] Skipping MCP server ${server.name ?? "unnamed"}: stdio transport is not available on Workers (no child processes). Use a remote SSE/streamable-HTTP server.`,
        );
        continue;
      }
      const sdkTransport = toSdkTransport(server, env);
      if (!sdkTransport || !("url" in t)) {
        console.warn(
          `[AgentDeploy] Skipping MCP server ${server.name ?? "unnamed"}: unsupported transport '${t.type}' on Workers.`,
        );
        continue;
      }
      const url = (t as { url: string }).url;
      const headers = sdkTransport.headers;
      await agent.mcp.connect(url, {
        transport: { type: sdkTransport.type, ...(headers ? { headers } : {}) },
      });
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
 * Close all MCP connections on the agent.
 */
export async function disconnectMcp(
  agent: AgentDeployAgent,
  _name?: string,
): Promise<void> {
  await agent.mcp.closeAllConnections();
}
