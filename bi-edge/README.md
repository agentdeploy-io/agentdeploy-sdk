# bi-edge — Lead-Gen Outreach Engine (the full system map)

The outreach system is **four packages** in this repo (`packages/`). This file is
the single map of where everything lives, how the pipeline works, and where every
key/branding setting goes.

```
packages/
├── bi-edge/   ← THIS ENGINE — thinks + sends (Cloudflare Worker, Durable Object + SQLite)
├── bi-core/   ← CRAWLER — finds leads (Node + Crawlee; Railway VM in prod, :4111 local)
├── edge-jev/  ← (legacy) standalone LLM classifier — now optional; engine falls back to the LLM gateway
├── edge-core-scraper/ ← (legacy) earlier crawler implementation — reference only
└── calla/     ← THE MANAGER UI (HITL console: Fleet / Inbox / Agent detail + voice receptionist)
     ├── apps/ui     React SPA          → :5174 local · Cloudflare Pages in prod
     ├── apps/edge   Cloudflare Worker  → :8787 local · Workers in prod (voice, approvals, events)
     └── apps/brain  Mastra on Fly.io   → :3001 local · Fly.io in prod (orchestrator, booking, channels)
```

**Who we're doing lead gen for:** gradient3.io. The outreach persona is
**Agent Miles** (an AI agent built by gradient3.io) — see Branding below.

---

## 1. Pipeline logic (7 stages)

All state lives in the engine's Durable Object SQLite (local:
`/tmp/calla-bi-edge-state`). Lead lifecycle:
`raw → classified → researched → approved → sent → replied`.

| # | Stage | Where | What happens |
|---|-------|-------|--------------|
| 1 | **Discover (crawl)** | `src/cron/crawl.ts` → bi-core `/v1/handoff` | Engine tells bi-core which countries/limit. bi-core harvests from registries (UK Companies House API, FR INSEE, IE CRO, EE/PT web), **Brave-discovers each company's website**, verifies the site (the registry name or reg-number must appear on it — prevents emailing the wrong business), extracts contacts + MX checks, syncs back to the engine via `/inbound/sync` (auth: `X-AD-Sync: <AD_SYNC_SECRET>`). |
| 2 | **Import** | `src/routes/data-api.ts` | Or: CSV import from the UI (`POST /cmd/data/import`, multipart) — leads land `raw`. |
| 3 | **Classify** | `src/agents/qualifier.ts` | Deterministic ICP gate (`src/icp-validator.ts` + `skills/icp.md` NACE codes/age/size/country) **+** LLM classification (`AD_MODEL`, JEV if `AD_JEV_URL` set). Output: `tier` HOT/WARM/COLD/SKIP, vertical, fit, reasoning. |
| 4 | **Research** | `src/agents/researcher.ts` | Deterministic: crawl the lead's website, extract services/stack/contacts (evidence pack). No LLM. |
| 5 | **Write** | `src/agents/writer.ts` | LLM pitch (subject + body, 80–120 words) **in the Agent Miles voice** using `BRAND_NAME`/`BRAND_ONE_LINER`. Leads move to `researched` → appear in the **Approval Inbox**. |
| 6 | **HITL approve** | UI Data screen / Inbox → `POST /cmd/data/row {key, patch:{status:"approved"}}` | A human reviews the pitch and approves/rejects/edits. |
| 7 | **Send (gated)** | `src/agents/outreach.ts` | `POST /cmd/supervisor {"message":"/send <key>"}` → 14-check gate stack (opt-out, rejected, approved, has pitch, has email, MX ok, not paused, `sendEnabled`, daily cap, blacklist, blocked SIC, blocked keyword, headcount) → **Brevo** (real) or dry-run log. |

**Reply loop:** `src/cron/reply-poll.ts` polls Brevo for replies → LLM classifies
intent → drafts a response → lands in the **Inbox (reply drafts)** → human
approves → `POST /cmd/supervisor {"message":"/send-reply <id>"}` **sends the
draft via Brevo** (same 14-check gate stack as `/send`; dry-run logs a
`dry-run` row). Reject → `/discard-reply <id>`.

**Outreach has NO cron** — sends fire only via supervisor commands, by design (HITL).

### Scheduling model (no static cron)

The worker runs a **self-perpetuating DO alarm** that ticks every 5 minutes
(`SCHEDULE_TICK_MS`). Each named schedule (`crawl`, `research`, `reply_poll`,
`housekeeping`) has its cron expression **persisted in the `settings` table**
(`cron:<name>`), so it is editable at runtime without a redeploy:

- `GET /cmd/schedules` — current expressions, enabled flags, last-run times.
- `POST /cmd/schedules {"name":"crawl","cron":"0 1 * * *","enabled":true}` —
  update expression / toggle. `{"name":"crawl"}` — run now.
  `POST /cmd/schedules/crawl/run` — run now (also used by the UI).
- On each tick a schedule fires only if its expression was due since its
  `cron_last_run` (half-open window, catch-up collapses to "due now" after
  long downtime). First tick after deploy bootstraps all four once.
- Pause (`POST /cmd/settings {"paused":"true"}`) halts every schedule.

The UI **Operations** page (`/operations`, data module) renders all of this:
start/stop, per-cron expression editor, run-now, send settings, sent log, and
the live pipeline funnel.

Note: DO `getAlarm()`/`setAlarm()` are **async** on current compatibility
dates — they must be awaited before the response returns (see
`ensureAlarmArmed`, which also re-arms a stale alarm on the next request).

### Live crawl status

The engine's crawl "run" row only records the *queueing* of the job — the
real 5–20 min crawl runs in bi-core. `GET /cmd/crawl-status` proxies
bi-core's `/status`: live `progress` (`step / done / total / detail`), task
states, and final stats incl. `dropReasons` (`noWebsite / fetchFailed /
unverified / duplicate`) so a "0 leads" crawl explains itself. The UI Fleet
card and Operations page poll it every 5s. The `countries` setting accepts
full names ("Ireland, France" → `ie,fr`); unsupported countries fail the run
loudly instead of harvesting nothing.

### Verticals (what the crawl hunts)

A **vertical** is the crawl's ICP + countries + discovery dorks + behavior
toggles, stored in the `verticals` table (schema v3) and editable live from
the UI (Operations → Verticals):

- `GET /cmd/verticals` — list all packs.
- `POST /cmd/verticals` — create/update (`{name, icp, countries, dorks,
  cities?, sicInclude?, sicExclude?, requireWebsite, useRegistry, llmEnrich,
  mxGuess, minScore, perCountryLimit, sources?, probes?, ccFilters?,
  githubTopics?, urlscanQueries?, defillamaChains?, isDefault}`; `id`
  generated when absent). Only one `isDefault` at a time. `sources` selects
  discovery sources (`dorks` / `commoncrawl` / `github` / `urlscan` /
  `defillama`, default `dorks`) and `probes` selects enrichment probes
  (`monetization` / `techstack` / `intent`); both flow through the handoff to
  the core's behavior pipeline.
- `DELETE /cmd/verticals?id=<id>` — remove.

**Source smoke test** (UI “Test” button) — run one discovery source for a
vertical *without* verify/enrich/sync, and preview the candidates it would
feed the pipeline:

- `POST /cmd/sources/test {vertical | verticalId, source}` → `{taskId}`.
  `vertical` is the live (possibly unsaved) pack; `verticalId` resolves a
  stored one. Thin proxy to the core, so the Workers 30s cap is never hit.
- `GET /cmd/sources/test/:id` → `{state: running|done|failed, candidates?}`.

**AI Scraper Builder** — the LLM writes sandboxed discovery modules
(`src/scraper/*` in the core; see the core README for the contract):

- `POST /cmd/scrapers/generate {prompt}` → `{taskId}` (LLM writes the module)
- `GET /cmd/scrapers/generate/:id` → `{state, result?: {id, description, code}}`
- `POST /cmd/scrapers/test {code, vertical?}` → `{taskId}` (sandboxed run)
- `GET /cmd/scrapers/test/:id` → `{state, result?: {ok, hits?|error?}}`
- `POST /cmd/scrapers {id, description, code}` — register (validated +
  persisted in the core's `DATA_DIR/custom-sources/`)
- `GET /cmd/scrapers` → `{scrapers: [{id, description, createdAt}]}`
- `DELETE /cmd/scrapers/:id` — remove.

`POST /cmd/schedules/crawl/run {"verticalId":"…"}` pins a vertical for a
manual run; the **cron** always uses the *default* vertical, and with none
configured it falls back to the legacy registry harvest (`countries`
setting). The crawl handoff to bi-core carries the whole pack, which runs
the behavior-driven vertical pipeline there (see the bi-core README for the
stage/drop-reason detail).

### Test mode & end-to-end simulation (no mailbox needed)

Three settings let you exercise the whole send→reply→approve loop against
your own inbox, or without any email at all:

- **Test mode** — `POST /cmd/campaign {"testMode":"true","testRecipient":"you@x.com"}`.
  When on, every pitch and reply send is **redirected to your test inbox**;
  the lead keeps its own address and is never emailed. Gates (approval,
  dry-run, send-enabled, daily cap) still apply. A lead with no email can be
  test-sent.
- **Simulate a reply** — `POST /cmd/simulate-reply {"sent_id":N,"text":"…","from":"you@x.com"}`.
  With test mode on it first **sends a real Brevo email to the test inbox**
  (threaded under the pitch subject, original pitch quoted underneath), then
  fabricates the matching inbound event and runs it through the **same**
  classify → draft pipeline as a real webhook. Approving the resulting draft
  (`/send-reply`) sends another real email to the test inbox — so a full
  back-and-forth conversation builds up in your mailbox. Note: Brevo only
  sends as the agent address, so simulated "lead" replies also appear from
  the agent (internal use). Turn dry-run off first if you want the initial
  pitch to be a real email too.
- **Thinking / traces** — every LLM call (classify, write, reply-classify,
  reply-draft) is recorded (prompt input + raw output, latency) to the
  `llm_traces` table; `GET /cmd/traces?limit=30`. The UI "Thinking" panel
  shows them so you can debug/tune the lead-gen flows.

### Campaign config (runtime-editable brand + targeting)

`GET/POST /cmd/campaign` — brand name / one-liner / site / logo / booking
link and free-form **ICP notes** (injected into the classifier prompt; the
structured NACE/size gates still apply). Stored in `settings` as
`campaign:*`, overriding the `BRAND_*` env until cleared. `countries` /
`crawlLimit` are plain settings read by the crawl cron. Resolved values are
merged over the Worker env on every request, so edits apply immediately.

The UI **Operations** page renders all of the above: Campaign & Test panel,
Thinking panel, per-row "Simulate reply", plus start/stop, per-cron editor,
run-now, send settings, sent log and the live funnel. A **Fleet** card points
here.

---

## 2. Where every setting lives

### Env vars (the complete list)

| Var | Where (local) | Where (prod) | Purpose |
|---|---|---|---|
| `AD_GATEWAY_BASE_URL` / `AD_GATEWAY_API_KEY` / `AD_MODEL` | `bi-edge/.dev.vars` | wrangler secrets on bi-edge | LLM for classify/write/reply (Chutes for local) |
| `AD_SYNC_SECRET` | `bi-edge/.dev.vars` | wrangler secret | Core→Edge sync auth (must match bi-core `SYNC_SECRET`) |
| `CORE_URL` | `bi-edge/.dev.vars` | wrangler secret (bi-core Railway URL) | Crawler endpoint for the crawl cron |
| `COMPANIES_HOUSE_KEY` | `bi-edge/.dev.vars` **and** `bi-core/.env` | secrets on both | UK registry API (bi-core uses it) |
| `BRAVE_API_KEY` | `bi-edge/.dev.vars` **and** `bi-core/.env` | secrets on both | Website discovery + researcher |
| `BRAND_NAME` / `BRAND_ONE_LINER` / `BRAND_SITE_URL` / `BRAND_LOGO_URL` / `CALENDLY_URL` | `bi-edge/.dev.vars` | wrangler secrets on bi-edge | **Branding** (footer + writer persona) |
| `BREVO_API_KEY` / `BREVO_SENDER_EMAIL` | `bi-edge/.dev.vars` | wrangler secrets on bi-edge | **Real email sending** (empty = can't send, by design) |
| `SYNC_URL` / `SYNC_SECRET` / `DATA_DIR` | `bi-core/.env` | Railway env on bi-core | Sync back to the engine; checkpoint dir |
| `PORT` | `bi-core/.env` | Railway auto | bi-core listen port (4111 local) |
| `JEV_URL` | — (not set locally) | wrangler secret | Optional standalone classifier; engine falls back to the LLM gateway when unset |

Templates (safe placeholders, committed): **`bi-edge/.dev.vars.example`**,
**`bi-core/.env.example`**, `calla/apps/brain/.env.example`,
`calla/apps/edge/.dev.vars.example`. Real files (`.dev.vars`, `.env`) are
git-ignored.

**Send toggles are runtime settings, not env vars** — stored in the engine DB:
`GET/POST /cmd/settings` (`sendEnabled`, `dryRun`, `paused`, `dailyCap`).
Defaults: `sendEnabled=false`, `dryRun=true` → **no real email can fire** until
both are flipped.

### Branding (Agent Miles / gradient3.io)

- **Footer** — built in `src/agents/outreach.ts` (`buildEmail`): logo
  (`BRAND_LOGO_URL`) → bold `BRAND_NAME` → "AI outreach agent built by
  `<BRAND_SITE_URL domain>`" → site + Calendly links → "Reply STOP to opt out"
  (GDPR/EU-AI-Act disclosure, never editable).
- **Writer persona** — `src/agents/writer.ts` `buildIdentityPersona()` injects
  `BRAND_NAME`/`BRAND_SITE_URL`/`BRAND_ONE_LINER` into the LLM system prompt, so
  pitches open: *"I'm Agent Miles, an AI agent built by gradient3.io. We build
  AI into the systems your business runs on…"*
- **Persona doc** — `skills/identity.md` (source of truth for the persona).
- **Brevo sender name** = `BRAND_NAME` (`Agent Miles`).
- Currently set in `bi-edge/.dev.vars`: `BRAND_NAME=Agent Miles`,
  `BRAND_SITE_URL=https://gradient3.io`, one-liner set, **`BRAND_LOGO_URL` empty**
  → set the public logo URL to get the image in the footer.

---

## 3. Running locally (all of it)

```bash
# 1. UI + edge + brain + engine  (one command, from packages/calla)
npm run dev -- --with-engine
#    → UI :5174 · edge :8787 · brain :3001 · engine :8792
#    engine state: /tmp/calla-bi-edge-state (delete for a clean DB)

# 2. Crawler (separate terminal; reads packages/bi-core/.env)
cd packages/bi-core && npm run build && npm start     # → :4111
```

Engine API (all on :8792):

```bash
curl -X POST localhost:8792/_cron/crawl        # stage 1: crawl via bi-core
curl -X POST localhost:8792/_cron/research     # stages 3-5: classify + research + write
curl  "localhost:8792/cmd/data?stage=raw&pageSize=25"     # see leads
curl  "localhost:8792/cmd/data/row?key=<key>"             # one lead (classification, pitch)
curl -X POST localhost:8792/cmd/data/row -H 'content-type: application/json' \
     -d '{"key":"<key>","patch":{"status":"approved"}}'   # HITL approve
curl -X POST localhost:8792/cmd/settings -H 'content-type: application/json' \
     -d '{"sendEnabled":"true"}'                        # arm sending (dry-run stays ON)
curl -X POST localhost:8792/cmd/supervisor -H 'content-type: application/json' \
     -d '{"message":"/send <key>"}'                     # stage 7: gated send (dry-run)
curl -X POST localhost:8792/cmd/supervisor -H 'content-type: application/json' \
     -d '{"message":"/sent"}'                           # sent log
```

**In the UI** (`http://localhost:5174`): **Data** screen = leads + CSV import/
export; **Approval Inbox** = approved-for-review pitches; approve/reject inline.
`/d/<agentId>/*` proxies to the engine automatically (`--with-engine`).

---

## 4. Enabling REAL email (production only — do not do casually)

1. `bi-edge/.dev.vars` (local) / wrangler secrets (prod): `BREVO_API_KEY`,
   `BREVO_SENDER_EMAIL`, `BRAND_NAME`, `BRAND_SITE_URL`, `BRAND_LOGO_URL`.
2. Brevo: authenticate the sender domain (SPF/DKIM). Lead emails must pass MX
   (crawl sets `mx_ok`; CSV-imported emails pass unless flagged).
3. `POST /cmd/settings {"sendEnabled":"true","dryRun":"false"}` — both gates
   required. `dailyCap` defaults to 10/day.
4. Every real send logs to `sent_log` with the Brevo messageId (`/sent`).

---

## 5. Visibility — what to check when something looks wrong

| Symptom | Check |
|---|---|
| No new leads after crawl | `curl :8792/cmd/runs` (crawl run + stats) · `curl :4111/status` (bi-core task state) · is `CORE_URL` set? Is bi-core running? |
| Crawl succeeded but 0 verified | Expected on strict days — verify requires the registry name/reg-number on the website. See `bi-core` log + task result steps (`/tasks/<id>`). |
| Leads stuck `raw` | Run `/_cron/research` — classify needs the LLM gateway (`AD_GATEWAY_*`). |
| Pitch generic / wrong voice | Check `BRAND_NAME`/`BRAND_ONE_LINER` in `bi-edge/.dev.vars` + `skills/identity.md`; restart engine. |
| Send blocked | `POST /cmd/supervisor {"message":"/send <key>"}` reply says `blocked:<reason>` — or read the gate list above. |
| No real email | `GET /cmd/settings` — need `sendEnabled=true` AND `dryRun=false` AND `BREVO_API_KEY` set. |
| Full health check (prod) | `npx tsx scripts/verify-bi-agent.ts --deployment <edge-id>` |

**Testing data note:** any `*.example` addresses in the Data screen are
test/demo rows (CSV test imports or `node scripts/seed-engine.mjs`), not scraped
data. Delete with `POST /cmd/supervisor {"message":"/erase <key>"}`.

---

## 6. Known gaps (audited 2026-10-21)

| # | Gap | Status |
|---|-----|--------|
| G1 | CSV import UI↔engine protocol mismatch | **Fixed** (multipart + raw body) |
| G2 | Approving a lead does NOT send it — `/send` is a separate supervisor command; UI has no per-row Send button | By design (HITL), but needs a UI action |
| G3 | **Approved reply drafts are never sent.** `/send-reply <id>` and the UI reply-approve only marked status; no code path sent the draft via Brevo. | **Fixed** — `sendReplyDraft()` in `supervisor.ts` sends via Brevo (full gate stack, dry-run mode, `Re:` subject, signature footer); UI Inbox approve/reject → `/send-reply` / `/discard-reply`. |
| G4 | `reply-poll` cron uses Brevo `/v3/inbound/events` which returns **metadata only (no email body)** → intent classified blind. The body-carrying path is the Brevo **webhook** → `POST /inbound-webhook` (exists, deduped via `inbound_seen`), but no Brevo-side webhook is configured | **Real gap** — configure Brevo inbound webhook in prod |
| G5 | No UI controls for: send settings, crawl/research triggers, sent log, schedules. | **Fixed** — new **Operations** page (`/operations`, data module): start/stop, per-cron editor, run-now, send settings, sent log, live funnel. |
| G8 | DO alarm chain was never initialized: `setAlarm` only existed *inside* `alarm()`, so the first tick never fired anywhere (crons ran only via manual `/_cron/*`). Also `getAlarm()`/`setAlarm()` are async on current compat dates — the old sync `getAlarm()===null` check never armed. | **Fixed** — `ensureAlarmArmed()` (awaited) arms on first request + re-arms a stale alarm; `alarm()` self-perpetuates every 5 min. Verified locally: first tick bootstraps all four crons, each then fires only on its own due window. |
| G6 | Brain `send-external-email` tool is a stub | Deferred |
| G7 | JEV classifier parked (LLM fallback active); verify step is strict (registry name/reg-number must appear on the website) so generic crawl batches often verify 0 | Intentional design |
