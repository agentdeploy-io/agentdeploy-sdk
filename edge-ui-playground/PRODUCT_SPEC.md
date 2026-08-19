# AgentDeploy Edge Console — Product Specification

**Document purpose:** Hand this to your UI specialist. Every view, every CRUD operation, every control surface is defined here.

**What this is:** The evolution of `edge-ui-playground` from a local testing toy into **AgentDeploy Edge Console** — a production management plane for Cloudflare Workers + Agents SDK deployments, positioned as a superior alternative to both Cloudflare's own dashboard and Mastra Studio.

---

## Table of Contents

1. [Positioning & Competitive Landscape](#1-positioning--competitive-landscape)
2. [What We Already Have (Do Not Rebuild)](#2-what-we-already-have-do-not-rebuild)
3. [Architecture: From Playground to Console](#3-architecture-from-playground-to-console)
4. [Navigation & Information Architecture](#4-navigation--information-architecture)
5. [View Specifications](#5-view-specifications)
6. [CRUD Matrix](#6-crud-matrix)
7. [Control Surfaces — What Can Be Edited](#7-control-surfaces--what-can-be-edited)
8. [Data Models](#8-data-models)
9. [Phased Delivery](#9-phased-delivery)

---

## 1. Positioning & Competitive Landscape

### The Gap We Fill

| Product | What It Does Well | What It Lacks |
|---------|------------------|---------------|
| **Cloudflare Dashboard** | Worker deployment, versioning, secrets, cron triggers, analytics, logs | No agent-awareness, no DO state inspection, no prompt/model editing, no evaluation, no chat testing |
| **Mastra Studio** | Agent prompt editing, eval/scoring, workflow visualization, datasets, observability traces | Cloudflare-specific operations (DO state, wrangler config, KV/R2/D1), real deployment management |
| **AgentDeploy Edge Console** (us) | **Both**: agent-aware management + Cloudflare-native operations + prompt/model editing + live chat testing + DO state inspection + cron management + observability — all in one place | — |

### Our Unfair Advantage

We're a Cloudflare whitelabel (agentdeploy.io). We control:
- The deployment pipeline (wrangler, deployment-service)
- The billing gateway (LLM call routing through `AD_GATEWAY_*`)
- The SDK (`createAgent`, `createChatAgent`, `useGateway`, `useSecrets`)
- The agent handler (CORS, routing, health endpoints)

This means we can expose control surfaces that Cloudflare's own dashboard can't — because we know the agent's structure, its tools, its prompt, its model config, and its DO state schema.

---

## 2. What We Already Have (Do Not Rebuild)

### From `edge-ui-playground` (current)
- 4 UI shells: ChatShell, WidgetShell, DashboardShell, SplitShell
- Theme system (light/dark, 6 accent colors, CSS variables)
- Device frame simulation (desktop/mobile)
- Agent switching sidebar
- Vite proxy to multiple wrangler backends
- WebSocket connections via `useAgentChat()` and `useAgent()`

### From `edge-sdk`
- `createAgent()` / `createChatAgent()` factories
- `createHandler()` with CORS, routing, health endpoints
- `useGateway()` for LLM billing/routing
- `useSecrets()` for typed secret access
- `connectMcp()` for MCP server integration
- Telemetry hooks (`__adTelemetry`, `__adReportUsage`)
- Scheduling helpers (`schedule()`, `scheduleEvery()`, `getSchedules()`)

### From main `agent-deploy` platform (Next.js)
- Full user auth & role system (buyer, seller, operator)
- Template marketplace & CRUD
- Deployment tracking & history
- Token/billing system
- MCP server listings management
- KYC, disputes, payouts, support tickets
- Existing dashboards at `/[handle]/dashboard/buyer/` and `/seller/`

### From Cloudflare Agents SDK
- DO state sync via `onStateUpdate`
- RPC method invocation
- SQLite SQL access within DOs (`this.sql()`)
- DO storage (key-value within DO)
- Alarm/scheduling API
- Agent naming via kebab-case binding names

**The Edge Console is a NEW product layer** that sits between these existing systems. It does NOT replace the Next.js marketplace/billing platform. It adds a deployment management interface for running agents.

---

## 3. Architecture: From Playground to Console

### Current State
```
Browser → localhost:5173 (Vite) → proxy → wrangler instances (8787/8788/8789)
```
A single-page React app with a hardcoded `AGENTS` array and shell selector.

### Target State
```
Browser → Edge Console (React SPA)
              │
              ├── Agent Connections (WebSocket) ──→ Running agent DOs
              │                                     (chat, state sync, RPC)
              │
              ├── Console API Layer ──→ AgentDeploy Backend
              │   (REST/WS)              (deployment status, configs,
              │                            secrets, telemetry, billing)
              │
              └── Cloudflare API Proxy ──→ Cloudflare REST API
                   (optional)              (workers, KV, R2, D1, analytics)
```

### Key Architectural Decisions

1. **Console API Layer**: A new API service (Next.js API route or standalone) that aggregates data from:
   - AgentDeploy backend (deployments, billing, templates)
   - Cloudflare API (worker status, analytics, logs)
   - Direct agent DO connections (state, schedules, storage)

2. **Agent Connection Manager**: Abstract the current `useAgent()` / `useAgentChat()` hooks into a connection pool that manages multiple agent WebSocket connections simultaneously.

3. **Configuration Layer**: Read/write agent configuration (model, prompt, tools, cron triggers) through a combination of:
   - DO state mutations (runtime config changes without redeploy)
   - wrangler.jsonc file editing (structural changes)
   - Secrets Store API (credential rotation)

4. **The Console is embeddable**: The edge-ui shells (ChatShell, DashboardShell, etc.) remain embeddable components. The Console wraps them in a management chrome.

---

## 4. Navigation & Information Architecture

### Sidebar Structure

```
┌─────────────────────────────────────────────┐
│  AgentDeploy Edge Console                    │
│  [Environment Selector: Production ▾]        │
├─────────────────────────────────────────────┤
│                                              │
│  📊 Overview                                 │
│     Platform health, all agents at a glance  │
│                                              │
│  🤖 Agents                                   │
│     All deployed agent instances             │
│     ├── [per-agent detail view]              │
│                                              │
│  💬 Conversations                            │
│     Chat history across all chat agents      │
│     Live sessions, session browser           │
│                                              │
│  ⚡ Workers & Deployments                    │
│     Worker versions, deploy history,         │
│     rollback, traffic splitting              │
│                                              │
│  🔧 Configuration                            │
│     ├── Prompts & Models                     │
│     ├── Tools & MCP                          │
│     ├── Schedules & Crons                    │
│     ├── Secrets & Environment                │
│     └── Bindings (KV, R2, D1, DO, AI)        │
│                                              │
│  📈 Observability                             │
│     ├── Traces                               │
│     ├── Logs (live tail)                     │
│     ├── Metrics                              │
│     └── Errors & Alerts                      │
│                                              │
│  🧪 Testing & Evaluation                     │
│     ├── Playgrounds                          │
│     ├── Test Suites                          │
│     └── Datasets                             │
│                                              │
│  🔒 Security & Access                        │
│     Rate limits, WAF, auth tokens            │
│                                              │
│  💰 Billing & Usage                          │
│     Token consumption, cost analytics        │
│                                              │
│  ⚙️ Settings                                 │
│     Team, API keys, webhooks                 │
│                                              │
└─────────────────────────────────────────────┘
```

### Environment Switcher

Top-level selector that switches the entire console context:
- **Production** — Live deployed agents
- **Staging** — Pre-production environment
- **Preview** — Ephemeral preview deployments
- **Local** — `localhost` wrangler instances (current playground mode)

---

## 5. View Specifications

### 5.1 — Overview Dashboard

**Purpose:** Platform health at a glance. First thing users see.

**Layout:** Grid of cards + activity feed

**Cards:**
| Card | Content |
|------|---------|
| Active Agents | Count, green/red status dots, list of unhealthy agents |
| Requests Today | Total HTTP + WebSocket requests, sparkline trend |
| Token Usage | Tokens consumed today, cost estimate, budget bar |
| Error Rate | % of requests with errors, top 3 error types |
| Active Connections | Live WebSocket connections count |
| Cron Jobs Run | Last 24h scheduled executions, success/fail |

**Activity Feed (right column):**
- Real-time stream of: deployments, errors, cron completions, threshold alerts
- Filterable by type and severity
- Click-through to detail view

**Quick Actions:**
- "Deploy New Agent" button
- "Test in Playground" button
- "View Logs" shortcut

---

### 5.2 — Agents List & Detail

#### 5.2a — Agents List View

**Purpose:** See all deployed agents across all workers.

**Table columns:**
| Column | Description |
|--------|-------------|
| Name | Agent display name + kebab-case binding name |
| Type | Chat (AIChatAgent) or Worker (Agent) |
| Status | Online / Offline / Error (real-time WebSocket ping) |
| Worker | Which wrangler/worker hosts this DO |
| Last Active | Timestamp of last activity |
| Requests 24h | Request count with trend arrow |
| Tokens 24h | Token consumption |
| Actions | [Chat] [Monitor] [Config] [Logs] dropdown |

**Filters:**
- By type (chat/worker)
- By status (online/offline/error)
- By worker
- Search by name

**Bulk Actions:**
- Restart selected agents
- Export metrics
- Bulk config update (e.g., change model on multiple agents)

#### 5.2b — Agent Detail View (Tabbed)

The agent detail is the **core workspace**. Tabs:

---

**Tab 1: Chat (chat agents only)**
- Full ChatShell interface (reuse existing component)
- Session selector: switch between conversation threads
- "New Session" button
- Connection status indicator
- Model/temperature override controls above chat
- Token usage display per message
- Tool call inspector: expandable panel showing tool name, args, result, latency for each tool invocation within a message

---

**Tab 2: Monitor (all agents)**

Reuse DashboardShell but enhanced:

- **State Inspector**: Live JSON tree of agent's `this.state` via `onStateUpdate`. Editable fields for quick testing — type a new value, hit enter, it calls `setState()` via RPC.
- **Metrics Grid**: Configurable cards pulling from agent state:
  ```typescript
  // User defines which state keys to surface as metric cards
  { label: "Orders Tracked", stateKey: "stats.totalOrders", format: "number" }
  { label: "Alerts Sent", stateKey: "stats.alertsSent", format: "number" }
  { label: "Last Scan", stateKey: "lastScanTime", format: "relativeTime" }
  ```
- **RPC Triggers**: Buttons that call agent RPC methods. Auto-discovered from agent's method definitions. Each trigger shows:
  - Method name
  - Input fields (if method accepts args)
  - "Execute" button
  - Result output panel
  - Last execution time + status
- **Connection Info**: WebSocket URL, DO instance ID, binding name, connection duration

---

**Tab 3: Configuration**

This is where Mastra-style agent editing happens. Sections:

**System Prompt**
- Monaco editor (or CodeMirror) with syntax highlighting
- Template variable support: `{{user.name}}`, `{{context.timezone}}`
- Version history (diff between saves)
- "Test Prompt" button → opens chat with this prompt applied

**Model Settings**
- Model selector dropdown (populated from gateway: Qwen, Llama, GPT, Claude, etc.)
- Temperature slider (0.0 - 2.0)
- Max tokens input
- Top-P slider
- Frequency penalty
- Presence penalty
- Stop sequences
- Stream toggle
- **Cost preview**: estimated cost per 1K tokens for selected model

**Tools**
- List of attached tools with enable/disable toggles
- Per-tool configuration:
  - Tool name (read-only, from code)
  - Description override (editable — same as Mastra's description override)
  - Input schema viewer (read-only JSON Schema display)
  - "Test Tool" button → opens tool tester with input form
- "Add Tool" button:
  - From code (already defined in agent class)
  - From MCP server (browse installed MCP servers)
  - From tool registry (shared tools)
- Tool approval workflow toggle: `requireApproval: boolean`
- Tool execution order/priority

**Memory & Knowledge**
- **Chat History**: Max messages to retain (slider)
- **Working Memory**: Enable/disable, configure extraction rules
- **RAG / Knowledge Base**:
  - Document list (upload, delete, re-index)
  - Vector store status
  - Chunk size configuration
  - Embedding model selection
  - "Test Retrieval" button → query input, see retrieved chunks with scores

**Agent Behavior**
- Max turns per conversation
- Idle timeout
- Auto-retry on failure (toggle + retry count)
- Fallback model (if primary fails)
- Rate limit per user (requests/minute)

---

**Tab 4: Schedules & Crons**

- **Cron Triggers** (from wrangler.jsonc `triggers.crons`):
  - List of cron expressions with descriptions
  - Add new cron trigger (cron expression builder UI)
  - Edit existing cron expression
  - Delete cron trigger
  - Toggle active/inactive
  - Next 5 execution times (preview)
  - Last execution: time, status, duration, result

- **Agent Schedules** (from DO `schedule()` / `scheduleEvery()`):
  - List of active schedules (auto-discovered from agent state)
  - Each schedule shows: schedule ID, cron/time, method name, next fire, last fire
  - Cancel schedule button
  - "Trigger Now" button (manual fire)
  - Pause/resume toggle

- **Execution History**:
  - Paginated table: time, trigger type (cron/schedule/manual), method, status, duration, result summary
  - Click row → execution detail with logs

---

**Tab 5: Storage**

Inspect and manage the agent's Durable Object storage:

- **State**: JSON view of `this.state` (read/write)
- **SQL Tables**: Browse SQLite tables inside the DO
  - Table list
  - Row browser with pagination
  - SQL query editor (run `SELECT * FROM ... LIMIT 10`)
  - Export table as CSV
- **KV Storage**: Key-value pairs in DO storage
  - Browse keys with filter
  - View/edit/delete values
  - Bulk delete with pattern match
- **Storage Stats**: Total size, number of keys, number of SQL rows

---

**Tab 6: Logs**

- Live tail of agent-specific logs
- Filter by level (DEBUG, INFO, WARN, ERROR)
- Search within logs
- Timestamp, level, message, expandable context
- Auto-scroll toggle
- Export logs button
- Link to full trace if log entry is part of a trace

---

**Tab 7: Traces**

- List of traces for this agent (each trace = one request/invocation)
- Timeline view showing:
  - LLM calls (model, prompt length, response length, latency, tokens, cost)
  - Tool calls (tool name, args, result, latency)
  - DO operations (state reads/writes, SQL queries, storage ops)
  - External fetch calls (URL, method, status, latency)
- Click trace → detail view with:
  - Waterfall visualization
  - Span details
  - Input/output for each span
  - Token usage breakdown
  - Cost breakdown

---

**Tab 8: Version History**

- List of agent config versions (every prompt/model/tool change creates a version)
- Each version: timestamp, author, change summary, diff
- "Restore" button (rollback)
- "Compare" button (side-by-side diff of any two versions)
- Version tags (e.g., "v1.2-production")

---

### 5.3 — Conversations View

**Purpose:** Browse and manage all chat conversations across all chat agents.

**Layout:** Three-panel (similar to Slack or Intercom)
- Left: Agent filter + session list
- Center: Conversation view (read-only or interactive)
- Right: Context panel (user info, metadata, tools used)

**Features:**
- Search across all conversations
- Filter by agent, date range, tools used, sentiment
- "Handoff" view: shows when a conversation was transferred between agents
- Export conversation as JSON or markdown
- Delete/archived conversations
- Pin important conversations
- Annotate conversations (operator notes)

---

### 5.4 — Workers & Deployments

**Purpose:** Manage the Cloudflare Workers that host agents.

#### Workers List
| Column | Description |
|--------|-------------|
| Name | Worker name |
| Status | Active/Inactive/Error |
| Version | Current deployed version |
| Agents | Count of DOs bound to this worker |
| Deployed At | Last deployment timestamp |
| Requests 24h | HTTP request count |
| Region | Deployment region (if placement configured) |
| Actions | [Deploy] [Rollback] [Settings] [Logs] |

#### Deployment Detail
- **Version History**: List of all versions (up to 100)
  - Version number, timestamp, deployer, commit hash
  - "Promote" button (deploy specific version)
  - "Rollback" button
  - "Preview" button (generate preview URL)
- **Gradual Deployment**: Traffic splitter between two versions
  - Slider: 0-100% to new version
  - Auto-promote on success threshold
- **Deploy New Version**:
  - Source: Git (auto-build), Upload (wrangler), Template (from marketplace)
  - Environment selection
  - Pre-deploy validation (syntax check, binding check)
  - Deploy log stream

#### Worker Settings
- **Compatibility**: Date, flags (nodejs_compat, etc.)
- **Placement**: Smart placement toggle, preferred region
- **Limits**: CPU limit, memory, execution duration
- **Assets**: Static asset configuration

---

### 5.5 — Configuration Views

#### 5.5a — Prompts & Models (Global)

Cross-agent prompt and model management:

- **Prompt Library**: Reusable prompt templates
  - Create, edit, version, delete
  - Template variables (Jinja-style or `{{var}}`)
  - Categories (system, greeting, escalation, fallback)
  - Import from existing agent prompts

- **Model Registry**: All available models from the gateway
  - Model name, provider, context window, cost/1K tokens
  - Capability tags (vision, tools, streaming, JSON mode)
  - Default model setting
  - Model aliases (e.g., "fast" → "Qwen/Qwen3.6-27B-TEE")

- **Prompt Versioning**: Every save creates a version. Compare versions. Rollback.

#### 5.5b — Tools & MCP

- **Tool Registry**: All available tools across the platform
  - Code-defined tools (from agent classes)
  - MCP-sourced tools (from connected MCP servers)
  - Shared tools (platform-level utilities)
  - Each tool: name, description, input schema, output schema, source, owner agent

- **MCP Server Management**:
  - List of installed MCP servers
  - Install new MCP server (URL or package name)
  - Configure MCP server (auth, headers, timeout)
  - Test MCP server connection
  - View available tools/resources from MCP server
  - Publish/unpublish MCP listings (connects to marketplace)
  - MCP server analytics (calls, latency, errors)

- **Tool Testing Sandbox**:
  - Select a tool
  - View input schema
  - Fill in inputs (form generated from JSON Schema)
  - Execute tool
  - View result + latency
  - Save test case to dataset

#### 5.5c — Schedules & Crons (Global)

Cross-agent view of all scheduled tasks:

- **Unified Schedule Table**:
  | Agent | Type | Schedule | Method | Next Fire | Last Run | Status | Actions |
  |-------|------|----------|--------|-----------|----------|--------|---------|
  | support | cron | `*/15 * * * *` | (scheduled) | 2:30 PM | 2:15 PM | ✅ | [Edit] [Pause] [Run Now] |
  | polymarket-intel | schedule | every 60s | scanOrderbook | 2:31 PM | 2:30 PM | ✅ | [Cancel] [Run Now] |
  | gmail-invoices | cron | `*/20 * * * *` | (scheduled) | 2:40 PM | 2:20 PM | ✅ | [Edit] [Pause] |

- **Cron Builder**: Visual cron expression builder
  - Dropdown presets: every minute, every 5 min, hourly, daily at X, weekly, custom
  - Human-readable description of cron expression
  - Next 5 execution times preview
  - Timezone selector (with UTC default)

- **Execution Calendar**: Calendar view showing all scheduled executions
- **Failure History**: All failed cron/schedule executions with error details

#### 5.5d — Secrets & Environment

- **Environment Variables** (plaintext):
  - Key-value pairs
  - Per-environment (production, staging, preview, local)
  - Bulk import/export

- **Secrets** (encrypted):
  - Key-value pairs (value masked)
  - Rotate button (enter new value)
  - Last rotated timestamp
  - Reference count (how many agents use this)
  - Categories: LLM keys, OAuth credentials, webhook URLs, API keys

- **Secrets Store** (account-level):
  - Centralized secret management
  - Access control per secret
  - Audit trail (who accessed/modified)
  - Binding to workers

- **`.dev.vars` Editor**: For local development
  - Edit local secrets file
  - Sync from production (masked values)
  - Validate all referenced secrets exist

#### 5.5e — Bindings

Manage Cloudflare resource bindings:

- **Durable Objects**: List all DO bindings, class names, migration status
- **KV Namespaces**: Create, view keys, edit values, delete namespaces
- **R2 Buckets**: Browse objects, upload, delete, configure CORS
- **D1 Databases**: SQL editor, table browser, query history
- **AI Binding**: Model access configuration
- **Queues**: Create, configure consumers, view messages, dead letter queue
- **Hyperdrive**: Connection pool configuration
- **Service Bindings**: Worker-to-worker bindings

---

### 5.6 — Observability

#### 5.6a — Traces

- **Trace List**: Paginated, filterable
  - Filters: agent, time range, status (success/error), duration range, cost range, tool used, model used
  - Columns: trace ID, agent, start time, duration, status, cost, model, tool count

- **Trace Detail** (waterfall view):
  ```
  [=== LLM Call (Qwen 27B) 432ms $0.003 ===]
       [== Tool: searchKB 89ms ==]
            [= DO State Read 12ms =]
       [== Tool: checkOrder 156ms ==]
            [= External Fetch 134ms =]
  [=== LLM Call (Qwen 27B) 298ms $0.002 ===]
  ```
  Each span expandable: input, output, metadata
  Token usage breakdown per LLM span
  Cost attribution per span

#### 5.6b — Logs (Live Tail)

- Real-time log streaming (WebSocket)
- Multi-source: worker logs, agent logs, DO logs, cron logs
- Filter by: source, level, time range, text search
- Structured log fields: timestamp, level, message, agent, worker, traceId, userId
- Click log → expand context, link to trace
- Save filter as saved view
- Export as JSON/CSV

#### 5.6c — Metrics

- **Dashboard Builder**: Create custom metric dashboards
  - Drag-and-drop widget grid
  - Widget types: line chart, bar chart, counter, heatmap, table
  - Data sources: requests, tokens, costs, errors, latency, tool usage
  - Group by: agent, worker, model, user, time bucket

- **Pre-built Dashboards**:
  - Request volume (24h, 7d, 30d)
  - Token consumption by agent
  - Cost breakdown by model
  - Error rate timeline
  - Latency percentiles (p50, p90, p99)
  - WebSocket connection count
  - Tool usage distribution
  - Cron execution success rate

#### 5.6d — Errors & Alerts

- **Error Tracker**: Grouped error display (like Sentry)
  - Error message, stack trace, first/last seen, count, affected users
  - Trend chart per error group
  - Assign status (open, triaged, resolved)
  - Auto-grouping by similarity

- **Alert Rules**:
  - Condition: metric > threshold for N minutes
  - Channel: email, Slack webhook, PagerDuty, custom webhook
  - Alert history log
  - Silence/mute rules

---

### 5.7 — Testing & Evaluation

#### 5.7a — Playgrounds

Multiple playground modes:

- **Chat Playground**: Current ChatShell but with controls
  - Agent selector
  - Model override
  - Temperature override
  - System prompt override (temporary)
  - Tool enable/disable
  - Save conversation as test case

- **Tool Playground**: Test individual tools
  - Tool selector
  - Input form (generated from schema)
  - Execute + result display
  - Compare results across model versions

- **Workflow Playground**: Test multi-step agent flows
  - Step-through debugger
  - State inspector at each step
  - Mock tool responses

#### 5.7b — Test Suites

- **Test Case Management**:
  - Test case: input message + expected behavior
  - Expected behavior can be: exact match, contains text, tool was called, tool was NOT called, response time < Ns, JSON schema match
  - Organize into suites
  - Run suite against specific agent version

- **Batch Testing**:
  - Upload CSV/JSON of test inputs
  - Run against agent
  - Results table: input, output, pass/fail, score, latency, cost

- **A/B Testing**:
  - Run same test suite against two agent versions
  - Side-by-side comparison of outputs
  - Statistical significance indicators

#### 5.7c — Datasets

- **Dataset Management**:
  - Create datasets with schema definition
  - Add items (single or bulk import)
  - Version history
  - Use in evaluations

- **Automated Evaluation (Scorers)** — inspired by Mastra:
  - LLM-as-judge scorer (rate response quality 1-5)
  - Toxicity checker
  - Answer relevancy scorer
  - Custom rule-based scorers
  - Attach scorers to agents or test suites
  - Run scorers against live traffic (sampling rate configurable)

- **Experiment Results**:
  - Run dataset through agent
  - Apply scorers
  - Per-item results
  - Aggregate scores
  - Compare across agent versions

---

### 5.8 — Security & Access

- **Rate Limiting**:
  - Per-agent rate limits (requests/min, tokens/min)
  - Per-user rate limits
  - Burst configuration
  - Action on limit: block, queue, degrade

- **Access Tokens**:
  - Generate API tokens for agent access
  - Scope tokens to specific agents or operations
  - Expiration configuration
  - Usage tracking per token
  - Revoke tokens

- **CORS Configuration**:
  - Allowed origins per agent
  - Allowed methods
  - Credential support toggle

- **Authentication**:
  - Public agents (no auth)
  - Token-based (API key)
  - JWT validation
  - Cloudflare Access integration

---

### 5.9 — Billing & Usage

- **Token Consumption Dashboard**:
  - Real-time token usage by agent
  - Daily/weekly/monthly trends
  - Cost breakdown by model
  - Budget alerts
  - Per-user attribution

- **Usage Quotas**:
  - Set per-agent token limits
  - Set per-user request limits
  - Auto-throttle or hard stop

- **Cost Optimization**:
  - Recommend cheaper models for simple queries
  - Cache hit rate for identical prompts
  - Prompt length optimization suggestions

- **Invoice History**:
  - Monthly cost summaries
  - Export for accounting

---

### 5.10 — Settings

- **Team Management**:
  - Invite team members
  - Role assignment (admin, developer, viewer, operator)
  - Per-agent permission control
  - Audit log of team actions

- **API Keys**:
  - Console API keys for programmatic access
  - Webhook signing secrets

- **Webhooks**:
  - Register webhook endpoints
  - Event selection (deployment, error, threshold, cron)
  - Delivery history with retry
  - Test webhook

- **Integrations**:
  - Slack (alerts)
  - GitHub (auto-deploy)
  - Sentry (error tracking)
  - Datadog/Grafana (metrics export)
  - OpenTelemetry export endpoint

---

## 6. CRUD Matrix

What can be Created, Read, Updated, Deleted:

| Entity | Create | Read | Update | Delete | Notes |
|--------|--------|------|--------|--------|-------|
| **Agent Instance** | ❌ | ✅ | ✅ config | ✅ (delete DO) | Created via deployment, not manually |
| **Agent Configuration** | ✅ | ✅ | ✅ | ✅ | Prompt, model, tools, behavior |
| **Agent State** | ❌ | ✅ | ✅ (RPC) | ✅ (reset) | Live DO state via WebSocket |
| **Chat Sessions** | ✅ | ✅ | ❌ | ✅ | Via WS or REST |
| **Chat Messages** | ✅ | ✅ | ❌ | ✅ | Via WS or REST |
| **Cron Triggers** | ✅ | ✅ | ✅ | ✅ | Via wrangler.jsonc or Cloudflare API |
| **Agent Schedules** | ✅ | ✅ | ✅ (pause/resume) | ✅ (cancel) | Via DO `schedule()` API |
| **Environment Variables** | ✅ | ✅ | ✅ | ✅ | Per environment |
| **Secrets** | ✅ | ✅ (masked) | ✅ (rotate) | ✅ | Encrypted store |
| **KV Namespaces** | ✅ | ✅ | ✅ | ✅ | Cloudflare KV API |
| **KV Entries** | ✅ | ✅ | ✅ | ✅ | Key-value CRUD |
| **R2 Objects** | ✅ (upload) | ✅ | ✅ (replace) | ✅ | Object storage CRUD |
| **D1 Tables** | ✅ (SQL) | ✅ | ✅ (SQL) | ✅ (SQL) | SQL queries |
| **DO Migrations** | ✅ | ✅ | ❌ | ❌ | Append-only migration tags |
| **Worker Versions** | ✅ (deploy) | ✅ | ✅ (promote) | ✅ (within limit) | Version management |
| **Prompt Templates** | ✅ | ✅ | ✅ | ✅ | Reusable library |
| **Model Configs** | ✅ | ✅ | ✅ | ✅ | Per-agent model settings |
| **Tools** | ❌ (code) | ✅ | ✅ (enable/desc) | ✅ (detach) | Code-defined, config-attached |
| **MCP Servers** | ✅ | ✅ | ✅ | ✅ | Install/configure/remove |
| **Test Cases** | ✅ | ✅ | ✅ | ✅ | Test management |
| **Test Suites** | ✅ | ✅ | ✅ | ✅ | Collections of test cases |
| **Datasets** | ✅ | ✅ | ✅ | ✅ | Versioned test data |
| **Scorers** | ✅ | ✅ | ✅ | ✅ | Evaluation functions |
| **Alert Rules** | ✅ | ✅ | ✅ | ✅ | Monitoring alerts |
| **Access Tokens** | ✅ | ✅ | ✅ (expire) | ✅ (revoke) | API tokens |
| **Team Members** | ✅ (invite) | ✅ | ✅ (role) | ✅ (remove) | Team management |
| **Webhooks** | ✅ | ✅ | ✅ | ✅ | Event webhooks |
| **Rate Limit Rules** | ✅ | ✅ | ✅ | ✅ | Per-agent limits |

---

## 7. Control Surfaces — What Can Be Edited

### Runtime-Editable (no redeploy needed)

These changes take effect immediately via DO RPC calls:

| Control | Mechanism | Impact |
|---------|-----------|--------|
| System prompt | `setState({ systemPrompt })` | Next message uses new prompt |
| Model selection | `setState({ model })` | Next LLM call uses new model |
| Temperature | `setState({ temperature })` | Next LLM call |
| Max tokens | `setState({ maxTokens })` | Next LLM call |
| Tool enable/disable | `setState({ disabledTools: [...] })` | Next message |
| Tool description override | `setState({ toolOverrides: {...} })` | Next message |
| Max conversation turns | `setState({ maxTurns })` | Enforced on next message |
| Idle timeout | `setState({ idleTimeout })` | Timer reset |
| Rate limit per user | `setState({ rateLimit })` | Enforced immediately |
| Schedule pause/resume | `cancelSchedule()` / re-`schedule()` | Takes effect on next fire cycle |
| Agent state values | `setState()` directly | Immediate |

### Config-Editable (requires redeploy)

These changes modify `wrangler.jsonc` or source code and require a new deployment:

| Control | Mechanism | Impact |
|---------|-----------|--------|
| New cron triggers | Edit `wrangler.jsonc` → deploy | Global cron registrar picks up |
| DO binding names | Edit `wrangler.jsonc` → deploy | URL routing changes |
| New DO classes | Edit code + migration → deploy | New agent type available |
| Compatibility flags | Edit `wrangler.jsonc` → deploy | Runtime behavior |
| KV/R2/D1/Queue bindings | Edit `wrangler.jsonc` → deploy | New resource access |
| Worker placement | Edit `wrangler.jsonc` → deploy | Geographic routing |
| New tool definitions | Edit code → deploy | New tools available to attach |

### Secret-Editable (via Secrets Store API, hot-reloaded)

| Control | Mechanism | Impact |
|---------|-----------|--------|
| API keys (OpenAI, Slack, etc.) | Update secret → worker re-reads | Next call uses new value |
| OAuth credentials | Update secret → re-auth flow | Next auth cycle |
| Webhook URLs | Update secret → next call | Immediate |
| Gateway API key | Update `AD_GATEWAY_API_KEY` | Next LLM call |

---

## 8. Data Models

### Agent Configuration (stored in DO state + versioned in backend)

```typescript
interface AgentConfiguration {
  // Identity
  agentId: string;              // kebab-case binding name
  displayName: string;
  description: string;
  workerId: string;             // parent worker
  type: "chat" | "worker";

  // Model
  model: string;                // "Qwen/Qwen3.6-27B-TEE"
  fallbackModel?: string;       // used if primary fails
  temperature: number;          // 0.0 - 2.0
  maxTokens: number;
  topP: number;
  frequencyPenalty: number;
  presencePenalty: number;
  stopSequences: string[];
  stream: boolean;

  // Prompt
  systemPrompt: string;
  greeting?: string;
  promptVariables: Record<string, string>;

  // Tools
  enabledTools: string[];
  disabledTools: string[];
  toolDescriptionOverrides: Record<string, string>;
  toolsRequiringApproval: string[];

  // Memory
  maxHistoryMessages: number;
  workingMemoryEnabled: boolean;
  ragEnabled: boolean;
  ragConfig?: {
    embeddingModel: string;
    chunkSize: number;
    topK: number;
    vectorStoreId: string;
  };

  // Behavior
  maxTurns: number;
  idleTimeoutMs: number;
  autoRetry: boolean;
  retryCount: number;
  rateLimitPerUser: number;     // requests per minute

  // Schedules
  schedules: ScheduleConfig[];

  // Versioning
  version: string;              // semver or hash
  versionStatus: "draft" | "published" | "archived";
  previousVersion?: string;
}

interface ScheduleConfig {
  id: string;
  type: "cron" | "interval" | "one-time";
  expression?: string;          // cron expression
  intervalSeconds?: number;     // for interval type
  executeAt?: number;           // timestamp for one-time
  methodName: string;           // agent method to call
  args?: unknown[];
  timezone: string;
  paused: boolean;
  lastFiredAt?: number;
  nextFireAt?: number;
}
```

### Agent Runtime State (live in DO)

```typescript
interface AgentRuntimeState {
  // Connection
  status: "online" | "offline" | "error" | "initializing";
  connectedClients: number;
  uptime: number;               // ms since DO started

  // Activity
  lastActivity: number;         // timestamp
  totalRequests: number;
  totalErrors: number;
  totalTokensUsed: number;
  totalCost: number;

  // Conversations (chat agents)
  activeConversations: number;
  totalMessages: number;

  // Custom state (agent-specific)
  custom: Record<string, unknown>;
}
```

### Trace Model

```typescript
interface Trace {
  id: string;
  agentId: string;
  workerId: string;
  startedAt: number;
  durationMs: number;
  status: "success" | "error" | "timeout";

  spans: TraceSpan[];

  // Aggregated
  totalTokensIn: number;
  totalTokensOut: number;
  totalCost: number;
  modelCalls: number;
  toolCalls: number;
  errorCount: number;

  // Context
  userId?: string;
  sessionId?: string;
  requestId?: string;
}

interface TraceSpan {
  id: string;
  parentId?: string;
  type: "llm" | "tool" | "storage" | "fetch" | "do" | "custom";
  name: string;
  startedAt: number;
  durationMs: number;
  status: "success" | "error";

  // Type-specific
  input?: unknown;
  output?: unknown;
  metadata?: {
    // LLM spans
    model?: string;
    tokensIn?: number;
    tokensOut?: number;
    cost?: number;

    // Tool spans
    toolName?: string;
    toolArgs?: unknown;
    toolResult?: unknown;

    // Fetch spans
    url?: string;
    method?: string;
    statusCode?: number;

    // Storage spans
    operation?: string;         // "get" | "put" | "delete" | "sql"
    key?: string;
    rowsAffected?: number;
  };
}
```

---

## 9. Phased Delivery

### Phase 1: Agent Operations Console (Weeks 1-4)
*Core value: see and control running agents*

**Build:**
1. Enhanced agents list (real-time status polling, not just hardcoded array)
2. Agent detail with Monitor tab (state inspector, RPC triggers, metrics grid)
3. Agent detail with Chat tab (session selector, tool call inspector)
4. Agent detail with Storage tab (DO state, SQL browser, KV browser)
5. Agent detail with Schedules tab (view/pause/resume/trigger schedules, view cron triggers)
6. Live log tailing per agent
7. Environment switcher (production/staging/local)

**Reuse:** ChatShell, DashboardShell, theme system, Vite proxy architecture

**New backend needed:**
- Agent discovery API (list all DO instances across workers)
- Agent state inspection API (read DO state without WebSocket)
- Agent RPC proxy API (call DO methods from console)
- Log streaming API (aggregate logs from multiple workers)

### Phase 2: Configuration & Editing (Weeks 5-8)
*Core value: edit agents without touching code*

**Build:**
1. Configuration tab (prompt editor with Monaco, model selector, tool manager)
2. Secrets & environment management UI
3. Prompts library (create, version, reuse)
4. Model registry display
5. Tool registry + MCP server management
6. Prompt/model changes applied at runtime via DO RPC (no redeploy)
7. Version history for config changes (diff, rollback)
8. Cron trigger editor (add, edit, delete via wrangler.jsonc or API)

**New backend needed:**
- Config version store (every change versioned)
- Cloudflare API proxy for wrangler.jsonc management
- Secrets store API integration
- MCP server management API

### Phase 3: Observability (Weeks 9-12)
*Core value: understand what agents are doing*

**Build:**
1. Trace collection (instrument LLM calls, tool calls, fetches)
2. Trace waterfall viewer
3. Metrics dashboards (request volume, tokens, cost, errors, latency)
4. Error tracker (grouped, trended)
5. Alert rules (condition → channel)
6. Cross-agent conversation browser
7. Overview dashboard (platform health)

**New backend needed:**
- Trace ingestion pipeline (from SDK telemetry hooks)
- Metrics aggregation service
- Alert evaluation engine
- WebSocket log aggregation

### Phase 4: Testing & Evaluation (Weeks 13-16)
*Core value: ensure agent quality*

**Build:**
1. Test case management (input → expected behavior)
2. Test suite runner (batch test against agent version)
3. Dataset management (versioned test data)
4. Scorers (LLM-as-judge, rule-based, custom)
5. Experiment runner (run dataset through agent, score results)
6. A/B comparison (two agent versions side-by-side)
7. Live evaluation (score X% of live traffic)

**New backend needed:**
- Test execution engine
- Scorer evaluation service
- Dataset storage with versioning
- Experiment result store

### Phase 5: Advanced Platform (Weeks 17-20)
*Core value: full Cloudflare replacement*

**Build:**
1. Workers & deployments management (version, promote, rollback, gradual deploy)
2. Bindings management (KV, R2, D1, Queues)
3. Billing & usage dashboards (deeper integration with token system)
4. Team management & RBAC
5. Security center (rate limits, access tokens, CORS, auth)
6. Webhooks system
7. Integrations (Slack, GitHub, Sentry, OTLP export)

**New backend needed:**
- Cloudflare API integration layer
- Team/RBAC system
- Webhook delivery system

---

## Appendix A: How Mastra Features Map to Our Plan

| Mastra Feature | Our Equivalent | Phase |
|----------------|----------------|-------|
| Studio (local dev UI) | Environment: Local mode in Console | P1 |
| Agent Editor (CMS) | Agent Detail → Configuration tab | P2 |
| Agent Versioning | Configuration → Version History | P2 |
| Workflow Visualization | Future: Workflow builder (beyond P5) | — |
| Human-in-the-Loop | Agent behavior: approval workflows | P2 |
| Scheduling | Schedules & Crons (global + per-agent) | P1 |
| Tool Registry | Tools & MCP management | P2 |
| MCP Server Creation | MCP server management | P2 |
| Memory / RAG | Configuration → Memory & Knowledge | P2 |
| Observability / Traces | Traces view | P3 |
| Datasets | Datasets management | P4 |
| Scorers | Automated evaluation | P4 |
| Experiments | Experiment runner + A/B | P4 |
| Multi-agent Handoffs | Agent config: handoff targets | P2 |
| Channels (Slack, Discord) | Integrations section | P5 |
| Voice Agents | Future roadmap | — |
| OpenTelemetry Export | Integrations → OTLP endpoint | P5 |

## Appendix B: How Cloudflare Dashboard Features Map

| Cloudflare Feature | Our Equivalent | Phase |
|--------------------|----------------|-------|
| Worker versioning | Workers & Deployments | P5 |
| Gradual deployments | Deployments → traffic splitter | P5 |
| Environment variables | Configuration → Secrets & Env | P2 |
| Secrets Store | Configuration → Secrets Store | P2 |
| Cron triggers | Schedules & Crons | P1 |
| Durable Objects state | Agent → Storage tab (BETTER than CF) | P1 |
| Workers Logs | Observability → Logs | P3 |
| Workers analytics | Observability → Metrics | P3 |
| Traces (OTel) | Observability → Traces | P3 |
| KV management | Configuration → Bindings → KV | P5 |
| R2 management | Configuration → Bindings → R2 | P5 |
| D1 management | Configuration → Bindings → D1 | P5 |
| Queues | Configuration → Bindings → Queues | P5 |
| Custom domains | Workers → Settings | P5 |
| Rate limiting | Security & Access | P5 |
| Zero Trust / Access | Security & Access | P5 |

## Appendix C: Unique Advantages Over Both Competitors

1. **DO State Inspector** — Neither Cloudflare nor Mastra provides a UI for inspecting/editing live Durable Object state. We do.
2. **Runtime Config Changes** — Change model, prompt, temperature without redeploying. Mastra does this for code-defined agents, but we do it for deployed Cloudflare agents.
3. **Agent-Aware Everything** — Cloudflare's dashboard is agent-unaware (it sees Workers, not agents). Our console knows each agent's type, tools, prompt, model, state schema.
4. **Integrated Billing** — We control the LLM gateway, so we have real-time cost data per agent, per model, per user. Cloudflare can only see Worker execution cost, not LLM cost.
5. **Cron + Schedule Unification** — Cloudflare shows cron triggers. Agents SDK has `schedule()`/`scheduleEvery()`. We unify both in one view.
6. **Tool Call Inspector** — See exactly which tools were called, with what arguments, what they returned, and how long they took — inline in the chat view.
7. **Prompt Hot-Swap** — Edit a system prompt in the console and it takes effect on the next message. No redeploy. No restart.
8. **MCP + Native Tools Unified** — Tools from code and tools from MCP servers in one management interface with the same testing/enable/disable workflow.
