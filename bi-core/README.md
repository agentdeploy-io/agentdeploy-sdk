# Business Intelligence Agent

**From purchase to first qualified lead in under 30 minutes.**

An autonomous three-component system that discovers, crawls, classifies, and warms up B2B leads from official business registries. Deployed as a managed template on agentdeploy.io.

---

## What You're Buying

| Component | Role | Runtime |
|-----------|------|---------|
| **Edge Orchestrator** (`bi-edge`) | Thinks — schedules crons, runs the gate stack, manages the pipeline DB, sends emails | Cloudflare Workers (Durable Object) |
| **Core Crawler** (`bi-core`) | Crawls — registry discovery, website verification, contact extraction | Railway VM (Node.js + Crawlee) |
| **jev Classifier** (`edge-jev`) | Qualifies — LLM-based lead classification (vertical, fit, tier, language) | Cloudflare Workers |

The Edge orchestrator decides *what* to do and *when*. The Core crawler goes and finds leads. The jev classifier scores them. All state lives in the Edge's Durable Object SQL database.

---

## Quick Start (< 30 min)

### 1. Purchase & Auto-Provision

After purchase, your deployment is auto-provisioned with three services:

- `bi-edge` — your orchestrator (Cloudflare Worker)
- `bi-core` — your crawler VM (Railway)
- `edge-jev` — your classifier (Cloudflare Worker)

The Edge worker URL is your main endpoint (e.g. `https://bi-edge-<id>.workers.dev`).

### 2. Configure Secrets

Set these via the Cloudflare dashboard or `wrangler secret put`:

| Secret | Where to get it | Required |
|--------|----------------|----------|
| `AD_GATEWAY_API_KEY` | Your agentdeploy.io dashboard | Yes |
| `AD_SYNC_SECRET` | Auto-generated at provision | Yes |
| `BRAVE_API_KEY` | [brave.com/search/api](https://brave.com/search/api) | Yes |
| `BRAND_NAME` | Your company name | Yes |
| `BRAND_ONE_LINER` | One sentence: what you sell | Yes |
| `BREVO_API_KEY` | [brevo.com](https://www.brevo.com) (email sending) | For live sends |
| `BREVO_SENDER_EMAIL` | Verified sender address in Brevo | For live sends |
| `COMPANIES_HOUSE_KEY` | [companieshouse.api.gov.uk](https://developer.company-information.service.gov.uk/) | UK leads |
| `CORE_URL` | Auto-set at provision (bi-core Railway URL) | Yes |
| `JEV_URL` | Auto-set at provision (edge-jev worker URL) | Yes |

### 3. Set Your ICP

Edit `skills/icp.md` to match your ideal customer:

```yaml
---
nace_include: ["69", "70", "74"]    # SIC/NACE codes for your verticals
nace_exclude: ["62", "63"]           # SIC codes to skip
size_max: 50                         # Max employees
countries: [uk, ie, fr]              # Target countries
---
```

Or use the defaults (accounting/legal/consulting firms, UK/IE/FR).

### 4. Test Send (Dry-Run)

Dry-run is ON by default. To verify:

```bash
# Check your pipeline status
curl https://<your-edge>/cmd/pipeline

# Check settings
curl https://<your-edge>/cmd/settings

# Trigger a manual crawl
curl -X POST https://<your-edge>/cmd/schedules \
  -H "Content-Type: application/json" \
  -d '{"name":"crawl"}'
```

In dry-run mode, the gate stack runs all checks but does not actually send emails. Check `/cmd/data?stage=sent` to see what *would* have been sent.

### Watching a crawl (live status)

A crawl takes minutes (Brave is paced to ≈1.1s/candidate). While one runs,
`GET /status` on bi-core reports the live step and position, and the engine
proxies it at `GET /cmd/crawl-status` (the UI Fleet/Operations pages poll
every 5s):

```jsonc
{
  "phase": "busy",
  "progress": { "step": "verify", "done": 14, "total": 15, "detail": "DALIMER MEDIA LIMITED" },
  "tasks": [{ "id": "crawl-3", "state": "running", "result": null }]
}
```

A finished task's `result` includes `totalCandidates / totalVerified /
totalSynced` plus **`dropReasons`** (`noWebsite / fetchFailed / unverified /
duplicate`) — so a "0 leads" crawl tells you *why* instead of staying a
mystery. Unknown countries fail the task loudly (`Unknown countries: …`);
the engine also validates names up front and accepts full names
("Ireland" → `ie`).

Note on Brave: the `country` param is intentionally **not** sent — our key
rejects ISO codes with 422, and the old code→name→none fallback burned two
guaranteed-failing requests per candidate before hitting the rate limit.
The quoted exact registry name (+ city, with a no-city retry) is specific
enough; the verify step still checks the site against registry
name/address.

### Vertical packs (dynamic crawl)

A **vertical pack** is crawl configuration, not code: ICP text, countries,
discovery dorks, city expansion, SIC include/exclude, behavior toggles
(`requireWebsite`, `useRegistry`, `llmEnrich`, `mxGuess`) and quality gates
(`minScore`, `perCountryLimit`). The engine stores verticals
(`GET|POST|DELETE /cmd/verticals`) and the UI edits them in Operations →
Verticals. When a handoff carries a `vertical` object, the workflow runs the
behavior-driven pipeline (`src/pipeline/`) instead of the legacy
registry harvest:

```
discover  configured sources (default: dorks) merged + deduped by host:
          dorks · registry · commoncrawl · github · urlscan · defillama
verify    Companies House name search (UK): dissolved / SIC-excluded → drop
          website name-match signals (URL sources: miss = flagged, not
          rejected — the site IS the entity; only registry-confirmed names
          keep the strict verdict; the LLM gate does the real filtering)
enrich    contact pages + MX validation, info@/hello@ guessing when MX ok
          LLM (DeepSeek flash via Chutes): ICP relevance 0-100, pitch
          summary, best email/phone · intent probe (Wayback + OpenPageRank)
score     verified +40 / flagged +25 · relevance×0.3 (≤30) · email +15 ·
          phone +10 · registry match +10 · SIC-in-include +5 · cap 100
sync      batches → engine /inbound/sync
```

**Rendered-DOM scraping** (`src/pipeline/renderer.ts`, Playwright + headless
chromium): pages are fetched plain first; when a page is a JS shell
(Next/Nuxt/React SPA with a near-empty body) it is re-fetched in a real
browser and the *rendered* DOM is what gets verified and enriched — contacts
and payment scripts that only exist after hydration are found too. The
browser is launched lazily, shared across the run, and closed after 10 min
idle (also on SIGTERM). The **monetization probe** (ported from
agent-recon's payments-probe) scans the (rendered) HTML for payment
infrastructure (stripe/paddle/lemonsqueezy/paypal/gumroad/braintree/square/
mollie/razorpay/klarna + crypto providers), pricing-page links and
paid-tier terms; signals land in the lead's `website_evidence`.

**Discovery sources & enrichment probes** (`src/pipeline/sources.ts`, ported
from agent-recon). A vertical selects which run — `sources: ["dorks",
"commoncrawl", "github", "urlscan", "defillama"]` and `probes: ["monetization",
"techstack", "intent"]` (defaults: `dorks` / `monetization, techstack`).
Sources are merged and deduped by host into one candidate pool capped at
`perCountryLimit`; any source that fails is skipped, never fatal.

- **registry** — the companies registries as a *discovery* source, not just a
  verify step: **UK** Companies House `search/companies?q=` (free-text works;
  `sic=`/`address=` filters are broken server-side) with ICP phrases from the
  dorks + city variants, active-only, then a detail fetch per company for SIC
  + locality (SIC-exclude gate, optional `registryWindowMonths` recency
  window). **FR** recherche-entreprises/SIRENE, **IE** CRO open-data CSV
  (cached 7 days), **EE** ariregister, **PT** brave `site:.pt`. Registry hits
  have no website, so a **link step** finds one: LLM-guessed domain (fetch +
  name-token confirmation) → exact-name search → quoted core-name search. A
  wrong link is harmless: registry candidates are name-confirmed, so the
  verify stage rejects mismatches (`website_unverified`).
- **dorks** — the search stack above (Brave → URLScan/DDG/Bing → LLM judge).
- **commoncrawl** — latest CC index `collinfo.json` + CDX regex filters
  (defaults: dork phrases as path slugs under the country TLD).
- **github** — `api.github.com/search/repositories?q=topic:<t>` → deployed
  `homepage` URLs (default topics: web/digital/marketing agency; set
  `githubTopics` to steer; 403/429 = rate budget spent, stop cleanly).
- **urlscan** — raw URLScan search queries (`urlscanQueries` or dork-derived).
- **defillama** — `api.llama.fi/protocols`, chain-filtered, TVL>0
  (DeFi verticals; set `defillamaChains`).

Probes: **monetization** + **techstack** (site builder/platform markers —
webflow/framer/wix/squarespace/shopify/wordpress/elementor/nextjs/nuxt/
lovable/v0/bolt/replit; signals `stack:<name>`) run on the already-fetched
(rendered) HTML in the verify stage — zero extra network. **intent** runs in
enrich: Wayback CDX snapshot count + recency (`active` = updated ≤90d) plus
optional OpenPageRank authority/referring-domains when
`OPENPAGERANK_API_KEY` is set; the tiered line lands in the lead's
`research`.

Every drop is counted by reason (`registry_sic / no_website / fetch_failed /
website_unverified / icp_mismatch / below_min_score / budget / duplicate`)
and reported in the finished task's `result.dropReasons`.

**Search stack** (`src/pipeline/search.ts`): Brave Search API first, with a
monthly quota tracked on disk (`DATA_DIR/brave-usage.json`, cap
`BRAVE_QUOTA_CAP`, default **1000**). When Brave is exhausted the run
continues on the LLM stack — DeepSeek flash (Chutes, `LLM_MODEL`)
generates candidate businesses from the ICP and judges every raw hit from
URLScan / DuckDuckGo / Bing against it (free HTML SERPs are bot-gated from
datacenter IPs, so the LLM keeps discovery alive anywhere). LLM env:
`LLM_BASE_URL` (default `https://llm.chutes.ai/v1`), `LLM_API_KEY`,
`LLM_MODEL` (default `deepseek-ai/DeepSeek-V4-Flash-0731-TEE`).

Cron stays a trigger: the scheduled crawl runs the **default** vertical (or
the legacy harvest when none exists); run-now can pin any vertical.

### 5. Enable Sends

When you're confident in the output:

```bash
curl -X POST https://<your-edge>/cmd/settings \
  -H "Content-Type: application/json" \
  -d '{"sendEnabled":"true","dryRun":"false","paused":"false"}'
```

The agent will now send real emails through Brevo, respecting your daily cap (default: 10/day).

---

## Architecture

```
                    ┌─────────────────────────────┐
                    │      Edge Orchestrator       │
                    │      (Cloudflare Worker)     │
                    │                              │
                    │  ┌─ Supervisor (commands)    │
                    │  ├─ Qualifier (ICP + jev)   │
                    │  ├─ Researcher (web crawl)   │
                    │  ├─ Writer (pitch drafts)    │
                    │  └─ Outreach (gate stack)    │
                    │                              │
                    │  Pipeline DB (Durable Obj)   │
                    │  Cron schedules (alarm)      │
                    └──────┬──────────┬────────────┘
                           │          │
              ┌────────────┘          └────────────┐
              ▼                                    ▼
  ┌───────────────────────┐          ┌──────────────────────┐
  │     Core Crawler       │          │    jev Classifier     │
  │     (Railway VM)       │          │  (Cloudflare Worker)  │
  │                        │          │                       │
  │  Stage A: Discovery    │          │  POST /v1/classify    │
  │  Stage B: Verification │          │  → vertical, fit,     │
  │  Stage C: Extraction   │          │    tier, language     │
  │                        │          │                       │
  │  Crawlee + Cheerio     │          │  LLM-backed scoring   │
  └───────────────────────┘          └──────────────────────┘
```

**Data flow:**
1. Edge schedules a daily crawl → Core discovers registry leads
2. Core syncs candidates back to Edge via `/inbound/sync`
3. Edge qualifier calls jev to classify each lead (HOT/WARM/COLD/SKIP)
4. Researcher enriches HOT/WARM leads (web crawl + Brave search)
5. Writer drafts personalized outreach pitches
6. Gate stack checks compliance gates → sends via Brevo

---

## Secrets Checklist

| Secret | Purpose | Where to get it |
|--------|---------|----------------|
| `AD_GATEWAY_API_KEY` | AI gateway for LLM calls | agentdeploy.io dashboard |
| `AD_SYNC_SECRET` | Authenticates Core→Edge sync | Auto-generated |
| `BRAVE_API_KEY` | Web search for candidate discovery | [brave.com/search/api](https://brave.com/search/api) |
| `BRAND_NAME` | Used in email signature and disclosure | Your company |
| `BRAND_SITE_URL` | Linked in email signature | Your website |
| `BRAND_ONE_LINER` | Used by the writer to personalize pitches | Your value prop |
| `BREVO_API_KEY` | Transactional email sending | [Brevo dashboard](https://www.brevo.com) |
| `BREVO_SENDER_EMAIL` | Verified sender address | Brevo → Senders & IP |
| `COMPANIES_HOUSE_KEY` | UK Companies House registry API | [developer.company-information.service.gov.uk](https://developer.company-information.service.gov.uk/) |
| `CALENDLY_URL` | Booking link in email signature | Your Calendly |
| `CORE_URL` | bi-core Railway VM URL | Auto-set at provision |
| `JEV_URL` | edge-jev worker URL | Auto-set at provision |

---

## ICP Customization

The ICP is defined in `skills/icp.md` using YAML front-matter:

```yaml
---
nace_include: ["69", "70", "74", "81", "82", "85", "96"]
nace_exclude: ["62", "63", "73", "58", "59"]
age_months_max: 36
size_max: 50
countries: [uk, ie, fr]
must_have: [active_registry_status]
---
```

| Field | Description |
|-------|-------------|
| `nace_include` | SIC/NACE 2-digit codes to target |
| `nace_exclude` | SIC codes to auto-reject |
| `age_months_max` | Skip companies older than N months (0 = no limit) |
| `size_max` | Max employee headcount |
| `countries` | ISO country codes to crawl |
| `must_have` | Required signals (`active_registry_status`) |

Below the front-matter, describe your pain points and anti-patterns in plain English. The qualifier and writer agents use this context.

See `docs/bi-agent-customization.md` for vertical-specific examples.

---

## Using the Playground

The agentdeploy.io Playground gives you a visual interface:

| Tab | What it does |
|-----|-------------|
| **Data Studio** | Browse, filter, edit leads. Import/export CSV. |
| **Pipeline** | Funnel visualization: raw → verified → classified → researched → approved → sent → replied |
| **HITL** | Human-in-the-loop: approve, reject, or edit leads before sending |
| **Agent Wire** | Visualize agent topology and message flow |
| **Schedules** | View and trigger cron jobs (crawl, research, reply poll, housekeeping) |

### Commands

Send commands via `POST /cmd/<command>`:

| Command | Description |
|---------|-------------|
| `/approve <key>` | Approve a lead for outreach |
| `/reject <key>` | Reject a lead |
| `/pause` | Pause all crons and sends |
| `/resume` | Resume from pause |
| `/blacklist <email>` | Permanently block an email |
| `/erase <key>` | GDPR erasure (permanent, unlogged) |
| `/export-csv` | Export all leads as CSV |

---

## Skills

Skills are markdown files in `skills/` that configure agent behavior:

| File | Purpose |
|------|---------|
| `icp.md` | Ideal customer profile — NACE codes, pain points, anti-patterns |
| `outreach-style.md` | Tone, cadence, subject line rules, CTA style |
| `identity.md` | Buyer persona — name, title, brand voice, signature block |
| `compliance.md` | GDPR, EU AI Act, opt-out policy, send safety rules |
| `objection-handling.md` | How to respond to common reply objections |

Edit these files to customize agent behavior without changing code.

---

## Compliance

### GDPR
- Every email includes your physical address and "Reply STOP to opt out"
- Opt-out is permanent — enforced in every gate check
- `/erase` command performs permanent data deletion
- Contact data on opted-out leads is purged after 90 days
- CSV export available (`/export-csv`) for right of portability

### EU AI Act
- All outreach includes an AI disclosure line in the footer
- Disclosure states the initial contact was AI-assisted
- Human interaction offered via Calendly link

### CAN-SPAM
- Valid physical postal address in every email
- Clear opt-out mechanism
- No deceptive subject lines
- `List-Unsubscribe` header on every email

### Send Safety
- **Dry-run is ON by default** — no emails sent until you explicitly enable
- Daily send cap defaults to 10
- Per-domain deduplication
- MX validation required before any send
- Blacklist checked (email, domain, company) on every gate pass

---

## Cost Expectations

Per 100 leads processed:

| Cost Component | Estimate | Notes |
|---------------|----------|-------|
| VM minutes (Core crawler) | ~$0.20 | 100 min × $0.002/min |
| LLM tokens (classification) | ~$0.05 | ~100K tokens × $0.001/1K |
| LLM tokens (research + writer) | ~$0.50 | ~100K tokens × $0.005/1K |
| Brave Search API | ~$0.30 | ~100 queries |
| Brevo email sends | ~$0.00 | Free tier: 300/day |
| **Total per 100 leads** | **~$1.05** | |

Daily budget enforcement:
- `maxVmHoursPerDay` defaults to 2 hours (120 minutes)
- `dailyTokenBudget` can be set via `/cmd/settings`
- `dailyCap` limits email sends per day (default: 10)

---

## Troubleshooting

| Problem | Check |
|---------|-------|
| No leads appearing | `curl /cmd/runs` — did the crawl run? Is `CORE_URL` set? |
| Leads stuck at "raw" | jev classifier may be down. Check `JEV_URL` and `/health` on jev. |
| No emails sending | Check `/cmd/settings` — is `sendEnabled=true`, `dryRun=false`, `paused=false`? |
| "CORE_URL not configured" | Set the `CORE_URL` secret to your bi-core Railway URL |
| Gate blocks everything | Run the verification script: `npx tsx scripts/verify-bi-agent.ts --deployment <id>` |
| Crawl fails immediately | Check `BRAVE_API_KEY` is set and has quota |
| Emails bounce | Check MX validation in lead emails. Blacklist domains that consistently fail. |
| Daily cap hit too early | Increase `dailyCap` via `/cmd/settings` |
 | jev returns COLD for everything | Check ICP `nace_include` matches your target SIC codes |
 | Writer produces generic pitches | Fill in `BRAND_ONE_LINER` and edit `skills/identity.md` |
 | Harvest fails `mkdir /data` | Set `DATA_DIR` to a writable path (dev default `/tmp/bi-core-data`). Read **lazily** at call time — must not be read at module scope (imports are hoisted before `.env` loads). |
 | Crawl hangs on one candidate | A peer accepted TCP but never responds. All `fetch` calls are wrapped with a timeout (`HTTP_TIMEOUT_MS`, default 30s) via `src/http.ts`. |
 | Crawl seems stuck (no logs) | Verify logs `[verify] progress N/125` every 10 candidates. Expect ~10s/candidate (Brave discovery) → ~20 min for a full batch. |


### Verification Script

Run a full health check:

```bash
npx tsx scripts/verify-bi-agent.ts --deployment <your-edge-id> --env production
```

This checks all 8 critical systems and produces a pass/fail report with recommendations.

### Logs

- **Edge worker:** Cloudflare dashboard → Workers → your worker → Logs
- **Core VM:** Railway dashboard → your project → bi-core → Deployments → Logs
- **jev classifier:** Cloudflare dashboard → Workers → edge-jev → Logs
