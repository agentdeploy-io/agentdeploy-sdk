// ── @agentdeploy/edge-sdk ───────────────────────────────────────────────────
// Build AI agents on Cloudflare's edge with AgentDeploy billing, telemetry,
// and gateway integration.
//
// This package wraps the Cloudflare Agents SDK (agents + @cloudflare/ai-chat)
// and the Vercel AI SDK (ai) with AgentDeploy platform integrations:
//
//   - createAgent()      → General-purpose Durable Object agent
//   - createChatAgent()  → Chat agent with AIChatAgent streaming
//   - defineTool()       → Typed tool factory with telemetry
//   - useGateway()       → LLM gateway integration (billing + routing)
//   - useSecrets()       → Typed secret access
//   - useMcp()           → MCP server connection
//   - createHandler()    → Worker entry point with agent routing

// Agent factories
export { createAgent } from "./agent.js";
export { createChatAgent } from "./chat-agent.js";

// Tool definition
export { defineTool } from "./tool.js";

// Gateway integration
export { useGateway, gatewayUrl, gatewayHeaders } from "./gateway.js";

// Secret access
export { useSecrets, hasSecret, getSecret } from "./secrets.js";

// MCP integration
export { connectMcp, disconnectMcp } from "./mcp.js";

// Handler factory
export { createHandler } from "./handler.js";

// Types
export type {
  AgentConfig,
  ChatAgentConfig,
  AgentDeployTool,
  ToolContext,
  AgentContext,
  AgentDeployAgent,
  AgentDeployChatAgent,
  AgentSchedule,
  AgentHandler,
  McpServerConfig,
} from "./types.js";
