# @calla/brain — Calla Brain (Mastra HITL orchestrator on Fly.io)

The "brain" of the Calla system: a Mastra 1.74 (TypeScript) orchestration server
exposing a Hono HTTP API. It hosts the `calla-orchestrator` agent (Anthropic
Claude Sonnet 4.5), dispatches step tasks to Cloudflare edge agents, and owns
the human-in-the-loop (HITL) approval flow: risky tool calls suspend the run,
the run is persisted to storage, and the Manager UI approves/declines over REST.

Spec: `plans/prd-business-intelligence-agent/06-playground-pivot-to-calla.md` §3.2 + §5.

## Local dev

```bash
# from packages/calla (npm workspace root)
npm run dev -w @calla/brain        # tsx watch src/server.ts → http://localhost:3001 (PORT env; dev default via `npm run dev`)
```

The UI dev server proxies `/brain/*` → `http://localhost:3001` (path prefix is
stripped), so the Manager UI talks to this server through same-origin `/brain`.

Env (see `.env.example`): `LLM_BASE_URL` + `LLM_API_KEY` (+ optional `LLM_MODEL`,
default `gpt-4o-mini`) for **any OpenAI-compatible gateway/relay** — the preferred
pattern; aliases `OPENAI_BASE_URL`/`OPENAI_API_KEY`/`OPENAI_MODEL` are honored.
Alternatively `ANTHROPIC_API_KEY` (+ `CALLA_MODEL`, default `claude-sonnet-4-5`)
for Anthropic direct. **The server boots without any key**; LLM endpoints then
fail with a clear error while `/health`, `/`, and `suspended-runs` keep working.
Also: `DATABASE_URL` (Postgres; falls back to local LibSQL `file:local.db` when
unset — drives BOTH Mastra storage and the durable Calla store, see below),
`CALLA_EDGE_URL` (default `http://127.0.0.1:8787`), `CALLA_TOKEN`
(bearer auth; unset = open dev mode), `CALLA_JWT_SECRET` (self-hosted auth —
shared HMAC secret for brain-issued JWTs; MUST match the edge worker's value),
`CALLA_AUTH_TTL_DAYS` (token lifetime, default 7), `PORT` (default 3000).

Build & run compiled:

```bash
npm run build -w @calla/brain      # tsc → dist/
node apps/brain/dist/server.js     # from packages/calla
```

## REST contract (what the UI codes against)

Auth: when `CALLA_TOKEN` and/or `CALLA_JWT_SECRET` is set, send
`Authorization: Bearer <CALLA_TOKEN | Calla JWT>` on every route except
`/health`, `/`, and `/auth/*` (a static `CALLA_TOKEN` OR a valid JWT signed
with `CALLA_JWT_SECRET` is accepted). When neither is set the API is open
(local dev). CORS is permissive.

### Self-hosted (standalone) auth — `/auth/*`

The brain can issue its own HS256 JWTs (email + password, scrypt) so a
self-hosted Calla needs **no agentdeploy.io / marketplace dependency**. Set
`CALLA_JWT_SECRET` (`openssl rand -hex 32`) to the **same value** on the brain
and the edge worker; the edge verifies the tokens the brain signs. The first
registered user is the `admin`. Users live in the durable Calla store
(`calla_users`); every register/login/logout writes a hash-chained audit row
(`auth.register` / `auth.login` / `auth.login_failed` / `auth.logout`).

| Method | Route | Request body | Response |
| --- | --- | --- | --- |
| GET | `/auth/status` | — | `{ mode: "standalone", initialized: boolean }` (`initialized` = any users exist) |
| POST | `/auth/register` | `{ email, password }` (password ≥ 10 chars) | `{ token, user: { id, email, role } }` — **only while `initialized` is false**, else `403 { error: "already_initialized" }` |
| POST | `/auth/login` | `{ email, password }` | `{ token, user }`; `401 { error: "invalid_credentials" }` on bad password; `429 { error: "too_many_attempts", retryAfterSec }` after 5 failures (60s lock, per email+IP) |
| GET | `/auth/me` | Bearer JWT | verified claims `{ sub, email, role, iat, exp, iss }` or `401` |
| POST | `/auth/logout` | Bearer JWT (optional) | `{ ok: true }` (JWTs are stateless; records a best-effort audit row) |

If `CALLA_JWT_SECRET` is unset, `/auth/*` generates an **ephemeral** secret and
logs a loud warning — tokens then invalidate on every restart (dev only).

`:agentId` accepts the registration key (`orchestratorAgent`), the agent id or
name (`calla-orchestrator`), or the UI's short id (`orchestrator`).

| Method | Route | Request body | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ ok: true, service: "calla-brain", storage: "pg" \| "libsql", model: "anthropic" \| "not-configured", callaStore: "pg" \| "libsql" }` |
| GET | `/` | — | `{ name: "calla-brain", agents: [{ key, id, name }], dynamicAgents: string[], endpoints: string[] }` — `agents` merges the static registry with enabled store-driven configs; skills/config routes below |
| POST | `/agents/:agentId/generate` | `{ messages: [{ id?, role, content }], threadId?, resourceId? }` | `{ agentId, text, finishReason, runId, suspendPayload, toolCalls, toolResults, usage, error }` |
| POST | `/agents/:agentId/stream` | same as generate | NDJSON stream (`application/x-ndjson`, `cache-control: no-store`) — see below |
| GET | `/agents/:agentId/suspended-runs` | query: `threadId?`, `resourceId?` | `{ runs: SuspendedRunRow[], total: number }` — see below |
| POST | `/agents/:agentId/approve-tool-call` | `{ runId, toolCallId?, updatedArgs? }` | `{ ok: true, approved: true, runId, toolCallId, updatedArgsApplied: false, result: SerializedOutput }` |
| POST | `/agents/:agentId/decline-tool-call` | `{ runId, toolCallId?, reason? }` | `{ ok: true, approved: false, runId, toolCallId, reason, result: SerializedOutput }` |
| GET | `/audit` | query: `limit?` (default 50), `agentId?`, `kind?` | `{ entries: AuditRecord[], count }` — newest first; hash-chained audit log |
| GET | `/audit/verify` | — | `{ valid: boolean, count: number, brokenAt?: number }` — recomputes the full hash chain |
| GET | `/approvals` | query: `status?` (pending/approved/declined/expired), `agentId?`, `limit?` (default 100) | `{ approvals: ApprovalRow[], total }` — history across sources |
| GET | `/agents` | — | `{ agents: AgentRegistryRow[], total }` — Calla agent registry (read-only for now; fleet sync later) |

Errors are always JSON: `{ error: string, details? }` with 400 (bad body),
401 (missing/invalid token), 404 (unknown agent/route), 502 (model/agent run
failed), 500 (unexpected).

`messages` items: `{ role: "user" | "assistant" | "system" | "tool", content: string | parts[] }`
(plain `{role, content}` chat format). `threadId`/`resourceId` are accepted and
forwarded to Mastra as memory options; with no Memory adapter configured they
are currently a no-op (Mastra logs a warning).

`SerializedOutput` (result of generate / approve / decline):

```jsonc
{
  "text": "assistant text",
  "finishReason": "stop" | "tool-calls" | "suspended" | ...,
  "runId": "run id (use for approve/decline when suspended)",
  "suspendPayload": null,           // non-null when finishReason === "suspended"
  "toolCalls":   [{ "toolCallId": "...", "toolName": "...", "args": {} }],
  "toolResults": [{ "toolCallId": "...", "toolName": "...", "result": {}, "isError": false }],
  "usage": { "inputTokens": 0, "outputTokens": 0, "totalTokens": 0 },
  "error": null
}
```

### `suspended-runs` row shape (Mastra 1.74, flattened for the UI)

Mastra returns `AgentRun = { runId, status: "suspended", threadId?, resourceId?,
suspendedAt: Date, toolCalls: [{ toolCallId?, toolName?, args?, requiresApproval,
suspendPayload? }] }`. The brain flattens one row per suspended tool call, with
everything the UI adapter (`apps/ui/src/lib/mastra-client.ts`) reads at the top
level:

```jsonc
{
  "runs": [{
    "runId": "...",
    "status": "suspended",
    "agentId": "calla-orchestrator",
    "threadId": null,
    "resourceId": null,
    "suspendedAt": "2026-01-01T00:00:00.000Z",   // ISO string
    "toolCallId": "toolu_...",
    "toolName": "send-external-email",
    "args": { "to": "...", "subject": "...", "body": "..." },
    "requiresApproval": true,
    "riskLevel": "high",                          // derived from tool name
    "suspendPayload": null,
    "toolCalls": [ /* original nested array */ ]
  }],
  "total": 1
}
```

### `/stream` NDJSON lines

One JSON object per line (Mastra 1.74 `fullStream` chunks, normalized):

```jsonc
{ "type": "start", "runId": "..." }
{ "type": "text-delta", "delta": "partial text", "id": "..." }
{ "type": "reasoning-delta", "delta": "..." }
{ "type": "tool-input-available", "toolCallId": "...", "toolName": "...", "input": {}, "args": {} }
{ "type": "tool-result", "toolCallId": "...", "toolName": "...", "result": {}, "isError": false }
{ "type": "tool-call-approval", "toolCallId": "...", "toolName": "...", "args": {}, "resumeSchema": "...", "runId": "..." }  // HITL gate
{ "type": "tool-call-suspended", "toolCallId": "...", "toolName": "...", "args": {}, "suspendPayload": {}, "runId": "..." }
{ "type": "finish", "finishReason": "stop", "usage": {}, "runId": "..." }
{ "type": "error", "error": "message", "runId": "..." }
{ "type": "done", "runId": "..." }   // final line — stream closed cleanly
```

Internal noise (raw chunks, step-start/response-metadata, etc.) is dropped.

## Durable Calla store (`calla_*` tables)

Separate from Mastra's own storage (which keeps agent runs / suspended
snapshots / memory), the brain owns a small durable store for
cross-run history. **No collision with Mastra tables** — every table is
prefixed `calla_` and bootstrapped with idempotent `CREATE TABLE IF NOT
EXISTS` DDL at server start (no runtime migrator; Mastra owns its own
migrations).

Selection is **connection-string-presence driven** (not NODE_ENV):
`isRealPostgresUrl(DATABASE_URL)` → **Postgres** (`drizzle-orm/node-postgres`
+ `pg`, drizzle query building over `src/store/schema.ts`); otherwise
**LibSQL** (`@libsql/client` raw SQL) at `LIBSQL_URL ?? file:local.db`.
`:memory:`/`sqlite`/`file:*.db` values in `DATABASE_URL` are rejected by the
classifier and fall back to LibSQL. `GET /health` reports `callaStore:
"pg" | "libsql"`. Both implementations satisfy one `CallaStore` interface
(`src/store/types.ts`): `recordApproval`, `listApprovals`, `appendAudit`,
`getAudit`, `verifyAudit`, `cacheGet`, `cacheSet`, `upsertAgent`,
`listAgents`, `listSkills`, `getSkill`, `upsertSkill`, `deleteSkill`,
`listAgentConfigs`, `getAgentConfig`, `upsertAgentConfig` — global singleton
via `Symbol.for("calla.store")`.

| Table | Purpose |
| --- | --- |
| `calla_agents` | agent registry (id, name, type, runtime, status, capabilities jsonb, meta jsonb, deploymentId) — read-only over HTTP for now |
| `calla_approvals` | append-only HITL history across sources (`mastra` today; `cloudflare`/`core`/`data` later): pending row on suspend, decided row on approve/decline; indexed on agentId/status/requestedAt |
| `calla_audit` | hash-chained audit log `{seq, ts, agent_id, kind, entry jsonb, prev_hash, entry_hash}` rooted at `GENESIS`; `GET /audit/verify` recomputes the chain |
| `calla_cache` | TTL cache — composite PK `(key, agent_id)`, jsonb value, `expires_at` eviction on read |
| `calla_skills` | per-agent skill files (markdown + frontmatter, bi-edge style): `UNIQUE (agent_id, name)`, `ref_json` references map, `source` builtin/uploaded, `version` bumped on every edit |
| `calla_agent_configs` | per-agent persona/instructions/model overrides (`agent_id` PK): the dynamic agent factory rebuilds Mastra agents from these rows; `enabled=false` parks the config |

Audit chain: `entry_hash = sha256(canonical JSON of {seq, ts, agentId, kind,
entry, prevHash})` where canonical = recursive key sort (`stableStringify`),
so hashes survive jsonb round-trips (jsonb does not preserve key order).
Appends are serialized in-process (promise queue) to keep `seq` gap-free.
Kinds written today: `run.completed`, `risk.flagged`, `approval.requested`,
`approval.decided`, `evaluator.error`, `skill.created`, `skill.updated`,
`skill.deleted`, `agent.configured`.

Storage failures are **best-effort everywhere**: every store hook in the
request path is wrapped in try/catch + logging — a dead database degrades
audit/history but never breaks LLM responses.

## Skills & dynamic agents (multi-tenant behavior)

Calla is multi-tenant: gradient3.io runs the founder's outreach fleet
(`agent.miles@gradient3.io`), and other companies run their own. Agent
behavior is **hot-swappable per tenant without code changes or restarts**:
persona instructions and skill files (markdown, bi-edge `SKILL.md` style —
YAML frontmatter + body) live in the durable store (`calla_agent_configs` +
`calla_skills`), are editable over REST / the in-UI **Skills tab**, and
resolve into real Mastra agents at request time.

### Architecture

```
calla_agent_configs / calla_skills            (tenant-editable rows, versioned)
        │  resolveDynamicAgent(agentId)       cache: `${agentId}@${configVersion}:${skillsHash}`
        ▼
createSkill({name, description, instructions, references})   ← @mastra/core/skills (inline, no FS)
new Agent({id, name, instructions, model: resolveModel(cfg.model), tools, skills})
        │  mastra.addAgent (brand-new ids) / rebuild+replace (live registry record)
        ▼
server.ts resolveAgent():  1) dynamic factory  →  2) static mastra registry fallback
```

- `src/mastra/dynamic-agents.ts` — the factory. On every resolve it compares
  the cache fingerprint (`config.version` + a hash of `name:version` for all
  skills); any CRUD bump invalidates, so the **next request rebuilds the
  agent** with the new instructions/skills. `invalidate(agentId)` is called
  by every mutation route. Resolution never throws — store/model failures
  fall back to the static registry.
- `src/mastra/agents/orchestrator.ts` — `resolveModel(modelId?)` is the
  single LLM resolution path (openai-compatible gateway first, Anthropic
  second; `"anthropic/<model>"` overrides force Anthropic). Agent configs may
  carry a per-agent `model` string; `null` → brain default (`LLM_MODEL` /
  `CALLA_MODEL`). The orchestrator config additionally gets the fleet tools
  (`dispatchEdgeTask`, `sendExternalEmail`, `listFleet`); other agents start
  tool-less.
- Mastra 1.74 registration: `mastra.addAgent()` silently skips duplicate
  keys and `mastra.listAgents()` returns the live internal record, so
  rebuilt agents are wired via the internal `__registerMastra` /
  `__registerPrimitives` hooks and **swapped in place**; the factory also
  keeps its own registry Map (consulted FIRST by `resolveAgent`).
- All execution routes (`generate`, `stream`, `suspended-runs`,
  `approve-tool-call`, `decline-tool-call`) go through `resolveAgent`, so
  HITL works for **any** resolved agentId, dynamic or static.

### REST (behind the same bearer auth; shared contract: `SKILLS_ROUTES`)

| Method | Route | Request body | Response |
| --- | --- | --- | --- |
| GET | `/skills?agentId=` | — | `{ skills: SkillRecord[], total }` (all agents when unfiltered) |
| POST | `/skills/:agentId` | `{ name, description, instructions, references? }` | `201 { skill }`; `409` when it exists; `400` on bad slug (`SKILL_NAME_RE`, ≤64) or description (>1024) |
| PUT | `/skills/:agentId/:name` | `{ description?, instructions, references? }` | `{ skill }` — upsert with `version + 1`; builtin skills are **editable** (source stays `builtin`); creates (uploaded) when absent |
| DELETE | `/skills/:agentId/:name` | — | `{ ok, skill }`; builtins → `400 { error: "builtin skill cannot be deleted; edit it instead" }`; missing → `404` |
| GET | `/agents/configs` | — | `{ configs: AgentConfigRecord[], total }` |
| POST | `/agents/configs` | `{ agentId, name, description?, instructions, model? }` | `201 { config }`; `409` when it exists; `400` on bad agentId slug — registers via `mastra.addAgent` immediately |
| PUT | `/agents/configs/:agentId` | `{ name?, description?, instructions?, model?, enabled? }` | `{ config }` with `version + 1`; `enabled:false` parks the agent (static fallback resumes) |
| GET | `/agents/:agentId/skills` | — | `{ agentId, skills: [{ name, description, source }], instructionsVersion }` — resolved via `agent.listSkills()` |

Every mutation appends a hash-chained audit row: `skill.created` /
`skill.updated` / `skill.deleted` / `agent.configured` with
`{ agentId, name?, version }` (query via `GET /audit?kind=...`).

### Builtin seed (gradient3.io defaults)

`seedBuiltins(store)` runs at bootstrap (idempotent, best-effort): it inserts
**only when the store has nothing for that agent**, so tenant edits are never
overwritten by a restart.

| Agent id | Config | Skills |
| --- | --- | --- |
| `orchestrator` | builtin config — instructions from `builtin/orchestrator-instructions.md` (extracted verbatim from the static `calla-orchestrator`, which keeps working unchanged when the store is empty) | the 5 gradient3 defaults |
| `miles` | builtin config — "Miles — Gradient3 Outreach" persona: sender **agent.miles@gradient3.io**, Gradient3 brand, direct conversational voice per `outreach-style.md`, compliance-gated | the 5 gradient3 defaults |

The 5 builtin skill files (`src/mastra/skills/builtin/`, copied verbatim from
`packages/bi-edge/skills/`): `identity`, `outreach-style`, `icp`,
`objection-handling`, `compliance`. Parsing: frontmatter → `references["frontmatter.json"]`,
body → `instructions`, description → frontmatter `description` / first `#`
heading / first line. Builtins are editable (version bumps, source stays
`builtin`) but not deletable.

### Onboarding a new tenant

No code, no restart — two REST calls (or the UI Skills tab):

```bash
curl -X POST $BRAIN/agents/configs -H "Authorization: Bearer $CALLA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"agentId":"acme-sdr","name":"Acme SDR","instructions":"You are Acme's outbound SDR..."}'
curl -X POST $BRAIN/skills/acme-sdr -H "Authorization: Bearer $CALLA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"tone-guide","description":"Tone rules","instructions":"# Tone\nTerse."}'
```

`POST /agents/:agentId/generate` (and every other execution route) works for
`acme-sdr` immediately. Tenants customizing the gradient3 stack instead just
PUT over the seeded `miles`/`orchestrator` rows.

### Mastra Studio compatibility

Dynamic agents are **runtime-registered** (factory Map first, `addAgent` for
brand-new ids). Mastra Studio introspects the static registry snapshot, so
runtime-built/rebuilt agents may be missing or stale there — the in-UI
**Skills tab** (backed by the routes above) is the client-facing editor of
record.

## Evaluator pipeline

After every completed run (`/generate` response built, or NDJSON stream
finished — hooked via the `createNdjsonStream` observer), the brain
fire-and-forgets a two-phase evaluator run (never in the request path):

1. **filter** — keep evaluators with `alwaysRun` or when the agent
   `didRespond` (text or tool calls), then `validate(ctx)`;
2. **execute** — survivors' `handler(ctx)` run **in parallel**
   (`Promise.allSettled`); each failure appends an `evaluator.error` audit row.

Built-ins (`src/evaluators/`):

| Evaluator | Gate | Effect |
| --- | --- | --- |
| `calla-run-audit` | `alwaysRun` | appends `run.completed` audit row `{runId, agentId, finishReason, toolCallNames, outputChars, durationMs}` |
| `calla-risk-flag` | output has tool calls | flags `send-external-email` (high), `delete-*` (high), `dispatch-edge-task` (medium; high when `step.requiresApproval`) → `risk.flagged` audit rows + `{success, values: {risky, tools}}` |

Approval wiring: when a generate/stream **suspends** (`finishReason:
"suspended"` / `tool-call-approval` chunk) the brain records a `pending`
`calla_approvals` row + `approval.requested` audit entry; on
`approve-tool-call` / `decline-tool-call` success it appends the decided row
(enriched with toolName/args/risk from the pending row when available) +
`approval.decided` audit entry.

### Attribution

Store/evaluator patterns adapted from MIT-licensed prior art:
**@elizaos/plugin-sql** ((c) 2025 Shaw Walters and elizaOS Contributors) —
connection-string-presence adapter selection, global singleton connection
manager, `isRealPostgresDatabase`-style URL classifier, and the `cache`
table shape (composite PK `(key, agentId)`, jsonb value, `expiresAt` TTL);
**ElizaOS core** (MIT) — the `Evaluator` interface (`name/description/
similes/alwaysRun/validate/handler`) and the two-phase parallel
`runtime.evaluate()` pipeline; **@thirtieth/elizaos-plugin-cloudflare**
(MIT, (c) 2026 thirtieth) — hash-chained audit log entries with a GENESIS
root and `verifyChain()`, implemented here in SQL (`calla_audit` +
`verifyAudit()`).

## HITL flow (spec §5)

1. The orchestrator decides to call `send-external-email` (`requireApproval: true`).
2. Mastra suspends the run; the snapshot is persisted to storage
   (Postgres when `DATABASE_URL` is set, else local LibSQL).
3. The `/stream` connection emits `tool-call-approval` then `finish`
   (`finishReason: "suspended"`) and closes; `/generate` returns with
   `finishReason: "suspended"` + `suspendPayload`.
4. The UI Approval Inbox polls `GET /agents/orchestrator/suspended-runs`
   and renders an Approval Card per pending tool call.
5. Human clicks **Approve** → `POST /agents/orchestrator/approve-tool-call`
   `{ runId, toolCallId }` → Mastra resumes, the tool executes, and the JSON
   response carries the resumed run's result. **Decline** →
   `POST .../decline-tool-call` `{ runId, toolCallId, reason? }` — the model is
   told the call was declined (with your reason) and continues without it.
6. If the resumed run suspends again (another gated tool), `result.finishReason`
   is `"suspended"` with a new `runId` — repeat.

Notes:
- `updatedArgs` ("Edit & Approve") is accepted by the endpoint for contract
  compatibility, but Mastra 1.74 `approveToolCall` resumes with the model's
  original args — edited args are logged and ignored (`updatedArgsApplied: false`).
- Edge-side approvals are separate: `dispatch-edge-task` is not gated in the
  brain; the edge DO enforces its own gates and returns
  `{ status: "awaiting_approval", approvalId }`.

### approval-with-escalation workflow (workflow-level HITL gate)

`mastra/workflows/approval-with-escalation.ts` registers a suspend/resume
workflow on the Mastra instance. Gate pattern adapted from
`chrislema/mastra-builder` (deliveryDeploymentWorkflow):

- Step `request-approval` suspends with `{ reason, requestedAt, approvalId }`
  and **resume label `approve-calla-gate`**; resumes with
  `{ approved, approver?, notes? }` — the approver identity is persisted.
- Every gate transition writes to the hash-chained audit log
  (`gate.suspended`, `gate.decided`, `gate.escalated`) before/after
  suspension, so gates are reconstructable after restarts.
- Step `escalate` calls the stubbed `notifySecondaryApprover()` (structured
  log line) when the request was not approved within the window
  (`timeoutMs`, default 24h).

REST surface (workflow snapshots survive restarts via Mastra storage; the
suspended list is store-backed so it is queryable by status):

```
POST /workflows/approval-gate            {reason, summary?, risk?, agentId?, timeoutMs?, approvalId?}
                                         → {runId, approvalId, status:"suspended", resumeLabel}
GET  /workflows/approval-gate/suspended  → {gates: ApprovalRow[], total}
POST /workflows/approval-gate/:runId/resume
                                         {approved, approver?, notes?}
                                         → {runId, status:"success", result:{approved, escalated, approver, note}}
```

Use workflow gates for **deployment-style, multi-stage approvals** (long
window, named approver, escalation) and tool-level `requireApproval` for
**in-conversation tool calls** (the orchestrator's `send-external-email`).

### Observability

Configured in `mastra/index.ts` (mastra-builder pattern): `Observability`
with `MastraStorageExporter` (traces/logs/scoring events persist to Mastra
storage — queryable, survive restarts) and `SensitiveDataFilter` (redacts
passwords/tokens/keys from span output). Service name: `calla-brain`
(override `CALLA_OTEL_SERVICE_NAME`). Add `MastraPlatformExporter` to the
exporters array when `MASTRA_PLATFORM_ACCESS_TOKEN` is set.

## Agent tools

| Tool | Approval | Behavior |
| --- | --- | --- |
| `dispatch-edge-task` | no (edge gates itself) | `POST ${CALLA_EDGE_URL}/steps/${edgeAgentId}` with `{id, action, params, requiresApproval}` → `StepResult` |
| `send-external-email` | **yes** (HITL demo) | stub send: logs and returns `{ sent: true, messageId }` |
| `list-fleet` | no | `GET ${CALLA_EDGE_URL}/fleet` → `{ ok, agents }` |

## Messaging channels (Telegram / WhatsApp)

Talk to the orchestrator and decide HITL approvals from your phone. Enabled
per-platform by env (see `.env.example` and the full guide in
`src/channels/README.md`):

- **Telegram** — set `TELEGRAM_BOT_TOKEN`. Without `TELEGRAM_WEBHOOK_URL` the
  bot long-polls (perfect for local dev, no tunnel); with it, the webhook at
  `POST /channels/telegram/webhook` is used (secret header verified).
- **WhatsApp** — set `WHATSAPP_TOKEN` + `WHATSAPP_PHONE_NUMBER_ID` (+
  `WHATSAPP_VERIFY_TOKEN`, `WHATSAPP_APP_SECRET`). Webhooks at
  `GET|POST /channels/whatsapp/webhook` (Meta challenge + HMAC signature).
- **Binding** — `POST /channels/bindings/code` (behind bearer auth) returns a
  10-min code; the operator sends `/start <code>` to the bot (Telegram) or the
  bare code (WhatsApp) to bind their chat.
- **Chat** — plain messages go to the orchestrator (`/ask` optional prefix);
  `/status`, `/approvals`, `/help` commands; pending approvals are pushed live
  (edge `/events` WS + 15s mastra poll) as cards with Approve/Decline buttons
  (Telegram inline keyboard / WhatsApp reply buttons). Decisions are audited
  (`via: "channel:<platform>"`).

Webhook routes are exempt from bearer auth (platform-native auth instead);
management routes require it.

### Social messaging (Instagram / TikTok)

ManyChat-style **reply automation for business social accounts** via the official
Meta *Instagram API with Instagram Login* and the *TikTok Business Messaging API*
(Login Kit v2). Enabled per-platform by access token; inbound DMs/comments are
normalized, optionally captured as leads (→ bi-edge `/inbound/sync` → Calla Data),
matched against editable triggers (`GET`/`PUT /channels/social/triggers`), then
either auto-replied inside the platform reply window or gated behind a HITL
approval that the **same** Telegram/WhatsApp cards and web UI inbox can decide.

- **Instagram** — set `IG_ACCESS_TOKEN` (+ `IG_APP_ID`, `IG_APP_SECRET`,
  `IG_VERIFY_TOKEN`). Webhooks at `GET|POST /channels/instagram/webhook`
  (Meta challenge + `X-Hub-Signature-256` HMAC). 24h reply window + ~2 sends/sec
  queue. Token helper: `POST /channels/instagram/exchange`.
- **TikTok** — set `TIKTOK_ACCESS_TOKEN` (+ `TIKTOK_VERIFY_TOKEN`). Business
  account required; automation only in user-initiated conversations;
  comment-to-message is **region-gated** (partial SEA; not EEA/UK/CH). Webhooks at
  `GET|POST /channels/tiktok/webhook`. ⚠️ Endpoint paths need portal verification
  with real keys (`TIKTOK_API_BASE` / `TIKTOK_SEND_PATH`).
- **Persona** — replies come from `resolveDynamicAgent(SOCIAL_REPLY_AGENT ??
  "miles")` so the tenant's editable persona drives tone.
- **QA** — `POST /channels/social/test` injects a synthetic event end-to-end.

Safety-first defaults: Instagram comments require approval; Instagram DMs may
auto-reply within the window; TikTok DMs always require approval. Full guide,
trigger model, lead-capture contract, region table, and mock-testing walkthrough:
`src/channels/README.md` → **"Instagram & TikTok (social)"**.

### WhatsApp customer conversations (WAVE-2)

The business WhatsApp line now serves **customers** as well as the operator:
inbound messages from chats that are NOT bound operators (and
`WHATSAPP_CUSTOMER_MODE !== "false"`, default on) normalize to the social
engine (`platform:"whatsapp"`, lead key `WA:<phone>`, source `whatsapp`) —
capture-by-default, triggers (`whatsapp` list in `PUT /channels/social/triggers`),
persona replies and qualification flows (`channel:"whatsapp"`, chatRef
`whatsapp:<phone>`, prompts as plain text). Sends respect the WhatsApp Cloud
API **24h customer-service window** (`social:wa:window:<phone>`); outside it —
and for anything approval-gated — the existing HITL cards decide
(`social-whatsapp-dm`). Template messages are out of scope. Bound operators
keep the console behavior exactly. `GET /channels` reports
`platforms.whatsapp.customerMode`. Guide + GDPR notes:
`src/channels/README.md` → **"WhatsApp customer conversations"**.

### Meta Lead Forms + embeddable website widget (WAVE-2)

Two more intake surfaces feed the qualification-flow runner:

- **Meta Lead Forms** — `GET|POST /channels/facebook/webhook` (verify-token
  handshake + `X-Hub-Signature-256` HMAC). Each `leadgen` change fetches the
  full lead from `{FB_GRAPH_BASE}/{leadgen_id}` (token unset → graceful skip,
  still 200 to Meta), captures it (`FB:<leadgen_id>`, source `facebook`,
  country `FB_LEAD_COUNTRY`), and starts `FACEBOOK_LEADGEN_FLOW` with answers
  mapped onto flow fields via the `leadform:fieldmap` cache (seeded for the
  builtin retrofit flow; `FACEBOOK_FIELD_MAP` JSON merges over it) — prefilled
  runs complete immediately into scoring/routing. Audits: `leadform.received`
  / `leadform.captured` / `leadform.error`.
- **Website widget** — public `/forms/*` (no auth by design):
  `GET /forms/widget.js?flow=&title=&brand=` serves a dependency-free IIFE
  that renders the flow's fields from `GET /forms/definition` and submits to
  `POST /forms/ingest` (`{flowId, answers, contact?, session?}` → 10/min/IP
  rate limit → lead `WEB:<email||session>` (source `website`) → flow run
  `channel:"form"`, chatRef `form:<session>` → `{ok, leadKey, completed,
  tier?, summary:{message, bookingLink?, slots?}}`). Harden with
  `FORMS_ALLOWED_ORIGINS` (CORS allowlist). Embed:
  `<script src="https://<brain>/forms/widget.js?flow=retrofit-solar-qualification&title=Get your solar quote" defer></script>`

Full contracts, Meta app setup and hardening guide:
`src/channels/README.md` → **"Meta Lead Forms + website widget"**.

## Booking (Google / Microsoft 365 / Calendly)

Appointment booking for property-survey reps — `src/booking/**`, mounted at
`/booking`. Target market **Ireland**: every rep/policy defaults to
`Europe/Dublin`, Mon–Fri `09:00–17:30`, 45-minute slots with a 15-minute
buffer. No new npm dependencies (global `fetch` + `node:crypto` only); state
lives in the durable Calla store cache (see keys below) and every mutation is
hash-chain audited (`booking.connected` / `booking.created` /
`booking.cancelled` / `booking.webhook`).

| Capability | Google Calendar | Microsoft 365 (Graph) | Calendly |
| --- | --- | --- | --- |
| Connect | OAuth code flow (`calendar.events` + `openid email`, offline) | OAuth code flow (`Calendars.ReadWrite offline_access User.Read`) | none — link scheduling URL |
| Availability | `POST freeBusy` + shared slot finder | `POST /me/calendar/getSchedule` + shared slot finder | returns the rep's scheduling `link` (Calendly owns slot math) |
| Book via API | `POST /calendars/primary/events` ("Survey — {name}", Europe/Dublin timeZone) | `POST /me/calendar/events` | ✗ (400 + link — bookings happen on Calendly) |
| Cancel via API | `DELETE events/{id}` | `DELETE /me/events/{id}` | API cancel with `CALENDLY_ACCESS_TOKEN`, else local mirror |
| Push notifications | `events/watch` channel (≤7-day ttl) | `/subscriptions` (**max 3-day expiry**; renewal TODO — see `providers/microsoft.ts`) | signed webhook `invitee.created` / `invitee.canceled` |
| Webhook self-verification | channel token (`BOOKING_WEBHOOK_SECRET`) + `sync` state → 200; GET sync → 200 | `validationToken` echo (text/plain) + `clientState` check (401 mismatch) | `X-Signature` = hex HMAC-SHA256 of the raw body with `CALENDLY_WEBHOOK_SECRET` (constant-time) |

### Dual booking: one core, two protocols, selectable backend

All booking logic lives ONCE in `src/booking/service.ts` (availability / book /
list / cancel / reps), composed from the store + provider adapters + the
Europe/Dublin slot finder. Two protocol adapters sit on top and both go through
`src/booking/backend.ts` (the dual-backend selector), so they can never drift:

- **REST** — `src/booking/routes.ts` (`/booking/*`) delegates to the backend.
- **MCP** — `src/booking/mcp-server.ts` exposes the SAME ops as standard MCP
  tools over Streamable HTTP at **`/mcp/booking`** (stateless; behind bearer
  auth). This is Calla's "Google Calendar MCP" surface: any MCP client — a
  Mastra agent via `@mastra/mcp`, the voice agent, Claude Desktop, Cursor, an
  external orchestrator — connects and books through the identical core +
  audit trail. Tools: `list_reps`, `check_availability`, `book_appointment`,
  `list_appointments`, `cancel_appointment`. Gated by `BOOKING_MCP_ENABLED`.

`BOOKING_BACKEND` selects WHERE booking is served (both protocols honour it):

| Mode | Behaviour |
| --- | --- |
| `native` (default) | Calla's own module (Google/M365/Calendly above). |
| `mcp` | Proxy to an **external** Google Calendar MCP server (`EXTERNAL_CALENDAR_MCP_URL`, `src/booking/mcp-client.ts`) — for a client that already runs calendar MCP. Tool names auto-matched or mapped via `EXTERNAL_MCP_TOOL_*`; unavailable ops → `501`. |
| `both` | Native first; fall back to external MCP on connectivity gaps (`not-connected` / no-reps / `501`). |

So the founder's "booking module OR Google Calendar MCP OR both" is a single
env switch, with Calla additionally re-exposing whichever is active as its own
MCP server. Verified: native mode → REST and MCP `check_availability` return the
identical result from one core; `mcp` mode with no external URL → clean `501`.

### Routes

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/booking` | provider/config status, reps, policy, connection count |
| GET/POST | `/booking/reps` | list / create `{ name, email, provider, ... }` |
| PUT/DELETE | `/booking/reps/:repId` | partial update / remove |
| GET/PUT | `/booking/policy` | slot/buffer/workHours/timezone/maxBookingsPerDay defaults |
| POST | `/booking/connect/:provider/start` | `{ repId }` → `{ authUrl, state }` (google/microsoft; state cached 10 min, single-use) |
| POST | `/booking/connect/calendly/link` | `{ repId, schedulingLink, eventTypeUri? }` |
| GET | `/booking/connect/:provider/callback` | `?code&state` → token exchange + store + rep attach → friendly HTML (auth-exempt) |
| GET | `/booking/availability?repId&from&to` | `{ slots: [{start,end}] }` (auto token refresh; `409 reconnect-required` on failure) or `{ link }` (calendly) |
| POST | `/booking/appointments` | `{ repId, start, end?, attendee, context? }` → `201 { appointment }` + audit |
| GET | `/booking/appointments?repId&days` | aggregated upcoming (provider list + calendly mirror, best-effort) |
| DELETE | `/booking/appointments/:id?repId=` | provider cancel + `booking.cancelled` audit |
| POST | `/booking/webhook/calendly` | auth-exempt; HMAC-verified |
| GET/POST | `/booking/webhook/google` | auth-exempt; GET → 200 (sync check), POST → channel notification |
| POST | `/booking/webhook/microsoft` | auth-exempt; handshake echo + clientState |

Webhook paths and the OAuth callback are exempt from bearer auth
(self-verifying); everything else under `/booking` requires it.

### Provider setup

**Google** — Google Cloud Console → enable the *Google Calendar API* →
*Credentials* → create an **OAuth client ID** (Web application). Add the
redirect URI `https://<brain>/booking/connect/google/callback`. Set
`GOOGLE_OAUTH_CLIENT_ID` + `GOOGLE_OAUTH_CLIENT_SECRET` (+ `GOOGLE_REDIRECT_URI`
or `BOOKING_PUBLIC_URL`). Consent screen: internal, or external with your
org's domain (test users until verified). The `events/watch` channel is
registered automatically after connect when `BOOKING_PUBLIC_URL` is set; its
`sync` notification is answered 200 by `POST /webhook/google` (`GET` also
returns 200 for reachability checks).

**Microsoft 365** — Entra ID → *App registrations* → new registration →
*Authentication* → add redirect URI
`https://<brain>/booking/connect/microsoft/callback` → *Certificates &
secrets* → new client secret. Under *API permissions* add **delegated**
`Calendars.ReadWrite`, `offline_access`, `User.Read`. Set
`MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET` (+ `MICROSOFT_TENANT_ID` for
single-tenant; default `common`). Graph subscriptions expire after **max 3
days** — renewal is a TODO (`msCreateSubscription` in
`src/booking/providers/microsoft.ts`); the webhook echoes `validationToken`
and enforces `clientState` (`MICROSOFT_CLIENT_STATE`, default
`BOOKING_WEBHOOK_SECRET`).

**Calendly** — no OAuth for the core flow. Copy the rep's scheduling link
(and, for webhook matching, the event-type URI from
`https://api.calendly.com/event_types` or the URL slug), then
`POST /booking/connect/calendly/link`. In Calendly → *Integrations →
Webhooks*: subscribe to **invitee.created** and **invitee.canceled** with URL
`https://<brain>/booking/webhook/calendly` and a secret — set the same value
as `CALENDLY_WEBHOOK_SECRET`. Incoming bodies are verified with
`X-Signature` (hex HMAC-SHA256 of the raw body, constant-time compare;
mismatch → 401) and matched to reps by stored `eventTypeUri`.

### Rep onboarding

```bash
curl -X POST $BRAIN/booking/reps -H "Authorization: Bearer $CALLA_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"name":"Dave Byrne","email":"dave@gradient3.io","provider":"google"}'
# → { rep: { id: "dave-byrne-1a2b3c", ... } }
curl -X POST $BRAIN/booking/connect/google/start -H "Authorization: Bearer $CALLA_TOKEN" \
  -H 'content-type: application/json' -d '{"repId":"dave-byrne-1a2b3c"}'
# → { authUrl } — open it, approve, the callback attaches the account + audits.
curl "$BRAIN/booking/availability?repId=dave-byrne-1a2b3c" -H "Authorization: Bearer $CALLA_TOKEN"
```

### Slot rules (Europe/Dublin)

`scheduling.ts` is a pure, DST-safe finder (Intl-based, no date libs) shared
by Google + Microsoft: one grid per local working day stepping `slotMinutes`
from work-hours `start`; a slot is dropped when it overlaps any busy range
inflated by `bufferMinutes` **before and after**, when it would end past
work-hours `end` or outside the requested `from/to` window, or when the day
already reached `maxBookingsPerDay` (busy ranges count toward it). Slots are
returned as ISO-8601 UTC `{ start, end }`.

### Ireland / GDPR notes

- **Data minimization** — appointments store only `attendee.name` plus
  *optional* email/phone (both are only sent to the calendar when provided);
  audit rows record ids/times and the attendee **name**, never tokens and no
  contact details beyond that.
- **Tokens at rest** — OAuth access/refresh tokens persist in the durable
  Calla store cache (`conn:<provider>:<accountId>`, agentId `booking`), never
  in logs, audit entries, or responses.
- **Secrets** — set client secrets, `CALENDLY_WEBHOOK_SECRET` and
  `BOOKING_WEBHOOK_SECRET` via `fly secrets set ...` (never commit them); the
  OAuth `state` is single-use with a 10-minute TTL.
- EU data residency: prefer the `europe-west` Fly region and (for Microsoft)
  an EU tenant so calendar data stays in the EU.

### Mock testing (no real keys)

Every API base is env-overridable, so the whole flow runs against local fake
servers:

```bash
GOOGLE_OAUTH_BASE=http://127.0.0.1:3987 \
GOOGLE_API_BASE=http://127.0.0.1:3987 \
GOOGLE_OAUTH_CLIENT_ID=fake GOOGLE_OAUTH_CLIENT_SECRET=fake \
MICROSOFT_OAUTH_BASE=http://127.0.0.1:3988 \
GRAPH_API_BASE=http://127.0.0.1:3988 \
MICROSOFT_CLIENT_ID=fake MICROSOFT_CLIENT_SECRET=fake \
CALENDLY_WEBHOOK_SECRET=mock-secret BOOKING_WEBHOOK_SECRET=mock-state \
node apps/brain/dist/server.js
```

The fake Google host serves `/token` (→ `{access_token, refresh_token,
expires_in}`), `/oauth2/v3/userinfo`, `/calendar/v3/freeBusy`,
`/calendar/v3/calendars/primary/events`; the fake Graph host serves
`/common/oauth2/v2.0/token`, `/me`, `/me/calendar/getSchedule`,
`/me/calendar/events`. When `GOOGLE_OAUTH_BASE` is overridden, the token
endpoint follows it unless `GOOGLE_OAUTH_TOKEN_BASE` is set. Store keys used:
`booking:reps`, `booking:policy`, `conn:<provider>:<accountId>`,
`booking:conn:index`, `booking:oauth:state:<state>` (10-min TTL),
`booking:calendly:invitees` (capped at 500).

### For the qualification-flow engine (availability → book → confirm)

1. **Availability** — `GET /booking/availability?repId=...&from=...&to=...`.
   `200 { slots }` (google/microsoft; UTC ISO slots, already buffer- and
   work-hours-filtered) or `200 { link }` (calendly — send the link to the
   lead instead of booking; the webhook will mirror the result back). Handle
   `409 { reconnectRequired: true }` by nudging the rep to reconnect, and
   `400` for disabled/unlinked reps.
2. **Book** — `POST /booking/appointments` with `{ repId, start, attendee:
   { name, email?, phone? }, context: { leadKey, propertyAddress?, notes? } }`
   (`end` optional — defaults to `start + slotMinutes`). `201` returns the
   normalized `appointment` (provider event id) and writes the
   `booking.created` audit row; pass `context.leadKey` so the booking is
   attributable to the lead.
3. **Confirm** — treat `201` as confirmed (calendar invites go out via
   `sendUpdates`/attendees). Verify out-of-band changes via
   `GET /booking/appointments?repId=...&days=...`; for calendly reps,
   confirmation arrives asynchronously through `POST /webhook/calendly`
   (`invitee.created` → stored + `booking.webhook` audit; `invitee.canceled`
   → status `cancelled`). Re-pull availability after any booking — slots are
   computed live from the calendar, never cached.

## Qualification flows & routing

Flowly-style **multi-step enquiry qualification** — `src/flows/**` (mounted at
`/flows`) + `src/booking/routing.ts`. A deterministic state machine walks a
lead through a vertical-specific question set, scores the answers, tiers the
lead (hot/warm/cold), routes it to a rep, proposes survey slots (or a
Calendly link), patches the engine lead, and hands a booking proposal back to
the conversation. No new npm deps (`fetch` + `node:crypto` only); runs and
definitions live in the Calla store cache (agentId `flows`) and every
mutation is hash-chain audited (`flow.started` / `flow.completed` /
`flow.abandoned` / `flow.urgent` / `flow.routed` / `flow.booked` /
`flow.definition_*` / `flow.routing_rule_*`).

### Verticals & builtin flows

Builtins are **versioned in code** (`src/flows/definitions.ts`; `PUT` on one
returns 400). Custom flows are created via the REST API and merged on read.

| Flow id | Vertical | Asks | Booking intent |
| --- | --- | --- | --- |
| `retrofit-solar-qualification` | retrofit | homeowner/tenant, property type, Eircode, monthly electricity spend, existing solar, battery interest, EV, timeframe, grant questions (optional), ready for survey | `ready_for_survey = yes` |
| `property-buyer` | property | budget band, mortgage AIP, bedrooms, areas, timeline, first-time buyer | — (tag only) |
| `property-seller` | property | address, property type, bedrooms, selling timeframe, already listed, reason for moving (optional), wants valuation | `wants_valuation = yes` |
| `property-landlord` | property | number of properties, location, currently managed, current agent (skipIf unmanaged), rent band, services required (optional), wants appraisal | `wants_appraisal = yes` |

Example scoring (retrofit): timeframe `< 3 months` **+30**, homeowner **+20**,
battery/EV interest **+10** each, spend `€150–€200` **+10** / `Over €200`
**+15**, no existing solar **+5**, detached/semi/bungalow **+5**. Tiers:
`score ≥ 60 → hot`, `≥ 35 → warm`, else cold. Seller: selling `< 3 months`
+25, wants-valuation +15. Landlord: `3–5` properties +20 / `6+` +25,
unmanaged +10, wants-appraisal +15. Buyer: mortgage AIP +15, timeline <3mo +25.

**Urgency (roofing-style emergencies):** every inbound answer is scanned for
`URGENCY_KEYWORDS` (`leak`, `flooding`, `emergency`, `water damage`, `storm
damage`). A hit sets `run.priority = "high"`, audits `flow.urgent`, and
best-effort POSTs a `{type:"calla:message", payload:{urgent:true, flowId,
leadKey, keyword, text}}` frame to `{CALLA_EDGE_URL}/events/ingest` so the web
UI live feed alerts a human immediately (once per run). The flow itself
continues — deterministic-first doctrine.

### Runner semantics (`src/flows/runner.ts`)

`startFlow → answerFlow* → completeFlow` (auto-fired on the last answer):

- **Answer matching** — normalization-insensitive (case, whitespace, `–/—/-`
  dashes, `€`): `choice` accepts the exact option, an ordinal (`"1"`, `"2)"`)
  or UNIQUE substring containment either direction (`"semi"` → Semi-detached,
  `"owner"` → Homeowner); `yesno` accepts yes/y/yeah/yep/sure… vs no/n/nope/
  nah…; `eircode` accepts a loose Irish Eircode (`"D15 XY23"`) or a Dublin
  district (`"Dublin 15"`, stored raw — anything unmatched is also stored
  raw); `email` uses a simple full-string regex (mismatch → re-prompt);
  `number` strips `€`/commas; `text` stores trimmed raw, optional fields
  accept `"skip"`/`"none"`/`"n/a"`. Unmatched `choice`/`yesno`/`email`
  answers **re-prompt the same question** (`matched:false`) — never guessed.
- **skipIf** — `{field, equals}` skips a field when an earlier answer matches
  (e.g. landlord `current_agent` only when currently managed).
- **Active-run handoff** — a run started with a `chatRef` is cached at
  `flow:active:<channel>:<chatRef>` (TTL 48h, cleared on complete/cancel);
  `getActiveRun(store, channel, chatRef)` is what channels call FIRST so an
  in-progress qualification swallows subsequent messages. Starting a new run
  on the same identity cancels the old one as `superseded`.
- **Optional LLM extraction** (`FLOWS_LLM_EXTRACT=true`, default OFF) — when a
  `text`/`number` answer doesn't parse, `resolveDynamicAgent(SOCIAL_REPLY_AGENT
  || "miles")` is asked for a strict-JSON `{"value": …}` extraction; failures
  fall back to storing the raw text.
- **Completion** — deterministic score → tier → routing → lead patch →
  audits. The engine lead (when `leadKey` is set) is PATCHed via the shared
  data-plane client (`lib/engine-client.ts`): `classification` = JSON `{tier,
  fit: score/100, flowId, vertical, sequenceTag?, priority?, answersSummary}`,
  `research` = MERGED JSON `{...existing, flowAnswers, flowCompletedAt, tier,
  score}` (existing row read back via `GET /cmd/data/row?key=`). `status`/
  `stage` are **never touched** — same no-downgrade doctrine as social
  capture. Best-effort + audited (`leadPatched` in `flow.completed`).

### Routing & booking proposals (`src/booking/routing.ts`)

`RoutingRule {id, match:{eircodePrefixes?, country?, source?, tier?,
vertical?}, repId, branchName?, enabled?}` lives at cache key
`routing:rules` (agentId `booking`, seeded empty). `routeLead()` returns the
rep of the **first matching enabled rule** (all present criteria must hold;
Eircode prefixes match the normalized uppercase Eircode via `startsWith` —
`"D15"` covers Dublin 15), falling back to the policy default (first enabled
rep), else null (tag-only completion).

On completion with the booking intent satisfied, the routed rep's next **3
slots** inside a today/tomorrow (48h) window are computed **in-process** with
the booking module's own machinery: provider free-busy (`googleBusy` /
`msGetSchedule` through `getFreshConnection`) + `scheduling.findAvailableSlots`
in the rep's timezone (Europe/Dublin default); when the calendar isn't
connected the slots are work-hours-only and flagged `provisional`. Calendly
reps have no API availability — `routing.link` carries the scheduling link
instead. The runner audits `flow.routed`, relays a `{type:"calla:message",
payload:{routed:true, repId, leadKey, slots}}` frame to the edge ingest, and
returns the conversational proposal: *"Great news — we can arrange your
survey. Would Mon 5 Oct, 09:00 or Mon 5 Oct, 09:45 suit?"* (channel layer
sends it). **Post-booking:** when the human/channel confirms a slot,
`POST /flows/runs/:id/book {slotStart, attendee?}` is a convenience wrapper
over the same provider create used by `POST /booking/appointments` (with
`context.leadKey`); it audits `flow.booked` and stamps
`run.routing.bookedAppointmentId`. Calendly reps → `400 + {link}` (share the
link; the Calendly webhook mirrors the booking back).

### REST (behind bearer auth)

| Method | Route | Notes |
| --- | --- | --- |
| GET | `/flows/definitions` | builtins (code) + customs (store), merged |
| POST | `/flows/definitions` | create a custom flow (409 dup / builtin id) |
| GET | `/flows/definitions/:id` | one definition (+ `builtin` flag) |
| PUT | `/flows/definitions/:id` | custom only — builtin → 400 `builtin flows are versioned in code` |
| DELETE | `/flows/definitions/:id` | custom only |
| POST | `/flows/runs` | `{flowId, leadKey?, channel?:"rest", chatRef?, initialAnswers?}` → `201 {run, prompt}` |
| GET | `/flows/runs?status=&limit=` | capped index (200, newest first) |
| GET | `/flows/runs/:id` | full run (answers, score, tier, routing, priority) |
| POST | `/flows/runs/:id/answer` | `{text}` → `{run, prompt?, done?, summary?, matched?}` |
| POST | `/flows/runs/:id/cancel` | `{reason?}` → audit `flow.abandoned` |
| POST | `/flows/runs/:id/book` | `{slotStart, attendee?}` → `201 {appointment, run}` (calendly → 400 + link) |
| GET/POST | `/flows/routing/rules` | list / create (first match wins; rep must exist) |
| DELETE | `/flows/routing/rules/:id` | remove a rule |

### Social handoff (Instagram / TikTok)

`SocialTrigger.action` gained `"flow"` (+ required `flowId`). In
`handleSocialInbound`, AFTER capture-by-default (leads keep flowing) and
BEFORE any persona draft: an **active run** for chatRef
`<platform>:<externalUserId>` (channel `social`) consumes the message —
`answerFlow()` records it and the next prompt goes out under the standard
send policy (auto inside the reply window; window closed / approval mode /
send failure → the existing HITL approval card containing the prompt text).
No persona reply while a flow owns the chat. A `flow` trigger match starts
the run with `leadKey = IG:<username>` / `TT:<...>` and sends the first
prompt. Example (operators configure via `PUT /channels/social/triggers`;
NOT force-seeded — the safety-first defaults are unchanged):

```json
{ "id": "ig-solar-flow", "scope": "dm", "match": "keyword", "value": "solar",
  "action": "flow", "flowId": "retrofit-solar-qualification", "mode": "auto" }
```

Audits: `social.flow_started`, `social.flow_step`, `social.sent
{auto:true, flow:true}` (agentId `social`).

### Ireland notes

- **Eircode routing** — rules match normalized Eircode prefixes (`D15`,
  `A65`, …); loose acceptance includes Dublin-district answers (`"Dublin 15"`
  stored raw) so routing degrades gracefully to the policy default.
- **Europe/Dublin slots** — proposals are computed in the rep's IANA timezone
  via the booking module's DST-safe Intl math and rendered as local wall time
  in the proposal text ("Mon 5 Oct, 09:00"); wire values stay ISO-8601 UTC.
- **GDPR** — flow answers are business enquiry data attached to the existing
  lead row (classification/research patch only); attendee data at booking
  time stays minimized (name + optional email/phone), and audit rows carry
  ids/scores — never tokens.

### Wave-2 integration (WhatsApp customer channel + Meta Lead Forms)

**IMPLEMENTED** — see "WhatsApp customer conversations" and "Meta Lead Forms +
embeddable website widget" above (`channels/whatsapp.ts` customer routing,
`channels/facebook.ts`, `forms/widget.ts`). They start flows with
`channel:"whatsapp"` (chatRef `whatsapp:<phone>`), `channel:"leadform"`
(chatRef `leadform:<leadgen_id>`) or `channel:"form"` (chatRef
`form:<session>`) and answer via the runner. Import exactly:

```ts
import { getActiveRun, startFlow, answerFlow, formatPromptText } from "./flows/runner.js";

// inbound message (WhatsApp customer):
const chatRef = `whatsapp:${phone}`;
const runId = await getActiveRun(store, "whatsapp", chatRef);
const step = runId
  ? await answerFlow(store, runId, text)
  : await startFlow(store, { flowId, leadKey, channel: "whatsapp", chatRef, initialAnswers });
if (step.error) { /* 404/409 — no active run, bad flow id */ }
const outbound = step.done ? step.summary?.message : formatPromptText(step.prompt!);
// matched:false → the same prompt is returned; re-ask as-is.
// step.summary?.slots / link → booking proposal; confirm via bookRunSlot()
// (or POST /flows/runs/:id/book).
```

Lead Forms payloads map naturally onto `initialAnswers` (prefilled fields are
skipped; a fully-prefilled run completes immediately with `done:true`).

## Conversations API (operator console)

**Every social/WhatsApp customer conversation, in one place** — `src/conversations/**`,
mounted at `/conversations` (behind the same bearer auth). The social engine
records each normalized inbound and each outbound it produces into a per-thread
row (`conv:thread:<platform>:<userId>`, agentId `conversations`) plus a
newest-first index (`conv:index`), so operators can read the whole exchange,
**pause automation for one thread** (takeover) and **reply manually** through
the platform sender. No new npm dependencies; persistence is CallaStore cache
only (same pattern as `flows/store.ts` / `booking/store.ts`).

### Contract (frozen — `apps/ui` codes against this)

| Method | Route | Request | Response |
| --- | --- | --- | --- |
| GET | `/conversations?platform=&limit=50` | — | `{conversations:[{id:"<platform>:<userId>", platform:"instagram"\|"tiktok"\|"whatsapp", username?, phone?, lastMessage, lastAt, messageCount, takeover:boolean, leadKey?, flowRunId?, flowStatus?:"active"\|"completed", flowTier?}], total}` |
| GET | `/conversations/:id` | — | `{id, platform, contact:{username?, phone?, externalUserId}, messages:[{dir:"in"\|"out", text, ts, auto?, kind?, approvalId?}], takeover:boolean, lead?:{key, source}, flowRun?:{id, flowId, status, currentField?, answers, score?, tier?, routing?}}` — 404 unknown thread, 400 malformed id |
| POST | `/conversations/:id/message` | `{text}` (1–4000 chars) | `{ok:true, message:{dir:"out", text, ts, auto:false, kind:"manual"}}` — provider/window errors → **502 `{error}`** and NOTHING is stored; 400 empty/oversized text, 404 unknown thread |
| POST | `/conversations/:id/takeover` | `{on:boolean, by?}` | `{ok:true, takeover:boolean}` + audit `conversation.takeover` (404 unknown thread) |
| DELETE | `/conversations/:id` | — | `{ok:true, id}` — wipes the thread + its index entry + audit `conversation.deleted` (404 when unknown) |

`kind` is one of `message` (a plain inbound), `flow_prompt`, `persona`,
`static`, `approval_result`, `manual`, `system`. **`system` entries were NOT
delivered to the customer** — they are thread notices (a draft awaiting
approval, a declined draft) and always carry the `approvalId` so the UI can
deep-link to the approvals inbox.

Additive extras (safe for the UI to ignore, not in the frozen shapes):
`windowOpen?:boolean` on `POST /:id/message` (the platform 24h reply-window
state for Instagram/WhatsApp). A **closed window still attempts the send** —
only the provider can refuse it (Meta error 131047 → surfaced verbatim as
502 `{error}`).

> ⚠️ Two honest notes for the UI: (1) `flowStatus` in the LIST only ever
> carries the contract union `"active" | "completed"` — a **cancelled** run
> keeps `flowRunId` with no `flowStatus` (the detail route's `flowRun.status`
> does return `"cancelled"`); (2) Instagram **DM** webhooks carry no @handle,
> so `username` is only populated for comments (and for WhatsApp profile
> names) — `leadKey` falls back to `IG:<userId>` in that case.

### Where recording happens (choke points)

| Pipeline point | Recorded |
| --- | --- |
| `social/engine.ts` `handleSocialInbound` (a2, right after normalization) | every inbound — Instagram, TikTok **and WhatsApp customer chats** (they share this engine) — `dir:"in"`, `kind:"message"` |
| `handleSocialInbound` (b) capture-by-default | `linkLead(id, leadKey)` whenever a lead is created/updated |
| `handleSocialInbound` (c0) active run / `handleFlowStart` | `linkFlowRun(id, runId)` on flow advance and on flow start |
| `sendFlowMessage` auto-send | `dir:"out"`, `kind:"flow_prompt"`, `auto:true` |
| (d) send-policy auto-send | `kind:"static"` (a `reply` trigger) or `kind:"persona"` (agent), `auto:true` |
| `routeToApproval` (approval mode, closed window, no adapter, LLM degrade, failed send) | `kind:"system"` + `approvalId`, `auto:true`, text `(awaiting operator approval — nothing sent: <reason>)` |
| `channels/decisions.ts` social **approve** (after a successful delivery) | `kind:"approval_result"`, `auto:true`, `approvalId` |
| `channels/decisions.ts` social **decline** (nothing is sent) | `kind:"system"`, `auto:true`, `approvalId`, text `(declined by operator — nothing sent)` |
| `POST /conversations/:id/message` (after a successful send) | `kind:"manual"`, `auto:false` + audit `conversation.manual_sent` |

Everything is best-effort: a store failure is logged and swallowed, so
recording can never break a webhook, an approval decision or a REST request.
Read-modify-write cycles are serialized per thread (and per index) by an
in-process promise lock, so two concurrent webhooks cannot drop a message.

### Takeover semantics (pause automation per thread)

`POST /conversations/:id/takeover {on:true}` flips a per-thread flag checked in
`handleSocialInbound` **after** lead capture + inbound recording and **before**
trigger matching / flow routing:

- **Capture continues** — the lead is still created/updated (`IG:`/`TT:`/`WA:`
  keys, engine sync/PATCH unchanged) and the customer's message is still
  recorded, so nothing is lost while a human owns the chat.
- **Automation stops** — no static reply, no persona draft, no approval card,
  no flow prompt. Audit `social.takeover_skipped` `{conversationId, platform,
  kind, leadKey}`.
- **Flows do not advance** while takeover is on. An active run is left exactly
  as it is (its 48h `flow:active:*` TTL keeps ticking); switching takeover off
  resumes it on the customer's next message.
- **Manual replies only** — `POST /conversations/:id/message` is unaffected by
  the flag (that is the point of takeover).
- Approval cards created **before** takeover can still be decided from the
  Telegram/WhatsApp consoles; approving one delivers it (takeover gates the
  engine's inbound pipeline, not the decision path).

### Caps, retention & GDPR

- **100 messages per thread** (oldest dropped first) and **200 threads in the
  index** (oldest dropped first). `messageCount` counts every message ever
  recorded, so it keeps growing past the 100-message window. Message text is
  capped at 4000 chars, index previews at 200. Threads have **no TTL**.
- Threads contain **personal data** (handles, phone numbers, verbatim message
  text). Deletion path: `DELETE /conversations/:id` → the thread row is set to
  `null` with a 1ms TTL (the store's deletion idiom — dropped on the next read)
  and its index entry is removed, then `conversation.deleted` is hash-chain
  audited (`{id, platform, messageCount}`). Audit rows keep only ids/counts —
  never message text — so the audit chain stays intact after a wipe.
- Related retention surfaces: the per-lead capture cache (`social:lead:*`), the
  reply-window markers (`social:ig:window:*`, `social:wa:window:*`) and the
  engine lead row itself are separate; dropping a thread does not delete the
  lead (delete that in Calla Data / the engine).

## Fly.io deploy

Existing `fly.toml` (app `calla-brain`, region iad) + `Dockerfile` (build
context = `packages/calla`; builds `@calla/shared` then `@calla/brain`;
`CMD node apps/brain/dist/server.js`).

```bash
cd packages/calla/apps/brain
fly launch --no-deploy --copy-config   # first time only (or fly apps create calla-brain)
fly secrets set LLM_BASE_URL=... LLM_API_KEY=... LLM_MODEL=... DATABASE_URL=... CALLA_TOKEN=... CALLA_EDGE_URL=https://<edge-worker>
# (or ANTHROPIC_API_KEY=... instead of the LLM_* trio)
# For self-hosted (standalone) auth, set the SAME secret on brain + edge:
#   fly secrets set CALLA_JWT_SECRET=$(openssl rand -hex 32)
fly deploy
```

`fly.toml` sets `PORT=3000`; the server binds `0.0.0.0:$PORT`. With
`DATABASE_URL` set, storage is Postgres (`/health` reports `storage: "pg"`);
otherwise the container falls back to an ephemeral LibSQL file. The durable
Calla store follows the same presence-driven rule (`/health` reports
`callaStore: "pg" | "libsql"`) and creates its `calla_*` tables on boot
(including `calla_users` for self-hosted auth).
