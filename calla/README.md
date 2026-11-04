# Calla

**Human-in-the-loop (HITL) orchestration for multi-agent systems.**

Calla gives a human operator a single manager UI over a fleet of agents running on
two runtimes — Cloudflare edge (Durable Objects + Workflows) and a Mastra brain
(Fly.io). Every risky tool call pauses, surfaces in a unified **Approval Inbox**,
and waits for an explicit approve/decline.

> Full spec: `plans/prd-business-intelligence-agent/06-playground-pivot-to-calla.md`
> Extracted from `packages/edge-ui-playground` (21K lines → 3 screens). The good
> parts were ported (auth, WS protocol client, data-plane APIs); the 17-view
> monolith was replaced by Fleet / Approvals / Agent Detail.

## Architecture

```
┌───────────────────────────────────────────────────────────┐
│  apps/ui — Calla Manager UI (React 19 + Vite + Tailwind)  │
│  Fleet Dashboard · Approval Inbox · Agent Detail          │
└──────────────┬───────────────────────────┬────────────────┘
               │ WS cf_agent_* + /events   │ REST /brain/*
               ▼                           ▼
┌──────────────────────────────┐  ┌──────────────────────────────┐
│ apps/edge — Cloudflare Worker │  │ apps/brain — Mastra on Fly.io │
│ • CallaEdgeAgent (DO, SQLite) │  │ • orchestrator agent          │
│ • CallaEventHub (/events WS)  │  │ • requireApproval HITL tools  │
│ • CallaOrchestrator (roster)  │  │ • suspended-runs REST API     │
│ • CallaApprovalWorkflow       │  │ • suspend/resume workflow     │
└──────────────────────────────┘  └──────────────────────────────┘
               ▲                           ▲
               └── shared/ — @calla/shared canonical types,
                   calla:* event names, zod schemas
```

## Packages

| Package | Path | Deploy target |
|---|---|---|
| `@calla/shared` | `shared/` | npm-internal (types, event names, zod schemas) |
| `@calla/ui` | `apps/ui/` | Cloudflare Pages (`{handle}-calla-console`) |
| `@calla/edge` | `apps/edge/` | Cloudflare Workers (DO + Workflows) |
| `@calla/brain` | `apps/brain/` | Fly.io (Docker, Hono + Mastra) |

## Quick start (local dev)

Requires Node ≥ 20. From `packages/calla`:

```bash
npm install   # once (workspace root)
npm run dev   # one command: shared build + edge (:8787) + brain (:3001) + UI (:5174)
```

Open **http://localhost:5174**. `npm run dev -- --no-brain` skips the Mastra
brain (the UI degrades gracefully). The Vite dev server proxies `/agents`,
`/events`, `/steps`, `/approvals`, `/fleet`, `/state`, `/health`, `/d` → edge
and `/brain` → brain.

<details>
<summary>Manual: three terminals</summary>

```bash
npm run build:shared # shared types must be built first
npm run dev:edge    # wrangler dev → http://127.0.0.1:8787 (DOs, /events WS, workflows)
npm run dev:brain   # Mastra brain  → http://127.0.0.1:3001 (optional; needs ANTHROPIC_API_KEY for LLM calls)
npm run dev:ui      # Vite SPA      → http://localhost:5174
```
</details>

Without auth (`localhost` → `AUTH_DISABLED`), the UI shows the dev fleet:
supervisor, qualifier, researcher, writer, outreach (edge), crawler (core),
jev (classifier), orchestrator (brain).

### Demo the HITL gate (edge)

```bash
# 1. Dispatch a risky step — parks in the Approval Inbox
curl -sX POST localhost:8787/steps/demo-1 -H 'content-type: application/json' \
  -d '{"id":"s1","action":"send-email","params":{"to":"client@example.com"},"requiresApproval":true,"risk":"high"}'

# 2. Watch it arrive live
curl -s localhost:8787/events/recent?limit=5

# 3. Approve (or {"approved":false} to decline)
curl -sX POST localhost:8787/approvals/demo-1/<approvalId>/decision \
  -H 'content-type: application/json' -d '{"approved":true}'
```

The UI Approval Inbox (`/inbox`) unifies four sources: edge `pendingApprovals`
(live over `/events`), Mastra suspended runs (5s poll), core VM tasks awaiting
input, and data-plane review rows (`/d/{id}/cmd/data`).

## Testing against the real engine (bi-edge)

By default the UI's `/d/*` data plane hits the honest empty dev stubs served by
calla-edge (`CALLA_DEV_STUBS=true`). To run against the REAL lead-gen engine
(`packages/bi-edge`) locally:

```bash
npm run dev -- --with-engine        # starts edge + brain + UI + bi-engine (:8792)
node scripts/seed-engine.mjs        # seeds 3 demo leads at pending_review
```

What `--with-engine` does:

- spawns `wrangler dev` for `packages/bi-edge` on **:8792** (state persisted at
  `/tmp/calla-bi-edge-state` — delete it for a clean DB), using the dev entry
  shim `scripts/bi-edge-dev-entry.ts` (workerd rejects bi-edge's `export *`
  worker entry, its DO `transaction()` BEGIN IMMEDIATE, and object-style named
  SQL params — the shim patches all three, dev-only, without touching bi-edge
  source), and reads `packages/bi-edge/.dev.vars` (safe placeholders; copy from
  `.dev.vars.example`).
- passes `CALLA_DATA_PORT=8792` to the UI, so `apps/ui/vite.config.ts` proxies
  `/d/<deploymentId>/*` → `http://127.0.0.1:8792/*` (prefix stripped, `ws:true`
  kept) instead of the calla-edge stubs. Flat lead patches from the UI
  (`{key, status:"approved"}`) are wrapped to bi-edge's `{key, patch:{…}}`
  shape by a dev-only body shim in the same config.

The HITL loop end-to-end (engine defaults: `sendEnabled=false`, `dryRun=true`,
no `BREVO_API_KEY` — **no real email can fire**):

```bash
# 1. Leads visible through the Calla proxy (deploymentId = dev agent id, e.g. "supervisor")
curl -s "http://localhost:5174/d/supervisor/cmd/data?status=pending_review&page=1&pageSize=50"

# 2. Approve like the inbox data-plane does (flat body; proxy wraps it)
curl -sX POST http://localhost:5174/d/supervisor/cmd/data/row \
  -H 'content-type: application/json' \
  -d '{"key":"GB:northgate-plumbing-ltd","stage":"approved","status":"approved"}'

# 3. Gate demo: dry-run needs sendEnabled=true, dryRun stays true
curl -sX POST http://localhost:5174/d/supervisor/cmd/settings \
  -H 'content-type: application/json' -d '{"sendEnabled":"true"}'

# 4. Trigger outreach the way the engine does (supervisor slash command on the DO)
curl -sX POST http://localhost:5174/d/supervisor/cmd/supervisor \
  -H 'content-type: application/json' \
  -d '{"message":"/send GB:northgate-plumbing-ltd"}'
# → {"reply":"Sent to GB:northgate-plumbing-ltd (dry-run)"}

# 5. Verify: sent-log shows [dry-run]; lead moved to stage/status "sent"
curl -sX POST http://localhost:5174/d/supervisor/cmd/supervisor \
  -H 'content-type: application/json' -d '{"message":"/sent"}'
curl -s "http://localhost:5174/d/supervisor/cmd/data/row?key=GB:northgate-plumbing-ltd"

# 6. Restore safe defaults
curl -sX POST http://localhost:5174/d/supervisor/cmd/settings \
  -H 'content-type: application/json' -d '{"sendEnabled":"false"}'
curl -s http://localhost:5174/d/supervisor/cmd/settings
```

Engine mechanics worth knowing:

- Seeds go in via `POST /inbound/sync` (header `X-AD-Sync: <AD_SYNC_SECRET>`,
  body `{leads:[…]}`, max 25). The handler honors caller-supplied `stage` /
  `status`, so `seed-engine.mjs` plants leads directly at
  `researched/pending_review` with pitch + emails pre-filled — no LLM gateway
  needed. The qualifier/researcher/writer stages (`/run`, `/verify`, research
  cron) DO need a live `AD_GATEWAY_BASE_URL` LLM and are not exercisable
  locally with the placeholder `.dev.vars`.
- Outreach has NO cron; it fires only via supervisor commands (`/send`,
  `/test-send`, `/approve`, `/approve-batch`, …) — `POST /cmd/<anything>` with
  `{"message":"/send <key>"}` runs against the Durable Object's persisted DB.
- Send gates (in order): not opted-out/rejected → approved → has pitch → has
  email → MX ok → not paused → `sendEnabled` → daily cap → blacklist/SIC/
  keyword/headcount. With `dryRun=true` a passing gate logs `status:"dry-run"`
  in `sent_log` and moves the lead to `sent` without touching Brevo.

### ⚠️ Enabling REAL email sending (do NOT do this casually)

> **WARNING: the steps below make the engine send REAL email to REAL
> addresses via Brevo. Only for production-style deployments you own.**

1. In `packages/bi-edge/.dev.vars` (local) or via `wrangler secret put`
   (deployed): set `BREVO_API_KEY=<real key>`, `BREVO_SENDER_EMAIL=<verified
   sender>`, `BRAND_NAME=<brand>` (optionally `BRAND_SITE_URL`,
   `CALENDLY_URL` for the email footer).
2. MX/DNS prerequisites: the Brevo sender domain must be authenticated
   (SPF/DKIM configured in Brevo), and lead emails must pass the engine's MX
   check (`mx_ok` in the lead's `emails` JSON — unverified addresses are
   blocked by the gate).
3. Flip BOTH gates (both are required; `dryRun=false` alone still blocks,
   `sendEnabled=false` alone still blocks):

   ```bash
   curl -sX POST http://127.0.0.1:8792/cmd/settings \
     -H 'content-type: application/json' \
     -d '{"sendEnabled":"true","dryRun":"false"}'
   ```

4. Check `dailyCap` (`GET /cmd/settings`) — default 10/day — and the blacklist
   (`/blacklist-list`) before sending.
5. Every real send is logged to `sent_log` with the Brevo `messageId`
   (`/sent`); failures are logged as `failed:<reason>`.

## The three screens

| Screen | Route | Purpose |
|---|---|---|
| Fleet Dashboard | `/` | All agents (edge + core + brain + classifier), live status, pending-approval counts, live event feed |
| Approval Inbox | `/inbox` | Unified HITL: risk badges, expiry countdown, approve / decline / edit-&-approve, j/k/a/r keyboard flow |
| Agent Detail | `/agents/:id/:tab?` | Chat (edge WS streaming or brain NDJSON), live DO state, per-agent approvals, inline tool-call approvals |

## Deployment

- **UI** — marketplace one-click: `apps/ui/scripts/deploy.mjs` (env: `BUYER_HANDLE`,
  `AGENT_BACKEND_URL`, `BRAIN_URL`, `CF_ACCOUNT_ID`, `CF_API_TOKEN`). Manual:
  `npm run deploy -w @calla/ui`.
- **Edge** — `npm run deploy -w @calla/edge` (wrangler; DO migrations + workflow
  binding declared in `wrangler.jsonc`).
- **Brain** — `fly launch && fly deploy` from `apps/brain` (Dockerfile builds
  shared + brain; secrets: `ANTHROPIC_API_KEY`, `DATABASE_URL`, `CALLA_TOKEN`,
  `CALLA_EDGE_URL`). Falls back to LibSQL storage when `DATABASE_URL` is unset.

## Real-time reliability (WS lifecycle)

All UI sockets run through `WsLifecycleManager` (`apps/ui/src/lib/ws-lifecycle.ts`)
— one ref-counted socket per URL (no duplicates across hooks/StrictMode):

- full-jitter exponential backoff, never gives up (60s slow-poll ceiling)
- heartbeat: raw-text `calla:ping` → answered by the DO **auto-response**
  (no Durable Object wake); server `calla:heartbeat` via DO **alarm** every 25s
- outbound queue while down (FIFO flush on reopen, drop-oldest at 100)
- fresh auth token per attempt (URL provider re-invoked — 5-min edge JWT safe)
- `online`/`visibilitychange` triggers, zombie detection, flapping detection
- **cursor gap-fill**: every hub frame carries a monotonic `id`; reconnects use
  `?since=<cursor>` so nothing is missed or duplicated across deploys/drops
- stats: `getStats()` → rtt, attempts, queue depth, close codes

## Audit & governance

- **Edge** (`CallaEventHub` SQLite): hash-chained audit log
  (`GENESIS → prev_hash → entry_hash`), written on every approval
  request/decision/expiry and step execution. `GET /audit?limit=&agentId=&kind=`,
  `GET /audit/verify` → `{valid, count, broken_at?}`.
- **Brain** (Drizzle-style `calla_*` tables — Postgres in prod, LibSQL in dev,
  presence-driven adapter): approval history (`GET /approvals`), agent registry,
  hash-chained audit (`GET /audit`, `GET /audit/verify`), and an **evaluator
  pipeline** (ElizaOS pattern): post-response `run.completed` audit +
  `risk.flagged` classification, two-phase validate → parallel handlers.
- Patterns adapted from `@elizaos/plugin-sql`, `@elizaos/core` (Evaluator), and
  `@thirtieth/elizaos-plugin-cloudflare` (hash-chain audit) — all MIT, attributed
  in source headers.

## Self-hosted login (standalone auth)

No agentdeploy.io infrastructure required. The brain issues its own HS256 JWTs:

```bash
# brain + edge must share the same secret:
CALLA_JWT_SECRET=$(openssl rand -hex 32)
```

- First run: the UI Login page shows **"Create admin account"**
  (`POST /brain/auth/register` works only while zero users exist)
- Login → JWT in `localStorage.calla_jwt` → attached as `Bearer` on all API
  calls and `?token=` on WebSockets; the edge worker verifies the same JWTs
  on `/steps`, `/approvals`, `/state`, `/fleet`, `/audit`, `/events`
- Enable in the UI via `AUTH_MODE: "standalone"` in `runtime-config.js`
  (or `VITE_AUTH_MODE=standalone`; also auto-selected off-localhost when
  `MARKETPLACE_URL` is empty/`self`/`none`)
- scrypt password hashing, rate-limited login, auth events in the audit chain

## Telegram / WhatsApp (approvals on the move)

Set `TELEGRAM_BOT_TOKEN` (and/or `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID`)
on the brain — channels self-enable. Bind your chat:

```bash
curl -X POST -H "Authorization: Bearer $JWT" localhost:3001/channels/bindings/code
# → {"code":"0NPHM9"}   then send "/start 0NPHM9" to your bot
```

- **Chat**: plain messages go to the orchestrator; `/status`, `/approvals`, `/help`
- **HITL push**: pending approvals arrive live as cards with Approve/Decline
  buttons (Telegram inline keyboard, WhatsApp reply buttons); decisions are
  hash-chain audited (`via: "channel:<platform>"`)
- Telegram works locally with **long-polling** (no webhook tunnel needed);
  WhatsApp uses the Cloud API webhook with HMAC signature verification
- Full guide: `apps/brain/src/channels/README.md`

## Reddit outreach (reddit-mcp sidecar)

Reddit posting/replying runs through the
[jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server)
sidecar (streamable-HTTP MCP). The sidecar holds the Reddit credentials and the
anti-spam safety rails (safe-mode write pacing, duplicate + cross-subreddit
detection, bot-disclosure footer); the brain talks to it over MCP
(`apps/brain/src/channels/social/reddit-mcp.ts`, enabled by `REDDIT_MCP_URL`).

**Local dev** (no Docker; npx runs the sidecar, credentials via shell env):

```bash
export REDDIT_CLIENT_ID=... REDDIT_CLIENT_SECRET=...     # Reddit OAuth app
export REDDIT_USERNAME=... REDDIT_PASSWORD=...           # account that posts (writes only)
npm run dev -- --with-reddit-mcp                          # sidecar on :3011, brain gets REDDIT_MCP_URL
```

**Docker** (any host; bearer-protected):

```bash
# .env next to docker-compose.reddit.yml: REDDIT_MCP_TOKEN, REDDIT_* credentials
docker compose -f docker-compose.reddit.yml up -d
# brain: REDDIT_MCP_URL=http://<host>:3011/mcp  REDDIT_MCP_TOKEN=<token>
```

**Smoke test** (read path is safe; the write probe publishes a deletable post):

```bash
npx tsx scripts/reddit-mcp-smoke.ts                  # health, tools, config, browse
REDDIT_SMOKE_WRITE=1 npx tsx scripts/reddit-mcp-smoke.ts   # + create_post + reply
```

⚠️ Reddit is closing its public API: new self-serve OAuth stopped 2025-11,
unregistered apps are removed **2027-01-12**, full shutdown March 2027.
Register the app at developers.reddit.com/app-registration. Without
`REDDIT_USERNAME`/`REDDIT_PASSWORD` the sidecar is read-only.

## Verification

```bash
npm run typecheck   # all four workspaces
npm run build       # shared → ui → brain
npm run build -w @calla/edge   # wrangler dry-run bundle
```
