# @calla/edge — Cloudflare edge worker

The Cloudflare Workers + Durable Objects half of **Calla** (HITL orchestration
for multi-agent systems). It runs cheap, isolated edge step-tasks, owns the
**human-in-the-loop approval gates** for those tasks, fans every state change
out over a WebSocket event bus, and keeps a live fleet roster.

Built on the [Cloudflare Agents SDK](https://github.com/cloudflare/agents)
(`agents@0.25`) + Cloudflare Workflows. **No AI/model calls live in this
worker** — it stays dependency-light. (Chat lights up for free later if an `AI`
binding is added; see `Env.AI`.)

---

## Architecture

| Component | Kind | Binding / name | Role |
|---|---|---|---|
| `CallaEdgeAgent` | Durable Object (Agent) | `CALLA_EDGE_AGENT` | One DO per edge agent. Executes steps, owns HITL gates. |
| `CallaEventHub` | Durable Object (plain, hibernation API) | `CALLA_EVENTS` (name `hub`) | WebSocket event bus: SQLite ring buffer (last 500 frames, monotonic ids), cursor replay, per-socket channel filters, alarm heartbeat, hash-chained audit log. |
| `CallaOrchestrator` | Durable Object (Agent) | `CALLA_ORCHESTRATOR` (name `fleet`) | Fleet roster: register / heartbeat / list. |
| `CallaApprovalWorkflow` | Workflow | `CALLA_APPROVAL_WORKFLOW` (`calla-approval-workflow`) | Durable timer that expires an undecided gate. |

```
                       ┌───────────────────────────────┐
   UI / jev / curl     │        calla-edge worker       │
        │              │                                │
        │  WS /events  │   CallaEventHub (bus + ring)   │◀── publish (RPC)
        ├─────────────▶│                                │        ▲
        │              └───────────────────────────────┘        │
        │  HTTP /steps, /approvals, /state, /fleet               │
        ├─────────────▶ CallaEdgeAgent ─── setState ──▶ WS broadcast (/agents)
        │                    │  create()                          │
        │                    ▼                                    │
        │            CallaApprovalWorkflow ── sleep ──▶ expireApprovalIfPending (RPC)
        │                                                             │
        └── WS /agents/calla-edge-agent/:name  (Agents SDK RPC/state)─┘
```

---

## Local dev

```bash
# from the calla workspace root (packages/calla)
npm run dev -w @calla/edge          # wrangler dev on http://127.0.0.1:8787
```

The Manager UI (`apps/ui`, vite) proxies these prefixes to the edge worker on
`:8787`:

| vite proxy | edge route |
|---|---|
| `/agents` (ws) | Agents SDK WS/RPC protocol |
| `/events` (ws) | Calla event bus WebSocket |
| `/health` | health check |
| `/d` (ws) | per-deployment console (not served by this worker yet) |

The JSON convenience routes below (`/steps`, `/state`, `/approvals`, `/fleet`,
`/events/ingest`, `/events/recent`) are reachable directly on `:8787`. If the UI
wants to call them through the vite origin, add proxy entries for those prefixes
in `apps/ui/vite.config.ts` — or drive the agent over the already-proxied
`/agents` WebSocket RPC.

Other scripts:

```bash
npm run typecheck -w @calla/edge    # tsc --noEmit
npm run build     -w @calla/edge    # wrangler deploy --dry-run --outdir dist
npm run deploy    -w @calla/edge    # wrangler deploy
```

### Env vars / secrets (all optional)

| Name | Purpose |
|---|---|
| `CALLA_JWT_SECRET` | Shared HMAC secret for **user** JWTs (HS256) issued by the brain. Set to the SAME value as the brain's `CALLA_JWT_SECRET`. When set, user routes (`/steps`, `/approvals`, `/state`, `/fleet`, `/audit*`, `/events`, `/events/recent`) require a valid Calla JWT via `Authorization: Bearer <jwt>` or `?token=<jwt>`. **Unset ⇒ no user JWT required.** |
| `EVENTS_AUTH_TOKEN` | Shared **service** secret for machine relays (jev classifier / brain). Primarily gates `POST /events/ingest` (`x-calla-token` header or `?token=`). Also still accepted on the user routes above for backward compatibility. **Unset ⇒ open (local dev).** |
| `CALLA_EDGE_URL` | Public base URL of this worker (for absolute callback links). |
| `ENVIRONMENT` | Label echoed by `GET /` (e.g. `production`). |
| `AI` | Optional Workers AI binding (unused today; enables SDK chat later). |

Set a secret with: `wrangler secret put CALLA_JWT_SECRET` (from `apps/edge`).

#### Security model: user JWT vs service token

Self-hosted (standalone) Calla uses **two independent credentials**:

- **User JWT** (`CALLA_JWT_SECRET`) — a short-lived HS256 token the brain mints
  at `/auth/login` (email + password, scrypt). The SPA sends it as
  `Authorization: Bearer <jwt>` on HTTP and `?token=<jwt>` on the `/events`
  WebSocket. The worker verifies it with the same shared secret
  (`verifyCallaToken` from `@calla/shared`, jose/WebCrypto — identical routine
  the brain uses). This protects every user-facing route.
- **Service token** (`EVENTS_AUTH_TOKEN`) — a long-lived shared secret for
  server-to-server relays that have no user context (e.g. the jev classifier
  posting to `/events/ingest`). It is NOT a user credential.

If neither secret is set the worker is fully open (local dev). `/health`, `/`,
and `OPTIONS` are always open.

---

## HTTP endpoints

CORS is permissive on every response (`Access-Control-Allow-Origin: *`; methods
`GET, POST, OPTIONS`; headers `content-type, authorization, x-calla-token`), so
the SPA can call `*.workers.dev` cross-origin. `OPTIONS` returns `204`.

| Method | Path | Auth | Body | Returns |
|---|---|---|---|---|
| `GET` | `/health` | — | — | `{ ok, service:"calla-edge", ts }` |
| `GET` | `/` | — | — | route index + config summary |
| `GET` | `/events?since=<id>` | user JWT² | — | **101 WebSocket** upgrade to the event bus (`since` = replay cursor) |
| `GET` | `/events/recent?limit=50&since=<id>` | user JWT² | — | `{ frames: CallaWsFrame[], since, count }` — ring-buffer tail, or cursor gap-fill when `since` is given (oldest-first) |
| `POST` | `/events/ingest` | `x-calla-token`¹ | `{ type, agentId?, payload? }` | `{ ok, id, type, ts }` — publishes one frame (audited as `event.ingested`) |
| `GET` | `/audit?limit=100&agentId=&kind=` | user JWT² | — | `{ entries: AuditRow[], count }` — hash-chained audit trail (oldest-first) |
| `GET` | `/audit/verify` | user JWT² | — | `{ valid, count, broken_at? }` — recomputes every hash in the chain |
| `GET` | `/fleet` | user JWT² | — | `{ agents: FleetRosterEntry[] }` |
| `POST` | `/steps/:agentName` | user JWT² | `CallaStep` | `StepResult` |
| `GET` | `/state/:agentName` | user JWT² | — | `{ agentName, state: CallaState }` |
| `POST` | `/approvals/:agentName/:approvalId/decision` | user JWT² | `{ approved, updatedArgs? }` | `StepResult` |
| `ANY` | `/agents/:binding/:name` | — | — | Agents SDK WS/RPC (see below) |

¹ `EVENTS_AUTH_TOKEN` service token; only enforced when it is set.
² Requires a valid Calla user JWT when `CALLA_JWT_SECRET` is set (or the
  `EVENTS_AUTH_TOKEN` service token as a legacy fallback). Open when neither is
  configured. Unauthorized HTTP returns `401 { error: "unauthorized" }`; the
  `/events` WebSocket upgrade is accepted then closed with `4001`.


Request/response bodies are validated with the zod schemas in `@calla/shared`
(`callaStepSchema`, `approvalDecisionSchema`). Invalid bodies return `400` with
`{ error, issues }`.

### Agents SDK WebSocket route

`routeAgentRequest` maps the **kebab-cased binding name** into the URL:

| Binding | WS/HTTP path |
|---|---|
| `CALLA_EDGE_AGENT` | `/agents/calla-edge-agent/:name` |
| `CALLA_ORCHESTRATOR` | `/agents/calla-orchestrator/:name` (roster lives at name `fleet`) |

The UI uses the `useAgent` hook against these paths for live `CallaState` sync
and `@callable` RPC. Example:

```ts
import { useAgent } from "agents/react";
const agent = useAgent<CallaState>({ agent: "calla-edge-agent", name: "demo-1" });
// agent.state  → live CallaState (setState broadcasts)
// await agent.approvePendingAction({ approvalId, updatedArgs })
```

---

## `/events` frame format

Every frame on the bus is a `CallaWsFrame` (from `@calla/shared`):

```jsonc
{
  "type": "calla:approval:request",   // event or control name
  "id": "1284",                       // hub-assigned monotonic id = replay cursor
  "agentId": "demo-1",                // optional
  "deploymentId": "…",                // optional
  "payload": { /* … */ },             // event-specific
  "ts": 1730000000000                 // epoch ms (stamped by the hub)
}
```

`id` comes from the hub's SQLite ring-buffer rowid, so it is **monotonic per hub**
and identical for the live broadcast and any later replay of the same frame.
Clients should track the highest `id` they processed and send it back as
`?since=<id>` on reconnect (or `subscribe.since`) to gap-fill. Control/liveness
frames (`calla:hello`, `calla:heartbeat`) carry **no** `id`.

**Control frames** (`CALLA_CONTROL`):

| type | direction | shape | notes |
|---|---|---|---|
| `calla:hello` | server → client | JSON | first frame on connect; payload `{ hub, replay, since, ping, pong, heartbeatMs, maxConnections }` |
| `calla:ping` | client → server | **raw text** | `"calla:ping"` — answered by the DO auto-response pair *without waking the hub* |
| `calla:pong` | server → client | **raw text** | `"calla:pong"` — exact text, not a JSON frame |
| `calla:subscribe` | client → server | JSON | `{ type, channels?, since? }` — scopes delivery and gap-fills the cursor |
| `calla:heartbeat` | server → client | JSON | `{ lastId, connections }`, every 25s from the DO alarm |

**Event frames** (`CALLA_EVENTS`) and their payloads:

| type | payload | emitted by |
|---|---|---|
| `calla:agent:state` | `FleetRosterEntry` | Orchestrator (on register/heartbeat) |
| `calla:approval:request` | `ApprovalRequest` | EdgeAgent (gate opened) |
| `calla:approval:resolved` | `{ id, status, stepId }` (`status`: `approved`/`declined`/`expired`) | EdgeAgent / workflow |
| `calla:error` | `{ stepId, error }` | EdgeAgent (step threw), hub (bad `calla:subscribe`) |
| `calla:heartbeat` | `{ lastId, connections }` | Hub alarm (liveness) |
| `calla:tool:call`, `calla:message`, `calla:classification:completed` | free-form | external services via `POST /events/ingest` |

On connect the hub sends `calla:hello` then replays: **the last 50** buffered
frames by default, or — when the upgrade URL carries `?since=<id>` — only the
frames with `id > since` (capped at 500). The ring buffer retains the last
**500** frames in SQLite (`events(id, frame, ts)`).

---

## Heartbeat contract (free pings + alarm liveness)

Two independent heartbeats, neither of which keeps the Durable Object awake:

**1. Client → hub (free, runtime-answered).** Before `acceptWebSocket`, the hub
registers an exact-string auto-response pair:

```ts
this.ctx.setWebSocketAutoResponse(
  new WebSocketRequestResponsePair(CALLA_PING_TEXT, CALLA_PONG_TEXT),
);
```

So the client **must send the raw text `calla:ping`** (exactly `CALLA_PING_TEXT`
from `@calla/shared` — *not* `{"type":"calla:ping"}`) and will receive the raw
text `calla:pong`. The Workers runtime answers it inline: the DO is never woken,
so a 20s keep-alive from 1000 clients costs zero DO invocations.

A JSON `{"type":"calla:ping"}` frame cannot be matched by the exact-string
auto-response; it wakes the DO, which tolerates it and replies with the same raw
`calla:pong` text. Correct, but billed — prefer the raw text.

> In `wrangler dev` the local runtime may still wake the DO for auto-responded
> pings. The contract is identical; only the local billing/wake behaviour differs.

**2. Hub → clients (alarm-driven).** `alarm()` broadcasts
`{ type:"calla:heartbeat", payload:{ lastId, connections } }` to every socket and
then reschedules itself — `storage.setAlarm(Date.now() + 25000)` — **only while
`getWebSockets().length > 0`**. The alarm is armed on the first accepted
connection and cancelled (`storage.deleteAlarm()`) when the last socket closes, so
an idle hub hibernates and costs nothing. `setInterval` is deliberately never
used: it pins the isolate and blocks hibernation.

`lastId` is the newest ring-buffer id, so a client that missed frames while
backgrounded can reconnect with `?since=<lastId>`. Heartbeats bypass subscription
filters — they are liveness, not data.

---

## Cursor replay (`?since=`)

| Where | Cursor source | Behaviour |
|---|---|---|
| `GET /events?since=<id>` | upgrade URL | after `calla:hello`, replay frames with `id > since` (cap **500**) |
| `GET /events?since=` absent / unparseable | — | replay the last **50** frames (default late-joiner behaviour) |
| `calla:subscribe { since }` | client frame | immediately gap-fill `id > since` (cap 500) through the new channel filter |
| `GET /events/recent?since=<id>&limit=` | query | same gap-fill over HTTP: `{ frames, since, count }` |

Recommended client loop: persist `maxId` from every received frame → on
reconnect use `?since=maxId` → dedupe is unnecessary because ids are monotonic
and gap-fill is exclusive (`id > since`).

---

## Subscriptions (channel filtering)

Send one JSON frame after `calla:hello`:

```jsonc
{ "type": "calla:subscribe", "channels": ["buyer-bi", "calla:approval:request"], "since": "1284" }
```

- `channels` matches when **`frame.agentId ∈ channels` OR `frame.type ∈ channels`**.
- The filter is stored on the socket with `ws.serializeAttachment({channels, since})`,
  so it **survives Durable Object hibernation** — no need to re-subscribe after the
  hub evicts, and the runtime still auto-answers pings.
- **No attachment = firehose.** Clients that never subscribe receive every frame
  (back-compat with the original single-global-bus behaviour).
- Re-subscribing replaces the previous filter; `channels: []`/omitted restores the
  firehose. An invalid frame is rejected with a `calla:error`
  `{ error:"invalid_subscribe", issues }`.
- `subscribe.since` gap-fills immediately (through the new filter) so a client can
  change scope without losing frames.

---

## Connection cap & close codes

| Condition | Close code | Reason | Client action |
|---|---|---|---|
| Hub at `MAX_CONNECTIONS` (**1000**) | `1013` (`CALLA_WS_CLOSE.overCapacity`) | `over capacity` | reconnect with backoff |
| `EVENTS_AUTH_TOKEN` set, token missing/invalid on the upgrade | `4001` (`CALLA_WS_CLOSE.unauthorized`) | `unauthorized` | re-auth, then reconnect with a fresh `?token=` URL |
| Hub-side socket failure | `1011` | `internal error` | reconnect |

Both rejections use the standard Workers idiom — complete the handshake, then
close immediately, so the client observes a real close code instead of an opaque
HTTP error:

```ts
const { 0: client, 1: server } = new WebSocketPair();
server.accept();
server.close(CALLA_WS_CLOSE.overCapacity, "over capacity");
return new Response(null, { status: 101, webSocket: client });
```

Plain (non-upgrade) HTTP requests to a secured route still get `401` JSON. Every
close is logged (`code`, `reason`, `wasClean`, remaining sockets) and shows up in
`wrangler tail`.

---

## Audit trail (hash-chained)

Append-only, tamper-evident log in the hub's SQLite, alongside the ring buffer:

```sql
CREATE TABLE IF NOT EXISTS audit (
  seq        INTEGER PRIMARY KEY AUTOINCREMENT,
  ts         INTEGER NOT NULL,
  agent_id   TEXT,
  kind       TEXT NOT NULL,
  entry      TEXT NOT NULL,   -- canonical JSON (keys sorted recursively)
  prev_hash  TEXT NOT NULL,   -- previous row's entry_hash, or "GENESIS"
  entry_hash TEXT NOT NULL
);
```

**Hash formula** (writer and verifier share one code path):

```
entry_hash = sha256hex(JSON.stringify({ ts, agentId, kind, entry, prev_hash }))
```

with `entry` in canonical form (object keys sorted recursively), `agentId` =
`null` when absent, and `prev_hash` = `"GENESIS"` for the first row. Because the
Durable Object serializes input events, read-tail → hash → insert is atomic:
there is a single writer, so no locking or CAS is needed. Editing or deleting any
row invalidates every hash after it — `GET /audit/verify` reports the first
broken `seq`.

**Kinds** written by this worker:

| kind | written by | entry |
|---|---|---|
| `approval.requested` | `CallaEdgeAgent.requestApproval` | `{ approvalId, step:{id,action}, risk, timeoutMs }` |
| `approval.decided` | `approvePendingAction` / `declinePendingAction` | `{ approvalId, approved, stepId, action, updatedArgs? }` |
| `approval.expired` | `expireApprovalIfPending` (workflow callback) | `{ approvalId, stepId, action, requestedAt }` |
| `step.executed` | completed sandbox run | `{ stepId, action, approvalId, completedAt }` |
| `event.ingested` | `POST /events/ingest` | `{ type, frameId }` |

Audit writes are **best-effort**: every call site is wrapped in try/catch so a
failed append can never fail the approval, step, or ingest it describes.

```bash
curl -s "$EDGE/audit?limit=10"                       # newest 10 rows, oldest-first
curl -s "$EDGE/audit?agentId=demo-1&kind=approval.decided"
curl -s "$EDGE/audit/verify"                         # → {"valid":true,"count":42}
```

`AuditRow` = `{ seq, ts, agent_id, kind, entry, prev_hash, entry_hash }`.

> Hash-chain layout adapted from `elizaos-plugin-cloudflare` (MIT, (c) 2026
> thirtieth).

---

## Durable Object RPC surface (the contract)

All `@callable` methods are reachable two ways: (a) over the Agents SDK
WebSocket RPC at `/agents/:binding/:name`, and (b) as native DO RPC from the
worker / other DOs / the workflow (`env.<BINDING>.getByName(name).<method>()`).

### `CallaEdgeAgent` — `CALLA_EDGE_AGENT`, one per `:name`

| Method | Params | Returns |
|---|---|---|
| `executeStep` | `step: CallaStep` | `Promise<StepResult>` |
| `approvePendingAction` | `{ approvalId: string; updatedArgs?: Record<string, unknown> }` | `Promise<StepResult>` |
| `declinePendingAction` | `{ approvalId: string }` | `Promise<StepResult>` |
| `getState` | — | `Promise<CallaState>` |
| `expireApprovalIfPending` | `{ approvalId: string }` | `Promise<{ approvalId; expired: boolean; status }>` — **called by the workflow** |
| `delegateToSubAgent` | `(cls, name, work)` | spawns a co-located sub-agent (helper, not RPC-exposed) |

`CallaStep` = `{ id, action, params, requiresApproval, risk?, timeoutMs? }`.

`StepResult` is a discriminated union on `status`:
`completed {stepId,output}` · `awaiting_approval {stepId,approvalId}` ·
`declined {stepId,approvalId}` · `expired {stepId,approvalId}` ·
`failed {stepId,error}`.

`CallaState` = `{ status, currentTask, pendingApprovals[], completedSteps[] }`.

### `CallaOrchestrator` — `CALLA_ORCHESTRATOR`, name `fleet`

| Method | Params | Returns |
|---|---|---|
| `registerAgent` | `{ id, name, type, capabilities?, status?, meta? }` | `Promise<FleetRosterEntry>` |
| `heartbeat` | `{ id, status? }` | `Promise<FleetRosterEntry \| null>` |
| `listFleet` | — | `Promise<FleetRosterEntry[]>` |

`FleetRosterEntry` = `{ id, name, type, capabilities[], status, registeredAt, lastHeartbeat, meta? }`.

### `CallaEventHub` — `CALLA_EVENTS`, name `hub`

| Method | Params | Returns |
|---|---|---|
| `publish` | `frame: CallaWsFrame` | `Promise<CallaWsFrame>` — stamps monotonic `id` + `ts`, persists, broadcasts to matching sockets, returns the stamped frame |
| `recent` | `limit?: number` (default 50, max 500) | `CallaWsFrame[]` (oldest-first) |
| `recentSince` | `since: string \| undefined`, `limit?: number` (default/max 500) | `CallaWsFrame[]` with `id > since`, oldest-first; falls back to `recent(limit)` when `since` is blank/unparseable |
| `appendAudit` | `{ agentId?, kind, entry: Record<string, unknown> }` | `Promise<{ seq, entry_hash }>` — appends one hash-chained row |
| `getAudit` | `{ limit?=100, agentId?, kind? }` | `AuditRow[]` (newest `limit` rows, oldest-first) |
| `verifyAudit` | — | `Promise<{ valid, count, broken_at? }>` — recomputes the whole chain |
| `alarm` | — (DO alarm handler) | broadcasts `calla:heartbeat`, reschedules +25s while sockets are attached |

`AuditKind` = `"approval.requested" | "approval.decided" | "approval.expired" |
"step.executed" | "event.ingested"` (exported from `agents/event-hub.ts`).

### `CallaApprovalWorkflow` — `CALLA_APPROVAL_WORKFLOW`

Started internally by `CallaEdgeAgent` via
`env.CALLA_APPROVAL_WORKFLOW.create({ id: "approval-<approvalId>", params })`
with `params = { agentName, approvalId, timeoutMs }`. It sleeps for the (24h-
capped) window, then calls `expireApprovalIfPending` on the owning agent.

---

## How approvals flow (edge path, spec §5 steps 3′–9′)

1. **Trigger** — `POST /steps/:agentName` with `requiresApproval: true`
   (or an SDK `executeStep(step)` RPC).
2. **Gate opens** — the agent appends a `PendingApproval`
   (`{ id, step, requestedAt, risk, status:"pending" }`), sets
   `CallaState.status = "awaiting_approval"`, and `setState()` broadcasts the
   new state to any connected UI over `/agents`.
3. **Announce** — it publishes a `calla:approval:request` frame (payload =
   `ApprovalRequest`, `source:"cloudflare"`, `expiresAt = requestedAt + timeoutMs`)
   to the hub, so the unified Approval Inbox sees it even without an agent socket.
4. **Arm the timer** — it starts `CallaApprovalWorkflow` with
   `{ agentName, approvalId, timeoutMs }`. (Best-effort: wrapped in try/catch so
   the gate still works in local dev if Workflows are unavailable.)
5. **Return** — `executeStep` resolves to
   `{ status:"awaiting_approval", stepId, approvalId }`.
6. **Human decides** — either:
   - **HTTP convenience:** `POST /approvals/:agentName/:approvalId/decision`
     with `{ approved: true, updatedArgs? }` or `{ approved: false }`, or
   - **WS RPC:** `agent.approvePendingAction({ approvalId, updatedArgs? })` /
     `agent.declinePendingAction({ approvalId })` over `/agents`.
7. **Approve** → status flips to `running`, `calla:approval:resolved
   {status:"approved"}` is published, the step runs in the sandbox with
   `updatedArgs` merged into `step.params`, the result is appended to
   `completedSteps`, status settles to `idle`, and the RPC returns
   `{ status:"completed", stepId, output }`.
   **Decline** → status → `idle`, `calla:approval:resolved {status:"declined"}`,
   returns `{ status:"declined", stepId, approvalId }`.
8. **Timeout** → if the window elapses with no decision, the workflow calls
   `expireApprovalIfPending({ approvalId })`: the gate is marked `expired` and
   `calla:approval:resolved {status:"expired"}` is published. (No-op if already
   decided.)
9. **Audit** → every transition above also appends a row to the hub's
   hash-chained audit log: `approval.requested` (step 3), `approval.decided`
   (step 7), `approval.expired` (step 8), and `step.executed` when the sandbox
   run completes. Appends are best-effort — they can never fail the gate.

> The sandbox runner (`CallaEdgeAgent.runInSandbox`) is a **placeholder** that
> echoes `{ echo, params, ranAt }`. It is the single integration point for the
> real isolated runtime (Cloudflare Sandbox / Containers / Code Mode).

---

## Demo with curl

```bash
EDGE=http://127.0.0.1:8787

# 1) Trigger a gated step on edge agent "demo-1"
curl -sX POST "$EDGE/steps/demo-1" \
  -H 'content-type: application/json' \
  -d '{
        "id": "step-1",
        "action": "sendExternalEmail",
        "params": { "to": "someone@acme.com", "subject": "Hi" },
        "requiresApproval": true,
        "risk": "high",
        "timeoutMs": 3600000
      }'
# → {"status":"awaiting_approval","stepId":"step-1","approvalId":"<UUID>"}

# 2) Read state to grab the approvalId (and watch the pending gate)
curl -s "$EDGE/state/demo-1"
# → {"agentName":"demo-1","state":{"status":"awaiting_approval",
#     "pendingApprovals":[{"id":"<UUID>","step":{...},"status":"pending",...}],
#     "completedSteps":[]}}

# 3a) Approve over plain HTTP (optionally editing the args)
curl -sX POST "$EDGE/approvals/demo-1/<UUID>/decision" \
  -H 'content-type: application/json' \
  -d '{ "approved": true, "updatedArgs": { "subject": "Hi (edited)" } }'
# → {"status":"completed","stepId":"step-1",
#     "output":{"echo":"sendExternalEmail","params":{...,"subject":"Hi (edited)"},"ranAt":...}}

# 3b) …or decline instead
curl -sX POST "$EDGE/approvals/demo-1/<UUID>/decision" \
  -H 'content-type: application/json' \
  -d '{ "approved": false }'
# → {"status":"declined","stepId":"step-1","approvalId":"<UUID>"}
```

**Approve over WS RPC instead of HTTP** — connect to
`ws://127.0.0.1:8787/agents/calla-edge-agent/demo-1` and send the Agents-SDK
JSON-RPC frame:

```jsonc
{ "type": "rpc", "id": "1", "method": "approvePendingAction",
  "args": [{ "approvalId": "<UUID>", "updatedArgs": { "subject": "Hi (edited)" } }] }
```

The UI's `useAgent(...)` hook wraps this as
`agent.approvePendingAction({ approvalId })`.

**Watch the bus live / emit frames / list the fleet:**

```bash
# live firehose (any WS client, e.g. websocat)
websocat "$EDGE/events"                       # add ?token=… when secured

# resume from a cursor: only frames with id > 1284 are replayed
websocat "$EDGE/events?since=1284"

# keep-alive: send the RAW TEXT below (no JSON) — answered by the runtime for free
printf 'calla:ping'                           # → calla:pong

# scope the stream to two channels (+ gap-fill from a cursor)
printf '{"type":"calla:subscribe","channels":["demo-1","calla:approval:request"],"since":"1284"}'

# recent tail as JSON / cursor gap-fill over HTTP
curl -s "$EDGE/events/recent?limit=20"
curl -s "$EDGE/events/recent?since=1284&limit=500"

# external service (e.g. jev classifier) emitting an event
curl -sX POST "$EDGE/events/ingest" \
  -H 'content-type: application/json' \
  -H 'x-calla-token: <EVENTS_AUTH_TOKEN if set>' \
  -d '{ "type": "calla:classification:completed", "agentId": "jev", "payload": { "batch": 42 } }'
# → {"ok":true,"id":"57","type":"calla:classification:completed","ts":…}

# audit trail + chain verification
curl -s "$EDGE/audit?limit=10"
curl -s "$EDGE/audit?agentId=demo-1&kind=approval.decided"
curl -s "$EDGE/audit/verify"                  # → {"valid":true,"count":12}

# fleet roster
curl -s "$EDGE/fleet"
```

---

## File map

```
src/
  index.ts                      # fetch router + named DO/Workflow exports + default handler
  env.ts                        # Env interface, ApprovalWorkflowParams
  agents/
    edge-agent.ts               # CallaEdgeAgent  (HITL gate + step execution)
    event-hub.ts                # CallaEventHub   (WS bus + ring buffer + audit chain)
    orchestrator.ts             # CallaOrchestrator (fleet roster)
  workflows/
    approval-workflow.ts        # CallaApprovalWorkflow (durable expiry timer)
```

Bindings/classes match `wrangler.jsonc` exactly — no scaffold changes required.
