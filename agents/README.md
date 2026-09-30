# @agentdeploy-io/agents

AgentDeploy's fork of the [Cloudflare Agents SDK](https://www.npmjs.com/package/agents) — decoupled from upstream release cycles with added UI shell support for the [AgentDeploy platform](https://agentdeploy.io).

This package is a drop-in replacement for the upstream `agents` package. Everything exported from upstream is re-exported here, plus a few AgentDeploy-specific additions for building edge agents with bundled UI shells.

```
import { Agent, routeAgentRequest } from "@agentdeploy-io/agents";
```

is equivalent to

```js
import { Agent, routeAgentRequest } from "agents";
```

because the underlying implementation is the same. The fork gives AgentDeploy control over when upstream versions are adopted, so consumers are never forced to track Cloudflare's release cadence.

## Installation

```bash
npm install @agentdeploy-io/agents
```

React bindings are optional (peer dependency). Install them only if you use the React hooks:

```bash
npm install @agentdeploy-io/agents react
```

## Package entry points

| Entry point | Exports | Description |
|---|---|---|
| `@agentdeploy-io/agents` | Core SDK re-exports | Everything from `agents` plus fork metadata |
| `@agentdeploy-io/agents/react` | `useAgent`, `useAgentToolEvents`, `useAgentStatus`, `_testUtils` | React hooks for agent connections and UI state |
| `@agentdeploy-io/agents/vite` | `agents` (upstream plugin), `agentDeploy`, `uiAssets` | Vite plugins for local dev and UI asset serving |
| `@agentdeploy-io/agents/client` | `AgentClient`, `agentFetch`, helpers | WebSocket client utilities |

## Core SDK

The `.` entry point re-exports the full Cloudflare Agents SDK surface:

```typescript
import { Agent, routeAgentRequest } from "@agentdeploy-io/agents";
```

It also exposes fork metadata for diagnostics:

```typescript
import { FORK_NAME, FORK_VERSION, UPSTREAM_VERSION, getForkInfo } from "@agentdeploy-io/agents";

getForkInfo();
// => { fork: "@agentdeploy-io/agents", forkVersion: "0.1.1", upstream: "agents", upstreamVersion: "0.18.0" }
```

## React bindings (`/react`)

Re-exports upstream hooks and adds `useAgentStatus` — a convenience hook that tracks the WebSocket connection lifecycle for UI rendering.

```tsx
import { useAgent, useAgentStatus } from "@agentdeploy-io/agents/react";

function ChatUI() {
  const [{ status, connected, error }, agent] = useAgentStatus({
    agent: "support",
    name: "session-1",
  });

  if (status === "connecting") return <Spinner />;
  if (status === "error") return <ErrorBanner error={error} />;
  return <ChatInterface agent={agent} />;
}
```

`useAgent` and `useAgentToolEvents` behave exactly as in the upstream `agents/react` module.

## Vite plugin (`/vite`)

Wraps the upstream Cloudflare Agents Vite plugin and adds a UI asset server for developing bundled agent UIs locally.

### Upstream plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { agents } from "@agentdeploy-io/agents/vite";

export default defineConfig({
  plugins: [agents()],
});
```

### Combined `agentDeploy(...)` plugin

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { agentDeploy } from "@agentdeploy-io/agents/vite";

export default defineConfig({
  plugins: [agentDeploy({ ui: { uiDir: "./ui", dev: true } })],
});
```

### UI asset server

```ts
// vite.config.ts
import { defineConfig } from "vite";
import { agents, uiAssets } from "@agentdeploy-io/agents/vite";

export default defineConfig({
  plugins: [
    agents(),
    uiAssets({ uiDir: "./ui", basePath: "/ui", dev: true }),
  ],
});
```

Serves files from the `ui/` directory at `/ui/*` in dev and makes them a Vite build input for production. This powers the UI shells used by `@agentdeploy-io/edge-ui` and the `chat-agent-with-ui` template in `@agentdeploy-io/cli`.

## Client utilities (`/client`)

```ts
import { AgentClient, agentFetch } from "@agentdeploy-io/agents/client";
```

Re-exports the upstream `agents/client` module for connecting to agents over WebSocket.

## Usage with `@agentdeploy-io/edge-sdk`

Most AgentDeploy builders should use `@agentdeploy-io/edge-sdk` directly rather than this package. The SDK builds on this fork and adds:

- `createChatAgent()` / `createAgent()` factories
- Gateway routing for LLM billing and token metering
- Typed secrets access and telemetry

```bash
npm install @agentdeploy-io/edge-sdk
```

If you're building a UI shell or need low-level access to the Agents SDK primitives (routing, WebSockets, scheduling), use `@agentdeploy-io/agents` directly.

## License

MIT — fork of the MIT-licensed [Cloudflare Agents SDK](https://github.com/cloudflare/agents).
