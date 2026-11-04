# Calla brain — messaging channels

Talk to the Calla orchestrator and approve/decline human-in-the-loop (HITL)
items from **Telegram** and **WhatsApp**. This module is a self-contained add-on
under `apps/brain/src/channels/` — it owns nothing else in the brain and adds
**no npm dependencies** (global `fetch`, global `WebSocket` on Node 22, and
`node:crypto` only).

> All of the module's documentation lives here (the integrator merges nothing
> into the brain README or `.env.example`).

---

## 1. What it does

- **Two-way chat** — send a message to your bound Telegram/WhatsApp chat and it
  is forwarded to the orchestrator (`agent.generate`); the reply is sent back.
- **Proactive approvals** — an `ApprovalNotifier` watches the edge worker's
  `/events` WebSocket (edge/cloudflare approvals) *and* polls the brain's own
  pending Mastra approvals every 15s. New HITL items are pushed to every bound
  chat as a card with **Approve / Decline** buttons.
- **One-tap decisions** — pressing a button routes the decision to the right
  backend (edge REST or the brain's approve/decline route) and writes a
  hash-chained `approval.decided` audit entry tagged `via: channel:<platform>`.
- **Fleet status** — `/status` (Telegram) or `status` (WhatsApp) returns pending
  approval counts plus a best-effort edge `/fleet` roster summary.

```
Telegram/WhatsApp  ──▶  channels Hono sub-app (/channels/*)
                              │
                              ├─ bindings (CallaStore cache)
                              ├─ decision registry (in-memory, TTL 24h)
                              ├─ adapters (telegram.ts / whatsapp.ts)
                              └─ ApprovalNotifier ──WS──▶ edge /events
                                            └──15s poll──▶ deps.listPendingMastra()
```

---

## 2. Integrator wiring (server.ts)

`server.ts` already imports `mastra` (from `./mastra/index.js`) and
`getCallaStore` (from `./store/index.js`). Add **two imports**, **two lines**
before `serve(...)`, and **one line** inside the `serve()` callback:

```ts
// ── imports (top of server.ts) ──────────────────────────────────
import { createChannelsApp, startChannels, stopChannels } from "./channels/app.js";
import { buildChannelsDeps } from "./channels/config.js";

// ── after `export const app = new Hono();` + middleware, before serve() ──
const channels = createChannelsApp(buildChannelsDeps(mastra, getCallaStore()));
app.route("/channels", channels);

// ── inside the serve() callback (after the "listening" log) ─────
startChannels();

// ── optional graceful shutdown ──────────────────────────────────
// process.on("SIGTERM", () => { stopChannels(); });
```

`buildChannelsDeps(mastra, store, edgeBaseUrl?)` defaults `edgeBaseUrl` to
`CHANNELS_EDGE_EVENTS_URL ?? CALLA_EDGE_URL ?? http://127.0.0.1:8787`, so the
2-arg form above is enough. `startChannels()` is idempotent; it starts Telegram
polling (or sets the webhook) and the notifier only when a platform is enabled.

### ⚠️ Auth exemption for webhooks (IMPORTANT)

The brain's Bearer-token auth (`CALLA_TOKEN`) protects every non-public route.
The inbound **webhook** routes are called by Telegram/WhatsApp — they cannot
present `CALLA_TOKEN`. They are secured by their platform-native scheme
instead, so they **must be exempt** from the brain's Bearer auth:

- `POST /channels/telegram/webhook` — verified via the
  `X-Telegram-Bot-Api-Secret-Token` header (when `TELEGRAM_WEBHOOK_SECRET` set).
- `GET  /channels/whatsapp/webhook` — Meta verify handshake (`hub.verify_token`).
- `POST /channels/whatsapp/webhook` — verified via `X-Hub-Signature-256` HMAC.

Keep these **behind** auth (they are operator/admin only):
`POST /channels/bindings/code`, `GET /channels/bindings`,
`POST /channels/test/notify`, `GET /channels`.

---

## 3. Environment variables

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `TELEGRAM_BOT_TOKEN` | to enable Telegram | — | Bot token from @BotFather. Presence enables the platform. |
| `TELEGRAM_API_BASE` | no | `https://api.telegram.org` | Bot API base (`/bot<token>/<method>`). **Override for mock testing.** |
| `TELEGRAM_WEBHOOK_URL` | no | — (polling) | Public HTTPS URL. If set → webhook mode + `setWebhook`. If unset → long-polling (dev). |
| `TELEGRAM_WEBHOOK_SECRET` | no | — | Secret token Telegram echoes in `X-Telegram-Bot-Api-Secret-Token`; enforced when set. |
| `WHATSAPP_TOKEN` | to enable WhatsApp | — | Permanent System-User access token. |
| `WHATSAPP_PHONE_NUMBER_ID` | to enable WhatsApp | — | Phone-number ID from the Meta app. |
| `WHATSAPP_VERIFY_TOKEN` | recommended | — | Arbitrary string you also paste into the Meta webhook config (GET handshake). |
| `WHATSAPP_APP_SECRET` | recommended | — | App Secret for `X-Hub-Signature-256` HMAC. **If unset, webhooks are accepted WITHOUT verification (a WARN is logged).** |
| `WHATSAPP_API_BASE` | no | `https://graph.facebook.com/v21.0` | Cloud API GRAPH base (`/<phone-number-id>/messages`). Override for mocks. |
| `CHANNELS_EDGE_EVENTS_URL` | no | `CALLA_EDGE_URL` or `http://127.0.0.1:8787` | Edge base for the WS `/events` stream, `/fleet`, and edge decisions. |
| `CHANNELS_BRAIN_LOOPBACK` | no | `http://127.0.0.1:${PORT}` | Loopback base for brain-side Mastra decisions (see §7). |
| `PORT` | no | `3000` | Brain port — used to build the loopback decision URL. |
| `CALLA_TOKEN` | no | — | When set, forwarded as `Bearer` on the loopback decision call. |

A platform is **enabled** iff its required vars are present
(Telegram: `TELEGRAM_BOT_TOKEN`; WhatsApp: `WHATSAPP_TOKEN` **and**
`WHATSAPP_PHONE_NUMBER_ID`).

---

## 4. Telegram setup (DORMANT — out of scope for the Irish market per founder decision 2026-10-03; kept disabled-by-default, operator approvals ride WhatsApp + web inbox)

1. **Create the bot** — message [@BotFather](https://t.me/BotFather) →
   `/newbot` → choose a name + username → copy the **bot token** into
   `TELEGRAM_BOT_TOKEN`.
2. **Pick a delivery mode:**
   - **Polling (dev, no public URL):** leave `TELEGRAM_WEBHOOK_URL` unset. On
     `startChannels()` the adapter long-polls `getUpdates` (timeout 25s, 3s
     backoff on errors). Simplest for local development.
   - **Webhook (prod):** set `TELEGRAM_WEBHOOK_URL` to a public HTTPS URL that
     routes to `POST /channels/telegram/webhook` (e.g.
     `https://brain.example.com/channels/telegram/webhook`). On
     `startChannels()` the module calls `setWebhook(url, secret_token)`
     best-effort. Optionally set `TELEGRAM_WEBHOOK_SECRET` and Telegram will
     echo it in `X-Telegram-Bot-Api-Secret-Token` (the route rejects mismatches
     with 401).
     You can also set the webhook manually:
     `curl "https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>&secret_token=<SECRET>"`.
3. **Bind your chat** — see §6.

> Polling and webhook are mutually exclusive: if `TELEGRAM_WEBHOOK_URL` is set
> the module uses webhook mode and does **not** poll.

---

## 5. WhatsApp setup (Meta Cloud API)

1. Create a **Meta for Developers** app → add the **WhatsApp** product.
2. In **WhatsApp → API Setup**, copy:
   - **Phone number ID** → `WHATSAPP_PHONE_NUMBER_ID`
   - A **temporary** token to test; for production create a **System User** in
     Business Settings, grant `whatsapp_business_messaging` +
     `whatsapp_business_management`, and generate a **permanent** token →
     `WHATSAPP_TOKEN`.
3. Copy the **App Secret** (App Dashboard → Settings → Basic) →
   `WHATSAPP_APP_SECRET`.
4. Configure the webhook (WhatsApp → Configuration):
   - **Callback URL** → `https://brain.example.com/channels/whatsapp/webhook`
   - **Verify token** → any string; put the same value in `WHATSAPP_VERIFY_TOKEN`.
     Meta sends `GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…`;
     the route echoes `hub.challenge` when the token matches.
   - **Subscribe** to the `messages` webhook field.
5. **Bind your number** — see §6.

WhatsApp notes: reply buttons are capped at 3 with titles ≤ 20 chars, and sent
messages **cannot be edited**, so after a decision the module sends a follow-up
confirmation text. Delivery `statuses` in the webhook are ignored.

---

## 6. Binding flow (single operator, v1)

Bindings map a chat to Calla using a short-lived code. The CallaStore **cache**
is the only storage used (`cacheGet`/`cacheSet`) — the interface is not
extended, and a small index key makes `listBindings()` possible without a scan.

1. Mint a code (behind brain auth):
   ```bash
   curl -X POST https://brain.example.com/channels/bindings/code \
        -H "Authorization: Bearer $CALLA_TOKEN" \
        -H "content-type: application/json" \
        -d '{"platform":"telegram"}'      # platform optional; scopes the code
   # → { "code": "K7Q2ZX", "expiresIn": 600 }
   ```
2. From your chat, redeem it (codes are 6 chars `A-Z0-9`, valid 10 min,
   single-use):
   - **Telegram:** send `/start K7Q2ZX`
   - **WhatsApp:** send `K7Q2ZX` alone (a lone 6-char alnum token is treated as
     a code; if it is not valid it falls through to a normal message).
3. Verify / manage:
   ```bash
   curl https://brain.example.com/channels/bindings -H "Authorization: Bearer $CALLA_TOKEN"
   # → { "bindings": [{ "platform":"telegram", "chatId":"••••4321", "boundAt":"…" }], "count":1 }
   ```
   Send `/unbind` (Telegram) or `unbind` (WhatsApp) to remove a binding.

Cache keys (agentId `channels`): `chan:code:<code>` (TTL 10m),
`chan:bind:<platform>:<chatId>` (no TTL), `chan:index` (no TTL). Notifier dedupe
uses `chan:notified:<id>` / `chan:resolved:<id>` (TTL 24h).

---

## 7. Decision routing & the loopback choice

A button's `callbackData` encodes only a compact pointer; the full context lives
in an in-memory registry (see §8). On press:

- **edge / cloudflare approvals** → `deps.decideEdgeApproval(agentName,
  approvalId, approved)` →
  `POST {edge}/approvals/{agentName}/{approvalId}/decision {approved}`.
  `agentName` comes from `ApprovalRequest.agentId`; `approvalId` from
  `ApprovalRequest.approvalId ?? .id`.
- **mastra approvals** → `deps.decideMastraApproval(runId, toolCallId,
  approved, reason?)`.

**Why loopback for Mastra?** The brain decides its own Mastra approvals via
`agent.approveToolCall/declineToolCall`, which are wrapped by the routes in
`server.ts` (with their store hooks + auth). To avoid reaching into `server.ts`
internals, the default `decideMastraApproval` calls the brain's **own** loopback
route:

```
POST http://127.0.0.1:${PORT}/agents/orchestrator/approve-tool-call   (or decline-tool-call)
Authorization: Bearer ${CALLA_TOKEN}   # only when CALLA_TOKEN is set
{ "runId": "...", "toolCallId": "..." }
```

Override with `CHANNELS_BRAIN_LOOPBACK` if the brain listens on a different
host/interface, or pass your own `decideMastraApproval` to `buildChannelsDeps`
(e.g. calling `mastra.getAgent(...).approveToolCall(...)` directly) to skip the
HTTP hop.

After every decision the module appends a best-effort audit entry:
`appendAudit({ kind: "approval.decided", entry: { via: "channel:<platform>",
chatId: <masked>, approvalId, approved, source, toolName, … } })`.

---

## 8. Callback-data encoding scheme

Telegram caps `callback_data` at **64 bytes** and WhatsApp reply-button payloads
are similarly constrained, but Mastra `runId`/`toolCallId` are UUIDs. So the
payload is a compact pointer and the full context is stored locally:

```
callbackData = "c:<shortId>:<a|d>"      # e.g. "c:k7q2zx9f:a"  (~12 bytes)
                        │      └── action: a = Approve, d = Decline
                        └───────── 8-char base36 key into the DecisionRegistry
```

`DecisionRegistry` (in-memory `Map`, **TTL 24h**, lazy expiry) maps `shortId` →
`DecisionContext { source, approvalId, agentId, agentName?, runId?, toolCallId?,
toolName, createdAt }`. `buildApprovalCard()` registers the context and emits
the two buttons; `executeDecision()` decodes → resolves → routes → audits. If
the entry expired, the user gets a friendly "expired, use /approvals" message.

---

## 9. HTTP routes (mounted at `/channels`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/` | brain | `{ enabled, platforms: { telegram:{enabled,mode,webhookSet?}, whatsapp:{enabled,mode} }, bindings }` |
| `POST` | `/telegram/webhook` | **exempt** (secret header) | Telegram update → `handleWebhookUpdate` → `"ok"` |
| `GET` | `/whatsapp/webhook` | **exempt** (verify token) | Meta handshake → `hub.challenge` or 403 |
| `POST` | `/whatsapp/webhook` | **exempt** (HMAC) | Signature-gated → `handleWebhookEvent` → `{ok:true}` |
| `POST` | `/bindings/code` | brain | `{platform?}` → `{ code, expiresIn: 600 }` |
| `GET` | `/bindings` | brain | list bindings (chatIds masked to last 4) |
| `POST` | `/test/notify` | brain | `{text?}` → push a test card to all bound chats → `{ok,sent,total}` |

### Chat commands

| Action | Telegram | WhatsApp |
|---|---|---|
| Bind | `/start <code>` | send `<code>` alone |
| Unbind | `/unbind` | `unbind` |
| Status | `/status` | `status` |
| List approvals | `/approvals` | `approvals` |
| Ask orchestrator | `/ask <text>` **or** any plain text | `ask <text>` **or** any plain text |
| Help | `/help` | `help` |

`/approvals` lists up to 5 pending brain approvals as cards with Approve/Decline
buttons. Agent replies are Markdown-stripped and chunked to the 4096-char limit.

---

## 10. Testing with a mock Telegram Bot API

No real tokens are needed. Point `TELEGRAM_API_BASE` (and/or `WHATSAPP_API_BASE`)
at a local stub that returns `{ "ok": true, "result": … }` per method and records
calls:

```js
// fake-telegram.mjs — node fake-telegram.mjs
import http from "node:http";
http.createServer((req, res) => {
  let raw = ""; req.on("data", c => raw += c); req.on("end", () => {
    const method = new URL(req.url, "http://x").pathname.split("/").pop();
    const body = raw ? JSON.parse(raw) : {};
    console.log(method, JSON.stringify(body));         // RECORD
    const result = method === "getUpdates" ? [] : { message_id: 1, ...body };
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true, result }));
  });
}).listen(3990);
```

```bash
TELEGRAM_BOT_TOKEN=test TELEGRAM_API_BASE=http://127.0.0.1:3990 \
  node --import tsx your-test.ts      # or run against dist/channels
```

The module's pieces are independently constructible for unit tests:
`InMemoryDecisionRegistry`, `CacheBindingStore` (pass any object implementing
`cacheGet/cacheSet/listApprovals/appendAudit`), `TelegramAdapter`,
`WhatsAppAdapter`, and `ApprovalNotifier` (call `handleFrame(frame)` directly to
feed a synthetic `calla:approval:request` without a live WS). `buildApprovalCard`
and `executeDecision` are exported from `decisions.ts`.

---

## 11. Files

| File | Role |
|---|---|
| `types.ts` | Shared interfaces (`ChannelAdapter`, `ChannelDeps`, `Binding`, `ChannelsConfig`, `DecisionRegistry`, `DecisionContext`, …). |
| `util.ts` | HTML-escape, mask, chunk, strip-markdown, truncate, random codes/ids, risk emoji. |
| `decisions.ts` | `InMemoryDecisionRegistry`, callback codec, `buildApprovalCard`, `executeDecision`, row→`ApprovalRequest` mapping, decision audit. |
| `commands.ts` | Platform-agnostic `askOrchestrator`, `fleetSummary`, `helpText`. |
| `bindings.ts` | `CacheBindingStore` — codes, bindings, and the `chan:index` list (cache-only). |
| `config.ts` | `readConfig()` + `buildChannelsDeps()` (default fetch-based decide routing). |
| `telegram.ts` | `TelegramAdapter` — Bot API send/edit, webhook + polling, commands, callbacks. |
| `whatsapp.ts` | `WhatsAppAdapter` — Cloud API send, verify + HMAC, webhook events, commands, **customer-mode routing** (§14) + the shared `sendWhatsAppText()` / `extractWhatsAppInbound()` helpers. |
| `facebook.ts` | **Meta Lead Forms** ingestion (§15) — verify/HMAC, full-lead fetch, field mapping, lead capture + prefilled flow start. |
| `notifier.ts` | `ApprovalNotifier` — edge WS + 15s Mastra poller, dedupe, resolved follow-ups. |
| `app.ts` | `createChannelsApp()`, `startChannels()`, `stopChannels()`, `channelsStatus()`. |
| `index.ts` | Barrel re-export. |

---

## 12. Resilience & security notes

- **Never crashes the server:** WS connect/message/reconnect, store calls, and
  outbound sends are wrapped in try/catch + `console.warn`. The notifier
  reconnects forever with `1s·2^n` (capped 30s) + jitter and pings
  (`calla:ping`) every 60s.
- **Webhook secrets:** Telegram `X-Telegram-Bot-Api-Secret-Token` (when
  `TELEGRAM_WEBHOOK_SECRET` set) and WhatsApp `X-Hub-Signature-256`
  (`timingSafeEqual` over the raw body). Set `WHATSAPP_APP_SECRET` in production
  — without it, webhooks are accepted unverified (WARN logged).
- **Least privilege:** chat/user ids are masked (last 4) in audit entries and
  the `/bindings` listing. Binding codes are single-use, 10-minute TTL.
- **No interface changes:** only `cacheGet/cacheSet` (bindings + dedupe) and
  `listApprovals/appendAudit` (approvals + audit) are used from `CallaStore`.

## 12. Relationship to first-party Mastra channel packages

Evaluated 2026-10-03 against `@mastra/telegram@0.2.1` (peer `@mastra/core
>=1.22 <2.0` — compatible with our 1.74) and `@chat-adapter/telegram` /
`@chat-adapter/whatsapp@4.41.1`:

| Concern | This module (hand-rolled) | @mastra/telegram + chat adapters |
|---|---|---|
| HITL approval cards w/ inline Approve/Decline buttons + decision registry | ✅ core feature | ❌ chat transport only |
| Binding codes (`/start <code>`), audit-chain integration (`via:"channel:*"`) | ✅ | ❌ |
| Edge `/events` notifier (live approval push) + mastra suspended-run poller | ✅ | ❌ |
| Zero dependencies (raw Bot API / Graph API via fetch) | ✅ | adds provider + adapter tree |
| Streaming replies (post-then-edit), typing indicators, multi-bot installs | ❌ (single reply) | ✅ |
| Webhook route generation | manual (our Hono routes) | `getRoutes(): ApiRoute[]` (designed for the Mastra deployer; mountable manually) |
| Maturity | ours, tested (38 mock checks) | `@mastra/telegram` is alpha (0.2.x) |

**Decision:** keep this module for Calla's operator HITL channel — the
first-party providers don't do approval buttons, bindings, or audit wiring,
and their route generation targets the Mastra deployer server, not our custom
Hono app. **Migration path:** if we later need multi-bot installs, streaming
message edits, or typing indicators for agent chat, mount `TelegramProvider`
(from `@mastra/telegram`, `getRoutes()`) alongside this module for the chat
surface and keep this module for approvals. Env aliases already accepted:
`WHATSAPP_ACCESS_TOKEN` (chat-adapter convention) and `TELEGRAM_TOKEN`.

---

## 13. Instagram & TikTok (social)

ManyChat-style **reply automation for business social accounts**, built on the
OFFICIAL platform APIs — Meta's *Instagram API with Instagram Login* and the
*TikTok Business Messaging API* (Login Kit v2 OAuth). Code lives in
`src/channels/social/` and plugs into `app.ts` exactly like the Telegram /
WhatsApp adapters (same `InMemoryDecisionRegistry`, same `CallaStore`, same
audit chain, **no new npm dependencies** — global `fetch` + `node:crypto`).

The design goal is a **human-in-the-loop, safety-first** social inbox: inbound
DMs/comments/postbacks are normalized, optionally captured as leads, matched
against editable triggers, and either auto-replied (only inside the platform
reply window and only for low-risk flows) or gated behind an approval that the
EXISTING Telegram/WhatsApp cards — and the web UI inbox — can decide.

### 13.1 Platform facts (verified 2026)

**Instagram — "Instagram API with Instagram Login"**
- Base `https://graph.instagram.com/v21.0` (override `IG_API_BASE` for the legacy
  `graph.facebook.com` mode or a local mock).
- Send DM: `POST {base}/me/messages` `{recipient:{id}, message:{text}}`,
  `Authorization: Bearer IG_ACCESS_TOKEN`.
- Comment reply = **private reply**: `POST {base}/{commentId}/private_replies`
  `{recipient:{comment_id}, message:{text}}` — ONE reply per comment, within
  **7 days**. The path template is configurable (`IG_PRIVATE_REPLY_PATH`,
  `{commentId}` token) because Meta has relocated this endpoint before.
- Webhooks: `GET` echoes `hub.challenge` when `hub.verify_token === IG_VERIFY_TOKEN`;
  `POST` bodies carry `X-Hub-Signature-256 = HMAC-sha256(rawBody, IG_APP_SECRET)`
  (verified with `timingSafeEqual`; accepted-but-warned when the secret is unset —
  set `IG_APP_SECRET` in production).
- Inbound payload → `SocialInbound`:
  ```jsonc
  { "object": "instagram", "entry": [ {
      "messaging": [ { "sender": {"id"}, "recipient": {"id"}, "timestamp",
                       "message": {"mid","text"} | "postback": {"payload"} } ],
      "comments":  [ { "id", "from": {"id","username"}, "message", "media", "timestamp" } ]
  } ] }
  ```
  normalizes to `{platform, kind:"dm"|"comment"|"postback"|"story_mention",
  externalUserId, username?, text, commentId?, ts, raw}`.
- **24h reply window** from the last inbound message — tracked in the store cache
  at `social:ig:window:<id>` (TTL 24h). Outside the window auto-send is blocked
  → routed to approval.
- **Rate limit ≈ 2 sends/sec** → a shared per-platform sequential send queue
  spaces deliveries 600ms apart (`social/queue.ts`).

**TikTok — Business Messaging API (Login Kit v2)**
- REQUIRES a **Business** account. Automation is only permitted inside
  **user-initiated** conversations (Calla never cold-DMs).
- **Comment-to-message is REGION-GATED.** Availability at the time of writing:

  | Region | Comment-to-message | Notes |
  |---|---|---|
  | Selected SEA (e.g. ID/TH/VN/PH/MY) | 🟡 partial rollout | Business account required; verify per-account. |
  | EEA / UK / Switzerland | 🔴 NOT available | Do not enable comment flows. |
  | Rest of world | 🟡 varies | Confirm in the TikTok developer portal. |

  This warning is surfaced live by `GET /channels`
  (`platforms.tiktok.regionWarning`) whenever TikTok is enabled.
- Webhook verification supports `TIKTOK_WEBHOOK_MODE=challenge` (GET `hub.challenge`
  echo when the token matches `TIKTOK_VERIFY_TOKEN`) or `body` (token carried in
  the POST body). Inbound parsing is **defensive**: the documented shape is
  `{event:"message.receive", data:{conversation_id, message:{text, sender:{user_id}}}}`;
  unknown shapes are logged and return HTTP 200 (no retry storm).

> ⚠️ **TikTok paths need portal verification with real keys.** The exact
> production endpoint paths cannot be confirmed without developer credentials,
> so ALL of them are isolated in config with env overrides (`TIKTOK_API_BASE`
> default `https://business-api.tiktok.com/open_api/v1.3`, `TIKTOK_SEND_PATH`
> default `im/dm/send/`) and marked `TODO(tiktok-keys)` in `social/config.ts` +
> `social/tiktok.ts`. Re-verify the method, path, auth header (`Access-Token` vs
> `Bearer`) and body schema against the TikTok developer portal before relying on
> them in production.

### 13.2 Meta app setup (Instagram)

1. In the Meta App Dashboard create an app of type **"Instagram Login"**
   (business-facing; not "Business Login", not the deprecated legacy Instagram
   platform).
2. Add the **Instagram** product and request the permissions:
   - `instagram_business_basic` (profile + read inbound),
   - `instagram_business_manage_messages` (send DMs + comment private replies).
3. **App Review** is required for **Advanced Access** before these permissions
   work for accounts other than app admins/testers. Until then only Standard
   Access (app-role users) can message.
4. Grab the **App ID** (`IG_APP_ID`) and **App Secret** (`IG_APP_SECRET`).
5. Subscribe the webhook to the fields: **`messages`**, **`messaging_postbacks`**,
   and **`comments`**. Set the callback URL to
   `https://<brain>/channels/instagram/webhook` and the verify token to
   `IG_VERIFY_TOKEN`.
6. Generate a user access token via the OAuth redirect, then exchange it for a
   long-lived token (see 13.6) and store it as `IG_ACCESS_TOKEN`.

### 13.3 TikTok setup

1. Use a **TikTok Business** account, then a **Login Kit v2** app to obtain an
   access token (`TIKTOK_ACCESS_TOKEN`) with the Business Messaging scope.
2. Configure the webhook (callback URL `https://<brain>/channels/tiktok/webhook`,
   verify token `TIKTOK_VERIFY_TOKEN`, mode `challenge` or `body`).
3. Confirm the account's **region** supports the flows you enable (see 13.1
   region table). Keep TikTok DMs on **approval** mode (the default) unless you
   have explicitly validated auto-reply for the region.

### 13.3b Reddit (reddit-mcp sidecar)

Reddit is **not** a direct-API adapter — it talks to the
[jordanburke/reddit-mcp-server](https://github.com/jordanburke/reddit-mcp-server)
sidecar over streamable-HTTP MCP (`social/reddit-mcp.ts`, enabled by
`REDDIT_MCP_URL`). The sidecar holds the Reddit OAuth + user credentials and the
Responsible-Builder safety rails (safe-mode write pacing, duplicate +
cross-subreddit detection, bot-disclosure footer). The brain never sees the
credentials.

- **Enablement:** the platform is enabled iff `REDDIT_MCP_URL` is set on the
  brain (optional `REDDIT_MCP_TOKEN` bearer when the sidecar runs with
  `OAUTH_ENABLED=true`). Local dev: `npm run dev -- --with-reddit-mcp`
  (npx sidecar on :3011, credentials passed through from the shell). Docker:
  `docker compose -f docker-compose.reddit.yml up -d` (repo root).
- **Inbound — poller, no webhook.** Reddit has no webhook, so
  `startRedditPolling` (every `REDDIT_POLL_MINUTES`, default 20, min 5) runs
  `get_my_overview` → `get_post_comments` on up to 5 recent own posts, and every
  NEW non-OP comment becomes `SocialInbound {platform:"reddit", kind:"comment",
  externalUserId:"t3_<postId>", username:"<u/name>", commentId:"t3_<postId>"}`
  → `handleSocialInbound` (same trigger/lead/HITL pipeline as every platform).
  Dedupe is a 30-day sha1(post:author:body) seen-key (`social:reddit:seen:*`),
  since the sidecar's formatted output carries no comment ids.
- **Outbound:** `sendText`/`sendPrivateReply` both map to `reply_to_post`
  (parent thing id `t3_<postId>` / `t1_<commentId>`), through the shared
  per-platform send queue. v1 limitation: replies land at post level even when
  the trigger was a nested comment.
- **Safety defaults:** reddit fallback is `agent + approval` (public content —
  a human confirms every reply until trusted); no reply-window concept
  (`withinWindow` is a no-op).
- **Credentials reality:** Reddit blocks unauthenticated API calls (403) and is
  closing its public API — new self-serve OAuth stopped 2025-11, unregistered
  apps are removed **2027-01-12**, full shutdown March 2027. The sidecar runs
  **keyless** (Arctic Shift archive reads) without OAuth, but writes and
  `get_my_overview` REQUIRE `REDDIT_CLIENT_ID/SECRET` +
  `REDDIT_USERNAME/PASSWORD` on the SIDECAR; without them the poller degrades to
  a rate-limited warning and every reply degrades to the approval path.
  Smoke test: `npx tsx scripts/reddit-mcp-smoke.ts` (write probe opt-in via
  `REDDIT_SMOKE_WRITE=1`).

### 13.4 Trigger / automation model

Triggers are persisted in the store cache at key **`social:triggers`**
(agentId `social`) and are hot-editable via `GET`/`PUT /channels/social/triggers`.

```jsonc
{
  "instagram": [
    { "id": "ig-comment-ai", "scope": "comment", "match": "keyword",
      "value": "ai", "action": "agent", "mode": "approval" }
  ],
  "tiktok": [],
  "whatsapp": [],
  "reddit":   [],
  "fallback": {
    "instagram": { "action": "agent", "mode": "auto" },
    "tiktok":    { "action": "agent", "mode": "approval" },
    "whatsapp":  { "action": "agent", "mode": "auto" },
    "reddit":    { "action": "agent", "mode": "approval" }
  }
}
```

- `scope`: `"dm"` (dm/postback/story_mention) · `"comment"` · `"any"`.
- `match`: `"keyword"` (case-insensitive substring) · `"regex"` (source in
  `value`) · `"any"`.
- `action`: `"reply"` (static `reply` text) · `"agent"` (persona draft) ·
  `"capture"` (lead only, no reply) · `"none"` · `"flow"` (start a
  qualification flow — see below).
- `mode`: `"auto"` (send inside the reply window) · `"approval"` (HITL gate).
- `agentId?`: persona override (defaults to `SOCIAL_REPLY_AGENT`, then `"miles"`).
- `flowId?`: flow definition id (`action:"flow"` ONLY — required; a flow rule
  without `flowId` is rejected). `"flow"` is not a valid `fallback` action.
- `captureLead?`: force lead capture for this rule (now only material for
  `postback`, since dm/comment/story_mention are captured by default — see 13.7).

**Qualification flows (`action:"flow"`)** — hands the conversation to the
Flowly-style runner in `src/flows` (see the brain README → "Qualification
flows & routing"). A match starts a run with `channel:"social"`, chatRef
`<platform>:<externalUserId>` and `leadKey` = the captured lead key
(`IG:<username>` / `TT:<...>`), then sends the first question under the
trigger's `mode`. While the run is ACTIVE (48h TTL), **every subsequent
inbound message from that chatRef is routed into the runner BEFORE trigger
matching** — no persona reply — and each next prompt follows the send policy
(auto inside the reply window; otherwise the standard approval card carries
the prompt text). Capture-by-default still fires on every message, and
completion patches the lead's `classification`/`research` (never its status).
Example (configured by operators via `PUT /channels/social/triggers`; NOT
force-seeded — the safety-first defaults below are unchanged):

```jsonc
{ "id": "ig-solar-flow", "scope": "dm", "match": "keyword", "value": "solar",
  "action": "flow", "flowId": "retrofit-solar-qualification", "mode": "auto" }
```

Audits (agentId `social`): `social.flow_started`, `social.flow_step`,
`social.sent {auto:true, flow:true}`; the runner adds `flow.*` audits under
agentId `flows` (including `flow.urgent` for leak/emergency answers).

**Matching order:** specific rules (in array order) first, then the per-platform
`fallback`. Validation is strict on structure but **defaults `mode` to
`approval`** when unspecified (safety-first). A `reply` rule with no text, or a
keyword/regex rule with no `value`, is rejected (400).

**Default-safety rationale (Calla HITL doctrine):**
- **Instagram comment "ai" → agent + approval.** Comment replies are public,
  high-blast-radius, and Meta caps you at one private reply per comment within 7
  days — a human should always confirm. Risk on the approval row is **high**.
- **Instagram DM fallback → agent + auto.** 1:1 DMs inside the 24h window are
  user-initiated and private; auto-reply is acceptable (risk **medium**). If the
  window has closed or the LLM errors, it degrades to approval automatically.
- **TikTok DM fallback → agent + approval.** Automation is only allowed in
  user-initiated conversations and comment-to-message is region-gated, so we keep
  a human in the loop by default.

Replies are generated via `resolveDynamicAgent(agentId).generate(...)` so the
tenant's **editable persona** (e.g. the builtin `miles` for gradient3.io) drives
tone. The prompt passes the inbound text + platform context and asks for an
in-persona reply **under 300 characters**.

### 13.5 Send policy, approvals & decisions

```
inbound → markWindow + audit social.received
        → match trigger (needed for capture gating)
        → lead capture-by-default (first=full sync → social.lead_captured;
          subsequent=data-row PATCH → social.lead_updated; best-effort, see 13.7)
        → ACTIVE qualification run for <platform>:<externalUserId>?
             ├─ yes → answerFlow() + send next prompt (auto/approval) → STOP
             └─ no  → trigger action "flow"? → startFlow() + first prompt → STOP
        → match trigger → draft (static | agent.generate | none)
        → mode==auto AND windowOk AND !llmError
             ├─ yes → adapter send (via 600ms queue) + audit social.sent {auto:true}
             └─ no  → store.recordApproval(source:"mastra",
                        toolName:`social-<platform>-<kind>`,
                        args:{externalUserId, username, text, draft, commentId?, leadKey},
                        risk: comment→high / dm→medium,
                        summary:`Reply to @<username> on <platform>`)
                     + register a SOCIAL DecisionContext
                     + relay calla:approval:request → {CALLA_EDGE_URL}/events/ingest
```

Because the approval is recorded with `source:"mastra"` and a
`social-<platform>-<kind>` tool name, `decisions.contextFromApproval()` recognizes
it and builds a **social** `DecisionContext`. That means the EXISTING
Telegram/WhatsApp approval cards (pushed by the notifier over the edge WS or the
15s Mastra poll) and the web UI inbox can Approve/Decline it with no new UI:

- **Approve** → `executeDecision` looks up the platform sender
  (`social/senders.ts`) and delivers the draft (as an IG comment **private reply**
  when `commentId` is present) through the same rate-limited queue →
  audit `social.sent {auto:false}`.
- **Decline** → audit `social.declined`; nothing is sent.
- Either way a standard `approval.decided` audit entry is written
  (`via:"channel:<platform>"`).

**Resilience:** an LLM failure NEVER crashes — it degrades to an approval whose
draft is the raw inbound text and writes `social.error`. A failed auto-send also
falls back to an approval so a human can retry.

### 13.6 Instagram token exchange walkthrough

The `?code=` from the OAuth redirect is short-lived. `POST /channels/instagram/exchange`
(behind brain auth) does the two-step upgrade for you:

```bash
curl -X POST https://<brain>/channels/instagram/exchange \
  -H "authorization: Bearer $CALLA_TOKEN" -H "content-type: application/json" \
  -d '{"code":"<code-from-redirect>","redirect_uri":"https://<your-callback>"}'
# → { userId, shortLivedToken, longLivedToken, expiresIn, note }
```

1. `POST {base}/access_token` (form: `client_id`, `client_secret`,
   `grant_type=authorization_code`, `redirect_uri`, `code`) → short-lived token.
2. `GET {base}/access_token?grant_type=ig_exchange_token&client_secret=…&access_token=<short>`
   → **long-lived** token (~60 days).

Store the returned `longLivedToken` as **`IG_ACCESS_TOKEN`** (and re-exchange
before it expires). Requires `IG_APP_ID` + `IG_APP_SECRET`.

### 13.7 Lead capture → bi-edge pipeline → Calla Data

**Capture-by-default (founder directive).** *"If queries for this business come
from socials we should be capturing them as leads."* Every inbound of kind
**`dm` | `comment` | `story_mention`** becomes a pipeline lead — **not** only
when an email/@handle happens to be present. Comments count as enquiries ("how
much?", "do you cover Dublin?"); we do **not** skip "trivial" ones — the
pipeline's ICP qualifier scores/filters downstream, so capture stays dumb and
lossless. Only **`postback`** is exempt (it keeps the legacy opt-in gating:
`captureLead` trigger or extracted contact info). Set `SOCIAL_LEAD_CAPTURE=false`
to disable capture entirely.

**Identity + cache state.** The dedupe identity is the stable key
`IG:<username|externalUserId>` / `TT:<username|externalUserId>`. Per-lead state
is cached at **`social:lead:<key>`** (agentId `social`, **no TTL**):
`{ firstCapturedAt, lastSeenAt, messageCount, emailCaptured, syncedStage:"raw",
firstMessage, firstKind }`.

**First vs. subsequent contact (why it matters — no stage clobbering).**
bi-edge `upsertSyncBatch` → `upsertLead` runs `INSERT OR REPLACE INTO leads (…)`,
which is a **whole-row overwrite**. Re-syncing an existing key would reset
`stage→raw`, `status→pending_review` and **NULL** `pitch_subject` / `pitch_body` /
`classification` — i.e. an already-approved/sent lead would be destroyed when the
same person simply DMs again. So:

- **FIRST contact** → `POST $SOCIAL_ENGINE_SYNC_URL` (bi-edge `/inbound/sync`),
  header `X-AD-Sync: $SOCIAL_ENGINE_SYNC_SECRET`:
  ```jsonc
  { "leads": [ {
      "key":    "IG:<username|id>",         // "TT:" prefix for TikTok
      "name":   "<username> | Social enquiry",
      "country":"--",
      "source": "instagram" | "tiktok",
      "stage":  "raw",
      "status": "pending_review",
      "emails": "[{\"addr\":\"bob@example.com\",\"mx_ok\":true}]",  // or null
      "socials":"[{\"platform\":\"instagram\",\"id\":\"<userId>\",\"username\":\"<handle>\"}]",
      "source_url": "https://instagram.com/<username>",           // when derivable
      "research":  "{\"origin\":\"social\",\"kind\":\"dm\",\"firstMessage\":\"…\",\"capturedAt\":\"…\"}"
  } ] }
  ```
  Success → cache written + audit **`social.lead_captured`**
  `{key, platform, kind, username, messageCount, emailCaptured}`.

- **SUBSEQUENT contact** → **partial PATCH** the engine data-plane (never a
  re-sync): `POST {SOCIAL_ENGINE_DATA_URL}/cmd/data/row`
  `{ key, patch:{ research:<merged first↔last>, emails:<only when newly found
  and the lead had none> } }`. bi-edge `updateLead` is
  `UPDATE leads SET <patched cols>, updated_at=now WHERE key=?` — a **partial**
  write that **preserves `stage` / `status` / pitch**, so an advanced lead is
  never downgraded. If the PATCH reports the row is gone (HTTP 404 or
  `{updated:false}`) the engine falls back to a **full re-capture**. Success →
  cache bumped + audit **`social.lead_updated`** (same fields; `emailCaptured:true`
  when a new email was patched in).

  `SOCIAL_ENGINE_DATA_URL` is the engine **origin**; when unset it is derived
  from `SOCIAL_ENGINE_SYNC_URL` by stripping the trailing `/inbound/sync`
  (so `/cmd/data/row` resolves against the same host).

- **Email upgrade.** Emails are regex-extracted from **DM and comment** text. A
  **new** email on an existing lead (`emailCaptured` was false) is added via the
  PATCH using the `{addr, mx_ok:true}` convention and flips `emailCaptured`.

- **Rapid-fire debounce.** Repeat contacts from the same key within **60s**
  (`SOCIAL_LEAD_DEDUPE_MS`) only increment `messageCount` in cache — **no** second
  HTTP call (a newly-found email defers to the next out-of-window contact).

**Failure handling (never blocks the reply).** If the engine is unreachable the
call is **retried once after 2s**; on continued failure it audits
**`social.error`** `{stage:"lead_capture"}` and **continues** — the reply/approval
flow is unaffected. Because failed first-captures do **not** write cache, the lead
is **re-capturable on the next contact** (self-healing).

**What lands in Calla Data.** Captured leads appear with `source:"instagram"` /
`"tiktok"`, `stage:"raw"`, `status:"pending_review"`. Operators review them in the
Calla Data section and **bulk-approve into outreach** (the normal data-plane HITL
controls). Subsequent social messages enrich `research` (a running first↔last
message trail + `messageCount`) without disturbing the lead's pipeline position.

**Env additions.**
| Var | Default | Purpose |
|---|---|---|
| `SOCIAL_LEAD_CAPTURE` | `true` | Capture-by-default master switch; `false` disables all social lead capture. |
| `SOCIAL_ENGINE_DATA_URL` | *(derived from `SOCIAL_ENGINE_SYNC_URL`)* | Engine origin for `/cmd/data/row` PATCHes. |

> **GDPR.** Captured social identifiers (`username`, platform user id, message
> text, any volunteered email) are **business enquiries** received on the
> company's own social channels — processed on the legitimate-interest basis of
> responding to a customer request. Honor deletion/erasure requests by issuing a
> `/cmd/data/row` erase patch (or row delete) for the lead `key`; retention is
> handled by the engine's housekeeping cron, not by this module. The cache rows
> (`social:lead:*`) hold only counters + a truncated first message and can be
> dropped with the lead.

### 13.8 HTTP routes (mounted at `/channels`)

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/instagram/webhook` | **exempt** (verify token) | Meta handshake → `hub.challenge` or 403 |
| `POST` | `/instagram/webhook` | **exempt** (HMAC) | Signature-gated → normalize → engine → `{ok,received}` |
| `GET` | `/tiktok/webhook` | **exempt** (verify token) | Challenge handshake → `hub.challenge` or 403 |
| `POST` | `/tiktok/webhook` | **exempt** (challenge/body) | Normalize (defensive) → engine → `{ok,received}` |
| `POST` | `/instagram/exchange` | brain | `{code, redirect_uri?}` → short/long-lived tokens |
| `GET` | `/social/triggers` | brain | current `TriggersConfig` (defaults when unset) |
| `PUT` | `/social/triggers` | brain | validate + persist → audit `social.triggers.updated` |
| `POST` | `/social/test` | brain | synthetic `{platform,kind,text,username?,externalUserId?}` → engine (QA) |

`GET /channels` now also reports `platforms.instagram`/`platforms.tiktok`
(`{enabled, mode, regionWarning?}`) plus a `social` block
(`{replyAgent, triggers, leadSync}`). Telegram/WhatsApp status is unchanged.

### 13.9 QA without real keys

Everything is mockable via the API-base overrides. Point `IG_API_BASE` (and/or
`TIKTOK_API_BASE`) at a local stub that records sends and returns
`{ "id": "...", "status": "sent" }`, set the tokens to any non-empty value, and
drive synthetic events through `POST /channels/social/test` or by POSTing native
webhook bodies (with a correct `X-Hub-Signature-256` for Instagram):

```bash
# fake Graph API recording sends
IG_API_BASE=http://127.0.0.1:3980/v21.0 \
IG_APP_SECRET=s IG_VERIFY_TOKEN=v IG_ACCESS_TOKEN=t \
SOCIAL_ENGINE_SYNC_URL=http://127.0.0.1:3981/inbound/sync \
SOCIAL_ENGINE_SYNC_SECRET=syncsecret \
PORT=3987 LIBSQL_URL=file:/tmp/social.db node dist/server.js
```

The module's pieces are independently constructible: `InstagramAdapter`,
`TikTokAdapter` (both accept an injectable `apiBase`), `SendQueue`,
`InMemoryDecisionRegistry`, and the pure functions in `social/engine.ts`
(`defaultTriggers`, `validateTriggersConfig`, `matchTrigger`). With no LLM key
configured, `agent` actions exercise the degrade-to-approval path deterministically.

### 13.10 Files (`src/channels/social/`)

| File | Role |
|---|---|
| `types.ts` | `SocialPlatform`, `SocialInbound`, `SocialTrigger`/`TriggersConfig`, `SocialAdapter`, `SocialConfig`, `SocialDeps` + platform facts. |
| `keys.ts` | Store cache keys/TTLs (`social:triggers`, `social:ig:window:*`, `social:lead:*` capture state + dedupe/retry timings, agentId `social`). |
| `config.ts` | `readSocialConfig()` (env → config) + `TIKTOK_REGION_WARNING`. All API paths isolated/overridable; reads `SOCIAL_LEAD_CAPTURE` + derives `SOCIAL_ENGINE_DATA_URL`. |
| `queue.ts` | `SendQueue` — shared per-platform sequential sends, 600ms spacing. |
| `senders.ts` | Platform → sender registry (the acyclic seam `decisions.ts` uses to deliver approved replies). |
| `instagram.ts` | `InstagramAdapter` — send/private-reply, HMAC verify, webhook parse, 24h window. |
| `tiktok.ts` | `TikTokAdapter` — send, challenge/body verify, defensive webhook parse. |
| `whatsapp.ts` | `WhatsAppSocialAdapter` — customer-conversation transport: `sendWhatsAppText()` via the Cloud API + the 24h customer-service window cache (`social:wa:window:<phone>`). |
| `engine.ts` | `handleSocialInbound` + trigger store/validation/matching + capture-by-default leads (first=full sync / subsequent=data-row PATCH via `lib/engine-client.ts`) + qualification-flow handoff (`action:"flow"` + active-run takeover, `src/flows/runner.ts`) + approval routing + edge relay + conversation-thread recording/takeover gate (`src/conversations/store.ts`). |

The `DecisionContext` union in `../types.ts` gained a `"social"` variant, and
`../decisions.ts` routes it to the platform sender (see 13.5).

### 13.11 Conversation threads + takeover (operator console)

Every normalized inbound (Instagram, TikTok **and WhatsApp customers** — they
all funnel through `handleSocialInbound`) and every outbound the engine
produces is recorded into a per-thread conversation row so the operator console
can show the whole exchange, pause automation for one chat and reply manually:

```
handleSocialInbound(msg, deps)
  (a)  markWindow + audit social.received
  (a2) conversations.recordInbound(...)            ← thread store (best-effort)
  (b)  capture-by-default lead  → conversations.linkLead(id, leadKey)
  (b2) TAKEOVER GATE: thread takeover on?
         → audit social.takeover_skipped + return  (capture already ran;
           NOTHING automatic is sent, no flow starts/advances)
  (c0) active flow run → conversations.linkFlowRun(id, runId) → answerFlow
  (c1) action "flow"   → startFlow → linkFlowRun → prompt
  (d)  send policy     → auto-send  → recordOutbound(kind static|persona|flow_prompt)
                       → approval   → recordOutbound(kind "system", approvalId)
```

`decisions.ts` completes the picture: an **approved** social reply is recorded
as `kind:"approval_result"` (`auto:true`, `approvalId`) after a successful
delivery, a **declined** one as `kind:"system"` `(declined by operator —
nothing sent)` with nothing going out. Manual operator sends (`kind:"manual"`,
`auto:false`) come from `POST /conversations/:id/message`.

Store, cache keys, the frozen REST contract, caps and the GDPR deletion path:
`apps/brain/README.md` → **"Conversations API (operator console)"**
(`src/conversations/store.ts` + `src/conversations/routes.ts`).

---

## 14. WhatsApp customer conversations (WAVE-2)

The same business WhatsApp number now serves **two audiences** on one webhook
(`GET|POST /channels/whatsapp/webhook`). Routing is decided per inbound message
in `whatsapp.ts → onInboundText`:

```
inbound text from wa_id <phone>
  ├─ chat IS a bound operator (bindings.isBound("whatsapp", phone))
  │    → operator console EXACTLY as before: status / approvals / ask /
  │      unbind / binding codes + approval reply buttons. Zero regression.
  └─ chat is NOT bound AND WHATSAPP_CUSTOMER_MODE !== "false" (default ON)
       → binding-code escape hatch first: a lone 6-char A-Z0-9 token is still
         redeemable (tryBind) so operators can bind a fresh chat;
       → otherwise normalize to SocialInbound
         { platform:"whatsapp", kind:"dm",
           externalUserId: wa_id (leading + stripped),
           username: value.contacts[].profile.name (when present),
           text, ts }
         and funnel through handleSocialInbound (social/engine.ts) — the SAME
         pipeline Instagram/TikTok use.
```

Interactive button replies always keep the console decision path (cards only
ever reach bound chats). A bindings-store error **fails safe to the console
path** (never leaks an operator command into the customer pipeline).

### What the customer pipeline does

- **Lead capture (capture-by-default)** — key `WA:<phone>` (the phone is the
  stable identity; the profile name is display-only), `source:"whatsapp"`,
  `stage:"raw"`, `status:"pending_review"`; first contact full-syncs to
  `SOCIAL_ENGINE_SYNC_URL`, subsequent contacts PATCH the data-plane (never a
  clobbering re-sync). `source_url` is `https://wa.me/<phone>`.
- **Triggers** — `PUT /channels/social/triggers` now carries a `whatsapp` list
  + `fallback.whatsapp` (seeded `{action:"agent", mode:"auto"}` — user-initiated
  1:1 inside the window, same risk class as Instagram DMs; `mode:"approval"`
  and `action:"flow"` work exactly as on IG/TikTok).
- **Qualification flows** — a WhatsApp trigger with `action:"flow"` starts the
  run with `channel:"whatsapp"`, `chatRef:"whatsapp:<phone>"`, `leadKey:"WA:<phone>"`.
  While the run is active, every inbound customer message is fed to
  `answerFlow()` BEFORE trigger matching, and prompts/completion messages are
  sent back as **plain text messages** via the shared Cloud API send
  (`sendWhatsAppText`). REST-started runs (`POST /flows/runs` with
  `channel:"whatsapp"`, `chatRef:"whatsapp:<phone>"`) are picked up by the same
  active-run lookup.
- **Send policy + the 24h window** — WhatsApp Cloud API only allows free-form
  messages inside a **24h customer-service window** from the last inbound
  customer message (outside it, Meta rejects with error 131047). The window is
  tracked in the store cache at `social:wa:window:<phone>` (TTL 24h, same
  pattern as `social:ig:window:*`). Auto-send is blocked outside the window →
  the engine records a HITL approval (`toolName:"social-whatsapp-dm"`) and the
  EXISTING operator cards (Telegram/WhatsApp) + web UI inbox decide it.
- **Approvals** — approving a `social-whatsapp-dm` card delivers via the
  registered "whatsapp" sender (`social/senders.ts` → `sendWhatsAppText`),
  same queue + audits as Instagram/TikTok (`social.sent {auto:false}`).
- **Status** — `GET /channels` reports `platforms.whatsapp.customerMode`.

### Template messages — OUT OF SCOPE

Re-opening a closed 24h window requires a **pre-approved template message**
(`type:"template"`, template name + language approved in WhatsApp Manager,
per-message pricing). This module deliberately does NOT send templates: when
the window is closed the reply degrades to the approval path and a human can
respond from the Meta Business inbox (or a future template sender). Documented
here so nobody assumes cold re-engagement works.

### GDPR — phone numbers are personal data

- A wa_id **is** a phone number: personal data under GDPR from the moment it
  lands in the webhook. Minimize retention: leads keep only key/name/research
  summaries (message text truncated to 500 chars), window markers expire after
  24h, and audit entries mask the number (`••••0000`).
- Legal basis mirrors the social capture doctrine: a **customer-initiated
  business enquiry** on the company's own line (legitimate interest /
  pre-contractual necessity).
- **Erasure**: honor deletes via the engine data-plane — erase/delete the lead
  row for `WA:<phone>` (`/cmd/data/row` patch or row delete) and drop the
  `social:lead:WA:<phone>` + `social:wa:window:<phone>` cache rows. The
  hash-chained audit keeps masked ids only.
- Never import phone lists for outbound: capture is inbound-only.

### Env

| Variable | Default | Purpose |
|---|---|---|
| `WHATSAPP_CUSTOMER_MODE` | `true` | `false` → unbound chats keep the legacy console path (customer routing off). |

(Everything else reuses the existing `WHATSAPP_*` + `SOCIAL_*` variables.)

---

## 15. Meta Lead Forms + website widget (WAVE-2)

Two more intake surfaces feed the **same** qualification-flow runner:

### 15.1 Meta Lead Forms (Facebook / Instagram Lead Ads)

Webhook at `GET|POST /channels/facebook/webhook` (auth-exempt; Meta-native
verification), implemented in `channels/facebook.ts`.

**Meta app setup**

1. In the Meta App Dashboard add/confirm the **Webhooks** product and select
   the Page. Subscribe the app to the **`leadgen`** field.
2. Grant the **`leads_retrieval`** permission (App Review required for pages
   you don't administer) and generate a **Page or system-user token** with it
   → `FACEBOOK_ACCESS_TOKEN`.
3. Callback URL → `https://<brain>/channels/facebook/webhook`; verify token →
   `FACEBOOK_VERIFY_TOKEN` (GET handshake echoes `hub.challenge`).
4. App Secret (Settings → Basic) → `FACEBOOK_APP_SECRET` (POST bodies verified
   via `X-Hub-Signature-256`, constant-time; **unset → accepted with a WARN**,
   like the other Meta adapters — set it in production).

**Pipeline** (never fails — the POST always answers `200 {ok:true, processed,
captured, flowsStarted, duplicates, results, …}` so Meta doesn't retry-storm):

```
entry[].changes[] where field=="leadgen"  → {leadgen_id, page_id}
  → audit "leadform.received"
  → dedupe guard (cache "leadform:seen:<id>", TTL 24h — Meta redelivers, and
    bi-edge upsertLead is INSERT OR REPLACE: never re-sync a captured lead)
  → GET {FB_GRAPH_BASE}/{leadgen_id}?access_token=…   (default
    https://graph.facebook.com/v21.0; env-overridable for mocks)
    • token unset → audit "leadform.error" {stage:"fetch"} + 501-style note
      in the response body, still HTTP 200
  → field_data → { fullName, email, phone, answers }   (full_name / email /
    phone_number are contact fields; everything else is a question answer)
  → lead capture via syncLeads: key "FB:<leadgen_id>", name fullName,
    country FB_LEAD_COUNTRY (default IE), source "facebook", stage "raw",
    status "pending_review",
    emails  '[{"addr":"…","mx_ok":true}]',  phones '["+353…"]',
    research {"origin":"leadform","pageId","form":[names],"created_time","answers"}
    → audit "leadform.captured"
  → FACEBOOK_LEADGEN_FLOW (default "retrofit-solar-qualification"; "none"
    disables): answers mapped onto flow fields via the FIELD MAP below →
    startFlow({flowId, leadKey, channel:"leadform",
    chatRef:"leadform:<leadgen_id>", initialAnswers}).
    A fully/mostly-prefilled run COMPLETES IMMEDIATELY → deterministic score,
    tier, rep routing + booking proposal land in run.routing and the standard
    flow.* audits (agentId "flows").
```

**Field map** — form question name → flow field name.

- Persisted in the store cache at **`leadform:fieldmap`** (agentId `leadform`),
  **seeded** on first use with mappings for the builtin retrofit flow:

  | Form question (Meta Ads Manager) | Flow field |
  |---|---|
  | `Are you a homeowner?` / `Homeowner or tenant` | `homeowner_or_tenant` |
  | `Property type` | `property_type` |
  | `Eircode` | `eircode` |
  | `Monthly electricity spend` | `monthly_spend` |
  | `Do you have solar?` / `Existing solar` | `has_solar` |
  | `Battery interest` | `battery_interest` |
  | `EV` | `has_ev` |
  | `When are you looking to install?` / `Timeframe` | `timeframe` |

- **Override**: `FACEBOOK_FIELD_MAP='{"My custom question":"property_type"}'`
  (JSON object string) is merged over the cached/seeded map at load. Lookups
  are case/space-insensitive.
- **Unmatched answers** are kept in the lead's `research.answers` blob — never
  dropped, reviewable in Calla Data.

**Audits** (agentId `leadform`): `leadform.received`, `leadform.captured`,
`leadform.error` (`stage: fetch|capture|flow|process`).

**Env**

| Variable | Default | Purpose |
|---|---|---|
| `FACEBOOK_VERIFY_TOKEN` | — | GET handshake (`hub.verify_token` match → echo `hub.challenge`). |
| `FACEBOOK_APP_SECRET` | — (accept+WARN) | POST `X-Hub-Signature-256` HMAC verification. |
| `FACEBOOK_ACCESS_TOKEN` | — | `leads_retrieval` token for the full-lead fetch; unset → graceful skip. |
| `FB_GRAPH_BASE` | `https://graph.facebook.com/v21.0` | Graph base (override for mocks). |
| `FACEBOOK_LEADGEN_FLOW` | `retrofit-solar-qualification` | Flow started per lead; `none` disables. |
| `FACEBOOK_FIELD_MAP` | — | JSON object overriding/merging the seeded field map. |
| `FB_LEAD_COUNTRY` | `IE` | Country stamped on captured leads. |

### 15.2 Embeddable website form (`src/forms/widget.ts`, mounted at `/forms`)

A **public, no-auth** micro-surface for marketing sites (exempted from bearer
auth in `server.ts`; rate-limited; CORS-controlled).

**Embed snippet**

```html
<script src="https://<brain>/forms/widget.js?flow=retrofit-solar-qualification&title=Get your solar quote" defer></script>
```

- `flow` (required) — flow definition id; `title` / `brand` (optional) —
  header text customizations. The script is a dependency-free IIFE that
  injects a styled card (neutral light theme, inline CSS), renders every flow
  field from `/forms/definition` (choice → select, yesno → radios,
  text/eircode → text input, email/number → typed inputs) plus a small contact
  block (name/email/phone), validates required fields client-side, submits to
  `/forms/ingest`, and on success shows the completion message with the
  **booking link** (Calendly rep) or the **proposed slots** for a follow-up
  call.

**Routes**

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/forms/widget.js?flow=&title=&brand=` | public | the embeddable IIFE (CORS) |
| `GET` | `/forms/definition?flow=` | public | `{flowId, title, description, fields:[{name, question, type, options?, required, hint?}]}` (`eircode` exposed as `text`) |
| `POST` | `/forms/ingest` | public | see contract below (CORS, 10/min/IP rate limit) |

**Ingest contract**

```jsonc
// request
{ "flowId": "retrofit-solar-qualification",
  "answers": { "homeowner_or_tenant": "Homeowner", "eircode": "D15 XY23" },
  "contact": { "name": "Pat", "email": "pat@example.com", "phone": "+353…" },
  "session": "browser-generated uuid" }        // optional; server generates one when absent

// response
{ "ok": true, "leadKey": "WEB:pat@example.com", // or WEB:<session> without email
  "session": "…", "runId": "…", "completed": true, "tier": "hot",
  "summary": { "message": "…", "bookingLink": "https://calendly.com/…",  // calendly reps
               "slots": [{ "start": "…", "end": "…" }] } }               // calendar reps
// errors: 400 (bad body/flow), 429 { error:"rate_limited", retryAfterSec }
```

Processing: audit `form.submitted` (agentId `forms`) → lead capture
(key `WEB:<email||session>`, name `contact.name || "Website enquiry"`,
`source:"website"`, stage raw / status pending_review, research
`{origin:"form", flowId, session}`) → `startFlow({channel:"form",
chatRef:"form:<session>", initialAnswers: answers})` — website forms use flow
field names directly, so a complete submission finishes immediately and
scoring/routing run inside the runner (`flow.*` audits).

> **Confirmation comms are the OPERATOR's job** — the widget shows the booking
> link/slots inline, but no email/SMS is sent to the visitor; follow-up happens
> via the web UI inbox / Calla Data.

**Security hardening (documented options)**

- `FORMS_ALLOWED_ORIGINS=https://site-a.ie,https://site-b.ie` — comma-separated
  CORS allowlist; when set, only listed origins get an `Access-Control-Allow-Origin`
  echo (unset → `*`).
- The 10/min-per-IP ingest rate limit is in-memory per process (behind a proxy,
  set/forward `X-Forwarded-For`).
- For stricter setups, add a per-site token param to the embed URL and check it
  in `POST /forms/ingest` (the widget forwards query params; a few lines in
  `widget.ts` is all it takes).
- These routes are public **by design**; everything else in the brain stays
  behind bearer auth.
