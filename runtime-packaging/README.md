# Runtime Packaging — Multi-Framework Agent Runtimes

**Status:** v1 · 2026-08-22
**Companion docs:** `RUNTIME_CONTRACT.md` (the protocol), `PRD_HYBRID_EDGE_CORE_PACKAGING.md` (§5.2 GA matrix), `PRD_LONG_RUNNING_AGENTS_HERMES.md`

---

## What this is

A packaging standard that makes **any** agent framework deployable as an AgentDeploy core runtime: Hermes, n8n, Mastra, OpenHands, DeepSeek Harness, OpenClaw — and, via the bring-your-own pattern, LangChain/LangGraph/CrewAI agents built by sellers.

The insight: most frameworks already publish official Docker images and expose HTTP natively. The variance across all of them reduces to three axes — invocation style, state location, secret delivery. So instead of N integrations we built **one generic supervisor shim + a tiny adapter interface**.

## Architecture

```
┌───────────────────────────────────────────────┐
│ Fly VM (1 per tenant)                         │
│  ┌──────────────────┐   ┌──────────────────┐  │
│  │ Shim (:8080)     │──▶│ Framework        │  │
│  │ contract endpoints│   │ (n8n :5678, etc.)│  │
│  │ heartbeats       │   └──────────────────┘  │
│  │ checkpoints      │   /data volume          │
│  │ budget counting  │   /data/checkpoints/    │
│  └────────┬─────────┘                          │
└───────────┼─────────────────────────────────────┘
            │ AD_BROKER_TOKEN + telemetry
            ▼
   deployment-service (/v1/broker, /v1/telemetry)
```

Adding a framework = one adapter object (~40 lines):

```ts
registerAdapter("myruntime", () => ({
  name: "myruntime",
  invocation: "server",              // or "cli"
  command: ["myagent", "serve"],
  port: 3000,
  healthPath: "/health",
  checkpointPaths: ["/workspace/.state"],
  secretEnvMapping: { OPENAI_API_KEY: "OPENAI_API_KEY" },
}));
```

## Built-in adapters

| Adapter | Style | Framework port | Checkpoint paths | Tier |
|---|---|---|---|---|
| `hermes` | cli | — (shim only) | `/root/.hermes` | 2 |
| `n8n` | server | 5678 (`/healthz`) | `/home/node/.n8n` | 1 |
| `mastra` | server | 4111 (`/health`) | `/workspace/.mastra` | 1 |
| `openhands` | server | 3000 (`/health`) | workspace + config | 1 |
| `deepseek-harness` | cli | — | `/workspace/.harness` | 2 |

## Usage

### Local development (no Docker needed)
```bash
cd packages/runtime-packaging
npx tsc
# Boot the shim with any adapter; degrade gracefully without platform env:
PORT=8080 RUNTIME_NAME=hermes node dist/shim.js
```

### Conformance gate (mechanical GA check)
```bash
# against a running container:
RUNTIME_CONTRACT_URL=http://localhost:18080 RUNTIME_NAME=hermes \
  npx tsx scripts/conformance.ts
# exit 0 = contract-compliant → eligible for marketplace listing
```
Checks C1–C7: health, enqueue valid/invalid, detail + monotonic transitions, cancel→terminal ≤60s, checkpoint acceptance, status shape. (C8 heartbeat delivery verifies via control plane when wired.)

### Full H4 gate (build → push → verify)
```bash
node scripts/runtime-gate.mjs --runtime hermes           # build + local conformance
node scripts/runtime-gate.mjs --runtime hermes --push    # + push to GHCR
node scripts/runtime-gate.mjs --runtime hermes --push --deploy \
  --tag ghcr.io/agentdeploy/hermes-runtime:1.0           # + live Fly conformance (--deploy needs GATE_FLY_URL etc.)
```

### Registry sync
```bash
DIRECTUS_URL=... DIRECTUS_ADMIN_TOKEN=... \
  node deployment-service/scripts/seed-core-runtimes.mjs
# Registers/updates all 5 runtimes in core_runtimes with image refs.
# RUNTIME_IMAGE_PREFIX=ghcr.io/yourorg to override the org.
```

## CI

`.github/workflows/runtime-packaging.yml`:
- **test** — typecheck + adapter registry load (every PR/push)
- **gate** — matrix build + local conformance for hermes/n8n/mastra (every change)
- **publish** — on main: GHCR push with sha+latest tags, optional production registry sync (needs `GHCR_TOKEN`; optionally `DIRECTUS_URL`/`DIRECTUS_ADMIN_TOKEN` secrets)

## Adding a new framework

1. New file `src/adapters/<name>.ts` — registerAdapter(...) with command/port/paths/mapping (+ `interpretExit` for CLI style, `delegateTask` for server style)
2. Import it in `src/adapters/index.ts`
3. Dockerfile variant (usually `FROM <official-image>` + copy shim)
4. Add row to the CI matrix + `seed-core-runtimes.mjs` catalog
5. Run the gate → listable

## Bring-your-own (seller path)

Sellers wanting LangChain/LangGraph/CrewAI agents: template repo with a minimal HTTP wrapper exposing `/health` + task semantics, packaged per the shim's expectations. Platform-side this is just another `core_runtimes` row with the seller's image ref. Documented pattern TBD as a seller-facing guide (post-MVP).

## Known gaps

- Server-style runtimes without `delegateTask` accept tasks but report them running indefinitely — buyers drive via the framework's native UI through the console proxy. Fine for editors (n8n), weak for autonomous use.
- Token usage capture is adapter-dependent (Mastra reports it; n8n doesn't) — budget fence on tokens is advisory there; VM-hour fence always applies.
- Checkpoint size vs the 512MB cap is enforced post-hoc (prune oldest); pre-flight estimation would be nicer.
- Windows/macOS dev: checkpoint root defaults to `/data/checkpoints`; set `CHECKPOINT_DIR` locally.
