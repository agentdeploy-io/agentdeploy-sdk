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
| `name` | `string` | Agent name for routing |
| `onStart` | `function` | Called on first invocation |
| `onRequest` | `function` | HTTP request handler |
| `onSchedule` | `function` | Scheduled task handler |
| `tools` | `Record<string, AgentDeployTool>` | Tools the agent can call |
| `mcpServers` | `McpServerConfig[]` | External tool servers |

### `createChatAgent(config)`
Creates a chat agent with streaming, message persistence, and tool calling.

| Option | Type | Description |
|---|---|---|
| `name` | `string` | Agent name for routing |
| `systemPrompt` | `string \| function` | System prompt |
| `model` | `string?` | Model hint (platform may override) |
| `tools` | `Record<string, AgentDeployTool>` | Available tools |
| `mcpServers` | `McpServerConfig[]` | External tool servers |
| `maxSteps` | `number?` | Max tool-call rounds (default: 10) |

### `defineTool(def)`
Defines a typed tool with Zod schema validation.

### `useGateway(modelName?)`
Returns an AI SDK model that routes through AgentDeploy's gateway.

### `useSecrets<T>(env)`
Typed access to deployment secrets.

### `createHandler(...agentClasses)`
Creates the worker fetch handler with agent routing and health checks.

## How It Works

1. You write agents using the SDK's `createAgent()` / `createChatAgent()`
2. The `@agentdeploy-io/cli` bundles your code with esbuild into a single ESM module
3. The platform's renderer injects `AD_DEPLOYMENT_ID`, `AD_MODEL`, `AD_GATEWAY_BASE_URL` constants
4. The deploy pipeline auto-detects Durable Object classes and configures bindings + migrations
5. All LLM calls route through the AgentDeploy gateway for billing and token metering

## License

MIT
