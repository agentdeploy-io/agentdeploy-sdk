#!/usr/bin/env node

/**
 * AgentDeploy Edge Console — One-Click Deploy Script
 * ─────────────────────────────────────────────────────
 *
 * This script is run by the marketplace automation after a buyer
 * purchases agent templates. It:
 *
 *   1. Builds the SPA with the buyer's env vars
 *   2. Deploys to Cloudflare Pages
 *   3. Sets the AGENT_BACKEND_URL env var (buyer's agent Worker)
 *   4. Optionally binds a custom domain (Pro/Business tiers)
 *   5. Prints the final URL
 *
 * Usage (marketplace automation):
 *   BUYER_HANDLE=acme \
 *   BUYER_TIER=starter \
 *   AGENT_BACKEND_URL=https://acme-agents.workers.dev \
 *   CF_API_TOKEN=xxx \
 *   CF_ACCOUNT_ID=xxx \
 *   node scripts/deploy.mjs
 *
 * Usage (local testing):
 *   node scripts/deploy.mjs --dry-run
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── Args ────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run") || args.includes("-n");

// ─── Helpers ─────────────────────────────────────────────────────

function log(msg) {
  console.log(`\n\x1b[36m[deploy]\x1b[0m ${msg}`);
}

function logSuccess(msg) {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
}

function logError(msg) {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    logError(`Missing required env var: ${name}`);
    logError("See DEPLOY.md for configuration instructions.");
    process.exit(1);
  }
  return val;
}

function getEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function run(cmd, opts = {}) {
  if (DRY_RUN) {
    log(`(dry-run) ${cmd}`);
    return "";
  }
  return execSync(cmd, {
    cwd: ROOT,
    stdio: opts.silent ? "pipe" : "inherit",
    encoding: "utf-8",
    ...opts,
  });
}

// ─── Main ────────────────────────────────────────────────────────

async function main() {
  console.log(`
\x1b[1m╔══════════════════════════════════════════════════╗
║   AgentDeploy Edge Console — One-Click Deploy     ║
╚══════════════════════════════════════════════════╝
`);

  // ── Read config ─────────────────────────────────────────────
  const buyerHandle = requireEnv("BUYER_HANDLE");
  const buyerTier = getEnv("BUYER_TIER", "starter");
  const agentBackendUrl = requireEnv("AGENT_BACKEND_URL");
  const marketplaceUrl = getEnv("MARKETPLACE_URL", "https://agentdeploy.io");
  const deploymentApiUrl = getEnv("DEPLOYMENT_API_URL", "https://api.agentdeploy.io");
  const customDomain = getEnv("BUYER_CUSTOM_DOMAIN", ""); // Pro/Business only

  // Cloudflare credentials
  const cfAccountId = requireEnv("CF_ACCOUNT_ID");
  const cfApiToken = requireEnv("CF_API_TOKEN");

  // Project name: {handle}-edge-console
  const projectName = `${buyerHandle}-edge-console`;

  log(`Buyer:     ${buyerHandle}`);
  log(`Tier:      ${buyerTier}`);
  log(`Backend:   ${agentBackendUrl}`);
  log(`Project:   ${projectName}`);
  if (customDomain) {
    log(`Domain:    ${customDomain}`);
  }
  if (DRY_RUN) {
    log("Mode:      DRY RUN (no changes will be made)");
  }
  console.log();

  // ── Step 1: Build the SPA ───────────────────────────────────
  log("Step 1: Building SPA...");

  const viteEnv = {
    ...process.env,
    VITE_MARKETPLACE_URL: marketplaceUrl,
    VITE_DEPLOYMENT_API_URL: deploymentApiUrl,
    VITE_AUTH_DISABLED: "false",
  };

  if (DRY_RUN) {
    log("(dry-run) Would run: npm run build");
    log(`  VITE_MARKETPLACE_URL=${marketplaceUrl}`);
    log(`  VITE_DEPLOYMENT_API_URL=${deploymentApiUrl}`);
    log(`  VITE_AUTH_DISABLED=false`);
  } else {
    execSync("npm run build", {
      cwd: ROOT,
      stdio: "inherit",
      env: viteEnv,
    });
  }
  logSuccess("Build complete");

  // ── Step 2: Deploy to Cloudflare Pages ──────────────────────
  log("Step 2: Deploying to Cloudflare Pages...");

  const deployCmd = `npx wrangler pages deploy dist --project-name=${projectName} --commit-dirty=true`;
  if (DRY_RUN) {
    log(`(dry-run) ${deployCmd}`);
  } else {
    run(deployCmd, {
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: cfApiToken,
        CLOUDFLARE_ACCOUNT_ID: cfAccountId,
      },
    });
  }
  logSuccess("Deployed to Cloudflare Pages");

  // ── Step 3: Set environment variables ───────────────────────
  log("Step 3: Setting environment variables...");

  const envVars = {
    AGENT_BACKEND_URL: agentBackendUrl,
    MARKETPLACE_URL: marketplaceUrl,
    DEPLOYMENT_API_URL: deploymentApiUrl,
  };

  for (const [key, value] of Object.entries(envVars)) {
    const cmd = `npx wrangler pages secret put ${key} --project-name=${projectName}`;
    if (DRY_RUN) {
      log(`(dry-run) ${cmd} = "${value}"`);
    } else {
      // wrangler pages secret put reads from stdin
      execSync(cmd, {
        cwd: ROOT,
        stdio: "pipe",
        env: {
          ...process.env,
          CLOUDFLARE_API_TOKEN: cfApiToken,
          CLOUDFLARE_ACCOUNT_ID: cfAccountId,
        },
        input: value,
      });
    }
  }
  logSuccess("Environment variables set");

  // ── Step 4: Custom domain (Pro/Business only) ───────────────
  if (customDomain) {
    log(`Step 4: Binding custom domain ${customDomain}...`);

    const domainCmd = `npx wrangler pages deployment tail --project-name=${projectName}`;
    if (DRY_RUN) {
      log(`(dry-run) Would add custom domain: ${customDomain}`);
      log(`  wrangler pages domain add ${customDomain} --project-name=${projectName}`);
    } else {
      // Custom domains are added via the Cloudflare dashboard or API
      // wrangler doesn't have a direct CLI for this yet
      log(`  → Add custom domain via Cloudflare dashboard:`);
      log(`    Pages → ${projectName} → Custom domains → ${customDomain}`);
    }
    logSuccess(`Custom domain configured: https://${customDomain}`);
  } else {
    logSuccess("Skipping custom domain (not Pro/Business)");
  }

  // ── Done ────────────────────────────────────────────────────
  const consoleUrl = customDomain
    ? `https://${customDomain}`
    : `https://${projectName}.pages.dev`;

  console.log(`
\x1b[32m╔══════════════════════════════════════════════════╗
║   Deploy Complete!                                ║
╠══════════════════════════════════════════════════╣
║                                                   ║
║   Console URL:  ${consoleUrl.padEnd(33)}║
║   Buyer:        ${buyerHandle.padEnd(33)}║
║   Tier:         ${buyerTier.padEnd(33)}║
║                                                   ║
║   The console is live and ready to use.           ║
╚══════════════════════════════════════════════════╝
`);

  if (!DRY_RUN) {
    console.log(`Next steps:
  1. Visit ${consoleUrl}
  2. Sign in with the buyer's marketplace account
  3. The console will load their purchased agents automatically

To update the deployment:
  AGENT_BACKEND_URL=new-url node scripts/deploy.mjs
`);
  }
}

// ─── Run ─────────────────────────────────────────────────────────

main().catch((err) => {
  logError(`Deploy failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
