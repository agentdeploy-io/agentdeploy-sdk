# Deployment Guide — One-Click Deploy

## Overview

When a buyer purchases agent templates on agentdeploy.io, the marketplace
automation deploys an Edge Console instance for them. This guide documents
the two deployment paths:

1. **Marketplace-Managed** (automatic) — The marketplace runs the deploy
   script after purchase. The buyer doesn't touch any code.

2. **Self-Hosted** (manual) — The buyer clones this repo and deploys
   themselves. Useful for enterprise or custom setups.

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│  Cloudflare Pages                                    │
│                                                       │
│  ┌─────────────┐    ┌───────────────────────────┐   │
│  │  SPA Assets  │    │  Pages Function (_worker)  │   │
│  │  (dist/)     │    │  • /agents/* → backend     │   │
│  │              │    │  • /health/* → backend     │   │
│  │  index.html  │    │  • /api/edge/* → marketplace│  │
│  │  assets/     │    │  • /* → SPA fallback       │   │
│  └─────────────┘    └──────────┬────────────────┘   │
└─────────────────────────────────┼───────────────────┘
                                  │
                   ┌──────────────┼──────────────┐
                   │              │              │
                   ▼              ▼              ▼
          ┌────────────┐  ┌────────────┐  ┌────────────┐
          │  Agent     │  │ Marketplace│  │  Deploy    │
          │  Worker    │  │ API        │  │  Service   │
          │            │  │            │  │            │
          │ Durable    │  │ Better Auth│  │ Deployments│
          │ Objects    │  │ Sessions   │  │ Templates  │
          └────────────┘  └────────────┘  └────────────┘
```

---

## Marketplace-Managed Deploy (Automatic)

This is the default flow. After a buyer completes checkout:

### Step 1: Marketplace provisions the agent Worker

The deployment-service creates a Cloudflare Worker for the buyer's
purchased templates. This Worker hosts the AIChatAgent Durable Objects.

### Step 2: Marketplace runs the deploy script

```bash
BUYER_HANDLE=acme \
BUYER_TIER=starter \
AGENT_BACKEND_URL=https://acme-agents.workers.dev \
CF_ACCOUNT_ID=<marketplace-cf-account> \
CF_API_TOKEN=<marketplace-cf-token> \
MARKETPLACE_URL=https://agentdeploy.io \
DEPLOYMENT_API_URL=https://api.agentdeploy.io \
node scripts/deploy.mjs
```

This:
1. Builds the SPA with marketplace env vars
2. Deploys to Cloudflare Pages as `{handle}-edge-console`
3. Sets `AGENT_BACKEND_URL` to the buyer's agent Worker
4. Returns the console URL

### Step 3: Buyer accesses their console

- **Sandbox/Starter:** `https://{handle}.agentdeploy.io` (auto-subdomain)
- **Pro/Business:** `https://{custom-domain}` (e.g., `agents.acme.com`)

The buyer signs in with their marketplace account. The console loads
their purchased agents automatically.

### Step 4: Custom domain binding (Pro/Business only)

For custom domains, the marketplace:
1. Creates a CNAME record: `{custom-domain}` → `{project}.pages.dev`
2. Adds the custom domain in Cloudflare Pages dashboard
3. Provisions an SSL certificate (automatic with Cloudflare)

---

## Self-Hosted Deploy (Manual)

### Prerequisites

- Node.js 20+
- A Cloudflare account
- `wrangler` CLI installed (`npm install -g wrangler`)
- The buyer's agent Worker URL (from the marketplace)

### Step 1: Clone and configure

```bash
git clone https://github.com/agentdeploy/edge-console.git
cd edge-console/packages/edge-ui-playground

cp .env.example .env.production
```

Edit `.env.production`:
```bash
VITE_AUTH_DISABLED=false
VITE_MARKETPLACE_URL=https://agentdeploy.io
VITE_DEPLOYMENT_API_URL=https://api.agentdeploy.io
```

### Step 2: Build

```bash
npm install
npm run build
```

### Step 3: Deploy to Cloudflare Pages

```bash
# Login to Cloudflare (one-time)
npx wrangler login

# Deploy
npm run deploy:pages
```

Or use the full deploy script:
```bash
BUYER_HANDLE=mycompany \
BUYER_TIER=pro \
AGENT_BACKEND_URL=https://my-agents.workers.dev \
CF_ACCOUNT_ID=your-account-id \
npm run deploy
```

### Step 4: Configure the agent backend URL

Set the `AGENT_BACKEND_URL` environment variable in the Cloudflare dashboard:

1. Go to **Cloudflare Dashboard → Workers & Pages**
2. Click your `{handle}-edge-console` project
3. Go to **Settings → Environment Variables**
4. Add:
   - `AGENT_BACKEND_URL` = `https://your-agents.workers.dev`
   - `MARKETPLACE_URL` = `https://agentdeploy.io`
   - `DEPLOYMENT_API_URL` = `https://api.agentdeploy.io`

### Step 5: Add custom domain (optional)

1. In the Pages project, go to **Custom domains**
2. Click **Set up a custom domain**
3. Enter your domain (e.g., `agents.yourcompany.com`)
4. Cloudflare will configure DNS and SSL automatically

---

## Environment Variables

| Variable | Where | Required | Description |
|----------|-------|----------|-------------|
| `VITE_MARKETPLACE_URL` | `.env.production` | Yes | Marketplace URL for auth redirects |
| `VITE_DEPLOYMENT_API_URL` | `.env.production` | Yes | Deployment API for loading purchased agents |
| `VITE_AUTH_DISABLED` | `.env.production` | No | Override auth (leave unset for production) |
| `AGENT_BACKEND_URL` | Pages dashboard | Yes | Buyer's agent Worker URL |
| `MARKETPLACE_URL` | Pages dashboard | Yes | Marketplace URL (server-side) |
| `DEPLOYMENT_API_URL` | Pages dashboard | Yes | Deployment API URL (server-side) |
| `CF_ACCOUNT_ID` | Deploy script env | Yes | Cloudflare account ID |
| `CF_API_TOKEN` | Deploy script env | Yes | Cloudflare API token |
| `BUYER_HANDLE` | Deploy script env | Yes | Buyer's unique handle |
| `BUYER_TIER` | Deploy script env | No | Buyer's tier (sandbox/starter/pro/business) |
| `BUYER_CUSTOM_DOMAIN` | Deploy script env | No | Custom domain (Pro/Business only) |

---

## Testing the Deploy

### Dry run (no changes made)

```bash
BUYER_HANDLE=test \
AGENT_BACKEND_URL=https://test.workers.dev \
CF_ACCOUNT_ID=test \
CF_API_TOKEN=test \
npm run deploy:dry-run
```

### Local production preview

Test the built SPA with the Pages Worker locally:

```bash
npm run preview:prod
```

This builds the SPA and runs it through `wrangler pages dev`, which
processes the `_worker.js` function. You'll need to set
`AGENT_BACKEND_URL` in your env to point to a local agent:

```bash
AGENT_BACKEND_URL=http://localhost:8789 npm run preview:prod
```

---

## Updating a Deployment

When the buyer purchases new templates or the agent Worker is updated:

```bash
# Just re-run the deploy script with the new backend URL
BUYER_HANDLE=acme \
AGENT_BACKEND_URL=https://acme-agents-v2.workers.dev \
CF_ACCOUNT_ID=xxx \
CF_API_TOKEN=xxx \
npm run deploy
```

The console will automatically pick up new purchased templates on next
page load (they're fetched from the deployment-service API).

---

## Troubleshooting

### "AUTH_BACKEND_URL is not configured"
The `AGENT_BACKEND_URL` env var isn't set. Go to the Cloudflare Pages
dashboard → Settings → Environment Variables and add it.

### Agents don't connect
1. Check that `AGENT_BACKEND_URL` points to a valid agent Worker
2. Open browser DevTools → Network tab
3. Look for WebSocket connections to `/agents/*`
4. Check the console for auth errors

### Auth not working on custom domain
Custom domains use the token exchange flow. Ensure:
1. The marketplace `/api/edge/authorize` endpoint is live
2. The buyer is logged in to agentdeploy.io
3. The `MARKETPLACE_URL` env var is correct

### Blank page after deploy
The SPA fallback might not be configured. Ensure `_routes.json` is in
the `public/` directory (it gets copied to `dist/` on build).

---

## Files

| File | Purpose |
|------|---------|
| `scripts/deploy.mjs` | One-click deploy script (marketplace automation) |
| `public/_worker.js` | Cloudflare Pages Function (proxy + SPA fallback) |
| `public/_routes.json` | Pages routing config (which paths hit the Worker) |
| `wrangler.toml` | Cloudflare Pages build/deploy config |
| `.env.example` | Documented env vars for local dev and production |
| `AUTH.md` | Auth architecture documentation |
