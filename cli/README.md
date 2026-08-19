# @agentdeploy-io/cli

CLI for building and deploying edge AI agents on [AgentDeploy](https://agentdeploy.io).

## Install

```bash
npm install -g @agentdeploy-io/cli
```

Or use via npx without installing:

```bash
npx @agentdeploy-io/cli <command>
```

## Quick Start

```bash
# 1. Create a new agent project
ad init --template chat-agent my-agent

# 2. Navigate and install
cd my-agent
npm install

# 3. Login to AgentDeploy
ad login --api-key ad_live_xxxxx

# 4. Run locally
ad dev

# 5. Deploy to the edge
ad deploy
```

## Commands

### `ad init`

Create a new agent project from a template.

```bash
ad init --template <template> <name>
```

**Templates:**
| Template | Description |
|---|---|
| `chat-agent` | Chat agent with streaming, tool calling, and AIChatAgent (default) |
| `scheduled-agent` | Scheduled agent with cron tasks, SQLite storage, HTTP endpoints |
| `blank` | Minimal starter with just the basics |

### `ad login`

Authenticate with your AgentDeploy account.

```bash
ad login --api-key <key>
# or interactive:
ad login
```

Your API key is saved to `~/.agentdeploy/credentials`. You can also set the
`AGENTDEPLOY_API_KEY` environment variable instead.

### `ad logout`

Remove saved credentials.

```bash
ad logout
```

### `ad dev`

Run the agent locally using Wrangler.

```bash
ad dev [--port 8787] [--remote]
```

This wraps `wrangler dev` with your project's `wrangler.jsonc` configuration.
Use `--remote` to run against Cloudflare's edge.

### `ad deploy`

Bundle and deploy your agent to the AgentDeploy platform.

```bash
ad deploy [options]
```

**Options:**
- `--version <semver>` — Specify a version string (default: auto-generated)
- `--dry-run` — Bundle only, don't upload
- `--skip-validation` — Skip the validation step
- `--verbose` — Print detailed output

**What it does:**
1. Bundles your TypeScript project into a single ESM module using esbuild
2. Uploads the bundle to AgentDeploy as a new template version
3. Validates the script for security and compatibility
4. Publishes the version
5. Provisions or reprovisions your deployment

### `ad secrets`

Manage deployment secrets.

```bash
# Set a secret
ad secrets set STRIPE_API_KEY
ad secrets set STRIPE_API_KEY "sk_live_xxx"

# List configured secrets
ad secrets list

# Show required secrets
ad secrets required
```

Secrets are stored securely via Cloudflare Workers Secrets API and encrypted
at rest in the AgentDeploy platform.

### `ad generate`

Scaffold new files in your project.

```bash
# Generate a new tool
ad generate tool check-inventory
# Creates: src/tools.check_inventory.ts

# Generate a new agent (for multi-agent projects)
ad generate agent billing
# Creates: src/agents.billing.ts
```

### `ad logs`

View deployment logs and status.

```bash
# One-shot status check
ad logs

# Follow live logs via wrangler tail
ad logs --follow
```

## Project Structure

```
my-agent/
├── .agentdeploy/
│   └── config.json       # AgentDeploy project config
├── src/
│   ├── server.ts          # Agent entry point
│   └── tools.ts           # Tool definitions (optional)
├── package.json
├── tsconfig.json
├── wrangler.jsonc         # Wrangler config (for local dev)
└── .gitignore
```

### `.agentdeploy/config.json`

```json
{
  "projectId": "my-agent",
  "name": "my-agent",
  "template": "chat-agent",
  "entrypoint": "src/server.ts",
  "model": "openai/gpt-4o-mini",
  "secrets": [
    {
      "key": "STRIPE_API_KEY",
      "required": false,
      "description": "Stripe API key for payment tools"
    }
  ]
}
```

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `AGENTDEPLOY_API_KEY` | Override login credentials | (from `ad login`) |
| `AGENTDEPLOY_API_URL` | Override API URL | `https://api.agentdeploy.io` |

## License

MIT
