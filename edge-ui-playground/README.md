# AgentDeploy Edge UI Playground

Interactive playground for testing and previewing AgentDeploy edge agents with multiple UI shells, themes, and device frames.

## Quick Start

Open **4 terminal windows** and run each service:

### 1. Customer Support Agent (port 8789)

```bash
cd ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/01-customer-support
npm run dev -- --port 8789
```

Runs two chat agents: `support` and `sales`.

### 2. Polymarket Intel Agent (port 8787)

```bash
cd ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/09-polymarket-intel
npm run dev -- --port 8787
```

Runs one worker agent: `polymarket-intel`. Monitors Polymarket orderbooks for large trades.

### 3. Gmail Invoices Agent (port 8788)

```bash
cd ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/08-gmail-invoices
npm run dev -- --port 8788
```

Runs one worker agent: `gmail-invoices`. Extracts invoice data from Gmail, writes to Google Sheets, alerts on Slack.

### 4. Edge UI Playground (port 5173)

```bash
cd ~/Documents/agent-deploy-master/packages/edge-ui-playground
npm run dev
```

Opens `http://localhost:5173` — the interactive UI for all agents.

---

## Architecture

```
Browser (localhost:5173)
    │
    ├── /agents/support/*           ─┐
    ├── /agents/sales/*              ├──→ Vite Proxy → localhost:8789 (customer-support worker)
    ├── /agents/polymarket-intel/*  ─┼──→ Vite Proxy → localhost:8787 (polymarket worker)
    ├── /agents/gmail-invoices/*    ─┤
    │                               └──→ Vite Proxy → localhost:8788 (gmail worker)
    │
    └── Static assets, React app     ──→ Vite dev server
```

### How It Works

The playground uses **same-origin connections** — the browser connects to `localhost:5173` (Vite), and Vite's proxy routes `/agents/{name}/*` to the correct wrangler instance based on the agent name in the URL path.

Each wrangler instance runs a Cloudflare Worker with one or more Durable Object agents. The Vite proxy handles both HTTP and WebSocket connections transparently.

### Vite Proxy Configuration

Defined in `vite.config.ts`. Path-specific entries must come **before** the catch-all:

```typescript
proxy: {
  // Specific agents first (longest prefix wins)
  "/agents/polymarket-intel": { target: "http://localhost:8787", ws: true },
  "/agents/gmail-invoices":   { target: "http://localhost:8788", ws: true },
  // Catch-all for chat agents (support, sales)
  "/agents":                  { target: "http://localhost:8789", ws: true },
}
```

---

## Agent Types

| Type | SDK Function | Extends | UI Shell | Connection |
|------|-------------|---------|----------|------------|
| **Chat** | `createChatAgent()` | `AIChatAgent` | ChatShell, WidgetShell, SplitShell | WebSocket via `useAgentChat()` |
| **Worker** | `createAgent()` | `Agent` | DashboardShell | WebSocket via `useAgent()` + `onStateUpdate` |

### Agents in This Playground

| Agent | Type | Port | Description |
|-------|------|------|-------------|
| `support` | Chat | 8789 | Customer support (KB search, order tracking, ticket escalation) |
| `sales` | Chat | 8789 | Sales assistant (product recommendations) |
| `polymarket-intel` | Worker | 8787 | Polymarket orderbook scanner, Slack alerts for large trades |
| `gmail-invoices` | Worker | 8788 | Gmail invoice extraction, Google Sheets, Slack, auto-reply |

---

## How to Add a New Agent to the UI

### Step 1: Add to the AGENTS array in `src/main.tsx`

```typescript
const AGENTS: AgentConfig[] = [
  // ... existing agents ...
  {
    agent: "my-new-agent",        // URL path name (kebab-case)
    name: "default",              // DO instance name
    label: "My New Agent",        // Display label
    host: "",                     // Empty = same-origin (Vite proxy)
    secure: false,
    kind: "chat",                 // or "worker"
    port: 8790,                   // wrangler port
    description: "What it does",
  },
];
```

### Step 2: Add Vite proxy entry in `vite.config.ts`

Add a specific path entry **before** the catch-all `/agents`:

```typescript
proxy: {
  "/agents/my-new-agent": {
    target: "http://localhost:8790",
    ws: true,
    changeOrigin: true,
  },
  "/agents": { /* catch-all */ },
}
```

### Step 3: Set the DO binding name correctly

In the agent's `wrangler.jsonc`, the DO binding `name` must kebab-case to match the URL path:

```jsonc
{
  "durable_objects": {
    "bindings": [
      { "class_name": "MyAgentClass", "name": "MyNewAgent" }
      // "MyNewAgent" → kebab-case → "my-new-agent" → matches URL path
    ]
  }
}
```

The Cloudflare Agents SDK converts PascalCase binding names to kebab-case for URL routing via `camelCaseToKebabCase()`. The binding name MUST kebab-case to exactly match the agent name used in the URL.

---

## DO Binding Name Reference

The Agents SDK's `routeAgentRequest()` builds a namespace map from environment bindings, converting each binding name to kebab-case:

| Binding Name | Kebab-case | URL Path |
|-------------|-----------|----------|
| `Support` | `support` | `/agents/support/default` |
| `Sales` | `sales` | `/agents/sales/default` |
| `PolymarketIntel` | `polymarket-intel` | `/agents/polymarket-intel/default` |
| `GmailInvoices` | `gmail-invoices` | `/agents/gmail-invoices/default` |

If `env.MyBinding` is used in server.ts for direct DO access, the property name must match the binding `name` field in `wrangler.jsonc`.

---

## UI Shells

### ChatShell
Full-page conversational chat interface for chat agents. Uses `useAgentChat()` to send/receive messages via WebSocket.

### WidgetShell
Floating button that expands into a chat panel. Same WebSocket connection as ChatShell.

### DashboardShell
Agent state monitor for worker agents. Uses `useAgent()` with `onStateUpdate` to display:
- Connection status
- Agent state JSON
- Metrics grid
- RPC trigger buttons

### SplitShell
Side-by-side chat + dashboard. Useful for agents that have both conversational and stateful capabilities.

---

## Theme System

The playground includes a theme system with:
- **Light/Dark mode** toggle
- **6 accent color presets** (Blue, Purple, Emerald, Orange, Rose, Cyan)
- **Desktop/Mobile device frames**

Themes are built via `createTheme()` and applied as CSS custom properties.

---

## API Keys & Secrets

Each agent example has a `.dev.vars` file (gitignored) with real API keys:

- **customer-support**: No secrets needed (uses mock data)
- **polymarket-intel**: `SLACK_WEBHOOK_URL`
- **gmail-invoices**: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN`, `GOOGLE_SHEETS_ID`, `SLACK_WEBHOOK_URL`, `CHUTES_API_KEY`

All agents use `AD_GATEWAY_API_KEY` in `wrangler.jsonc` `define` for LLM access via Chutes.ai.

---

## Debugging

### Check if agents are running

```bash
# Each worker has a /health endpoint
curl http://localhost:8789/health   # customer-support
curl http://localhost:8787/status   # polymarket
curl http://localhost:8788/status   # gmail
```

### Test WebSocket through Vite proxy

```bash
curl -v -H "Upgrade: websocket" -H "Connection: Upgrade" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  -H "Sec-WebSocket-Version: 13" \
  http://localhost:5173/agents/support/default
# Should return 101 Switching Protocols
```

### Clear Durable Object state

If agents have stale state, wipe the local DO storage:

```bash
rm -rf ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/01-customer-support/.wrangler/state
rm -rf ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/08-gmail-invoices/.wrangler/state
rm -rf ~/Documents/agent-deploy-master/agent-deploy-edge-starter/examples/09-polymarket-intel/.wrangler/state
```

Then restart the wrangler instances.
