# @agentdeploy-io/edge-sdk

Build AI agents on Cloudflare's edge with AgentDeploy billing, telemetry, and gateway integration.

## Quick Start

```bash
npm install @agentdeploy-io/edge-sdk agents @cloudflare/ai-chat ai zod
```

## Create a Chat Agent

```typescript
import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const Assistant = createChatAgent({
  name: "assistant",
  systemPrompt: "You are a helpful assistant. Be concise and accurate.",
  maxSteps: 10,
});

export default createHandler(Assistant);
```

## Add Tools

```typescript
import { createChatAgent, createHandler, defineTool } from "@agentdeploy-io/edge-sdk";
import { z } from "zod";

const checkInventory = defineTool({
  description: "Check product inventory by SKU",
  inputSchema: z.object({ sku: z.string() }),
  execute: async ({ sku }) => {
    const res = await fetch(`https://api.example.com/inventory/${sku}`);
    return res.json();
  },
});

const createOrder = defineTool({
  description: "Create a new order for a customer",
  inputSchema: z.object({
    sku: z.string(),
    quantity: z.number().int().positive(),
    customerEmail: z.string().email(),
  }),
  needsApproval: true,
  execute: async (input) => {
    return { orderId: "ord_" + Date.now(), status: "confirmed" };
  },
});

export const CommerceAgent = createChatAgent({
  name: "commerce",
  systemPrompt: "You are a sales assistant. Help customers check inventory and place orders.",
  tools: { checkInventory, createOrder },
  maxSteps: 10,
});

export default createHandler(CommerceAgent);
```

## Scheduled Agents

```typescript
import { createAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const Monitor = createAgent({
  name: "monitor",
  onStart() {
    // Schedule health checks every 5 minutes
    this.scheduleEvery("*/5 * * * *", "healthCheck");
  },
  async onSchedule(task) {
    if (task.name === "healthCheck") {
      const res = await fetch("https://api.example.com/health");
      const data = await res.json();
      this.setState({ lastCheck: data, checkedAt: new Date().toISOString() });
    }
  },
});

export default createHandler(Monitor);
```

## MCP Integration

`createChatAgent()` connects to configured MCP servers automatically and merges
their tools with your local ones:

```typescript
import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const ResearchAgent = createChatAgent({
  name: "research",
  systemPrompt: "You are a research assistant with access to web scraping and database tools.",
  mcpServers: [
    {
      transport: {
        type: "sse",
        url: "https://mcp.agentdeploy.io/sse",
        headers: { "Authorization": "Bearer mcp_key_here" },
      },
    },
  ],
  maxSteps: 15,
});

export default createHandler(ResearchAgent);
```

For manual control (e.g. inside a `createAgent()` lifecycle hook), use
`connectMcp(agent, servers)` / `disconnectMcp(agent, name?)`:

```typescript
import { createAgent, createHandler, connectMcp } from "@agentdeploy-io/edge-sdk";

export const Monitor = createAgent({
  name: "monitor",
  async onStart() {
    const tools = await connectMcp(this, [
      { transport: { type: "sse", url: "https://mcp.example.com/sse" } },
    ]);
    // tools — AI SDK tools you can pass to useGateway()/streamText()
  },
});

export default createHandler(Monitor);
```

## Secret Access

```typescript
import { createAgent, createHandler, useSecrets } from "@agentdeploy-io/edge-sdk";

export const PaymentAgent = createAgent({
  name: "payments",
  async onRequest(request) {
    const secrets = useSecrets<{ STRIPE_SECRET_KEY: string }>(this.env);
    // secrets.STRIPE_SECRET_KEY — typed, throws if missing
    const stripe = Stripe(secrets.STRIPE_SECRET_KEY);
    // ...
  },
});

export default createHandler(PaymentAgent);
```

## Multi-Agent Routing

```typescript
import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const Support = createChatAgent({
  name: "support",
  systemPrompt: "You handle customer support questions.",
});

export const Sales = createChatAgent({
  name: "sales",
  systemPrompt: "You help customers with purchases.",
});

export const Billing = createChatAgent({
  name: "billing",
  systemPrompt: "You handle billing inquiries.",
});

export default createHandler(Support, Sales, Billing);
// Each agent accessible at /agents/support, /agents/sales, /agents/billing
```

## API Reference

### `createAgent(config)`
Creates a general-purpose Durable Object agent.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Agent name for routing (/agents/:name/:instance) |
| `onStart` | `function` | Called on first invocation (or wake from hibernation) |
| `onRequest` | `function` | HTTP request handler (non-WebSocket) |
| `onConnect` | `function` | Called on WebSocket connection |
| `onMessage` | `function` | Called on WebSocket message |
| `onClose` | `function` | Called on WebSocket close |
| `onSchedule` | `function` | Scheduled task handler |
| `tools` | `Record<string, AgentDeployTool>` | Tools the agent can call via `this.callTool()` |
| `mcpServers` | `McpServerConfig[]` | External tool servers |

Inside lifecycle hooks you get `this.state`, `this.setState()`, `this.env`,
`this.sql\`...\``, `this.schedule()`, `this.scheduleEvery()`,
`this.getSchedules()`, `this.cancelSchedule()`, and `this.callTool()`.

### `createChatAgent(config)`
Creates a chat agent with streaming, message persistence, and tool calling.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Agent name for routing |
| `systemPrompt` | `string \| function` | System prompt (function receives `AgentContext`) |
| `model` | `string?` | Model hint (platform may override) |
| `tools` | `Record<string, AgentDeployTool>` | Available tools |
| `mcpServers` | `McpServerConfig[]` | External tool servers |
| `maxSteps` | `number?` | Max tool-call rounds (default: 10) |
| `temperature` | `number?` | Sampling temperature (provider default if omitted) |
| `maxTokens` | `number?` | Max completion tokens (provider default if omitted) |
| `onBeforeChat` | `function?` | Called before each chat message is processed |
| `onAfterChat` | `function?` | Called after chat completes with token usage |

### `defineTool(def)`
Defines a typed tool with Zod schema validation and telemetry.

```typescript
const tool = defineTool({
  description: "Tool description",
  inputSchema: z.object({ /* ... */ }),
  needsApproval: false, // set true to require approval before execution
  execute: async (input, ctx) => { /* ... */ },
});
```

### `useGateway(modelName?, env?)`
Returns an AI SDK model that routes through AgentDeploy's gateway. Used
internally by `createChatAgent()`; useful for direct LLM access in scheduled
agents or custom tools.

### `gatewayUrl()`
Returns the raw gateway base URL for custom `fetch` calls.

### `gatewayHeaders()`
Returns the deployment headers (`X-AD-Deployment`) for manual gateway calls.

### `useSecrets<T>(env)`
Typed access to deployment secrets. Throws a descriptive error when a required
secret is missing (in local dev it warns instead, so you can iterate without
setting up `.dev.vars`).

### `hasSecret(env, key)`
Checks whether a secret is configured without throwing.

### `getSecret(env, key, fallback?)`
Gets a secret value, returning a fallback when it's not configured.

### `connectMcp(agent, servers)`
Connects to MCP servers and returns their tools merged as AI SDK tools.
`createChatAgent()` calls this automatically when `mcpServers` is set.

### `disconnectMcp(agent, name?)`
Disconnects from MCP servers (all, or one by name).

### `createHandler(...agentClasses)`
Creates the worker fetch handler with agent routing, `/health` and `/info`
endpoints, CORS handling, and a 404 response for unknown routes.

## How It Works

1. You write agents using the SDK's `createAgent()` / `createChatAgent()`
2. The `@agentdeploy-io/cli` bundles your code with esbuild into a single ESM module
3. The platform's renderer injects `AD_DEPLOYMENT_ID`, `AD_MODEL`, `AD_GATEWAY_BASE_URL` constants
4. The deploy pipeline auto-detects Durable Object classes and configures bindings + migrations
5. All LLM calls route through the AgentDeploy gateway for billing and token metering

## License

MIT
