# AgentDeploy SDK

Build, test, and deploy stateful AI agents that run on Cloudflare's edge —
then sell them on the [AgentDeploy marketplace](https://agentdeploy.io).

This repository contains the complete SDK system for **sellers**: everything
you need to build an edge agent template with an embedded UI and publish it
for buyers.

## The 60-Second Version

```bash
# 1. Scaffold an agent with chat UI included
npx @agentdeploy/cli init --template chat-agent my-agent
cd my-agent
npm install

# 2. Run it locally — agent + UI on one port
npm run dev
# → http://localhost:8787/ui

# 3. Deploy to the edge
npx @agentdeploy/cli deploy
```

Your agent is a single Cloudflare Worker: Durable Object state, WebSocket
chat, scheduled (cron) triggers, and a bundled UI served at `/ui`. No
separate frontend to host.

## Packages

| Package | What it's for |
|---------|---------------|
| [`@agentdeploy/agents`](./agents) | The core SDK — a fork (facade) of Cloudflare's Agents SDK, decoupled from upstream release cycles. Adds `useAgentStatus` and the `uiAssets()` Vite plugin. |
| [`@agentdeploy/sdk`](./sdk) | Deploying and invoking agents on the AgentDeploy Edge. |
| [`@agentdeploy/edge-sdk`](./edge-sdk) | Billing, telemetry, and gateway integration — report usage from your agent to the marketplace. |
| [`@agentdeploy/edge-ui`](./edge-ui) | Drop-in UI shells for your agent: chat, dashboard, widget, split. Themeable. |
| `@agentdeploy/cli` | `ad init`, `ad dev`, `ad login`, `ad deploy` — the full seller workflow. |

## Architecture: One Worker, Agent + UI

```
┌─────────────────────────────────────────────┐
│  Your Agent Worker (single deployment)       │
│                                              │
│  ┌────────────┐      ┌────────────────────┐ │
│  │  Agent DO   │ WS   │  UI Shell at /ui   │ │
│  │  (state,    │◄─────│  (served via       │ │
│  │   cron,     │      │   uiAssets())      │ │
│  │   chat)     │      │                    │ │
│  └────────────┘      └────────────────────┘ │
│                                              │
│  @agentdeploy/edge-sdk → usage/billing       │
└─────────────────────────────────────────────┘
```

When a buyer purchases your template on agentdeploy.io, the marketplace
provisions and hosts it. Buyers get their own management console
(multi-agent dashboard) automatically — you don't build or host that.

**Your job as a seller:** one repo, one Worker, agent + UI. That's it.

## Why a fork of the Agents SDK?

`@agentdeploy/agents` re-exports everything from Cloudflare's excellent
[`agents`](https://github.com/cloudflare/agents) package, so your existing
knowledge (and most code) transfers directly. The facade means:

- AgentDeploy-specific features (`uiAssets()`, `useAgentStatus`) live here
- If upstream makes breaking changes, we absorb them — your code doesn't break
- You can always fall back to stock Cloudflare APIs

The wire protocol is unchanged: `cf_agent_use_chat_request`,
`cf_agent_state`, `cf_agent_identity`, etc.

## Templates

Start from a template via the CLI:

| Template | Description |
|----------|-------------|
| `chat-agent` | Streaming chat with tool calling, built on `AIChatAgent`, with bundled chat UI |

## Local Development of This Repo

```bash
git clone https://github.com/agentdeploy-io/agentdeploy-sdk.git
cd agentdeploy-sdk
npm install        # in each package, or use your workspace tool of choice
```

- `packages/agents` — core SDK (start here to read source)
- `packages/cli/templates/chat-agent` — the canonical example agent
- `packages/edge-ui-playground` — full console UI (reference implementation;
  what buyers see after purchase)

## License

MIT
