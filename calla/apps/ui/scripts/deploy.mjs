#!/usr/bin/env node

/**
 * Calla Console — One-Click Deploy Script
 * ────────────────────────────────────────
 *
 * Run by the marketplace automation after a buyer purchases Calla. It:
 *
 *   1. Builds the SPA with the buyer's env vars
 *   2. Deploys to Cloudflare Pages ({handle}-calla-console)
 *   3. Sets runtime secrets (AGENT_BACKEND_URL, BRAIN_URL, ...)
 *   4. Prints the final URL
 *
 * Per-deployment modules (vertical specialization):
 *   ENABLED_MODULES=data,inbox,conversations,…  explicit module id list
 *   MODULE_PRESET=dental|retrofit|property      resolves via @calla/shared
 * When set, the key is injected into dist/runtime-config.js as the
 * build-time module set (the brain's /config/modules row still wins at
 * runtime when reachable).
 *
 * Usage (marketplace automation):
 *   BUYER_HANDLE=acme \
 *   AGENT_BACKEND_URL=https://acme-calla-edge.workers.dev \
 *   BRAIN_URL=https://calla-brain.fly.dev \
 *   MODULE_PRESET=dental \
 *   CF_API_TOKEN=xxx \
 *   CF_ACCOUNT_ID=xxx \
 *   node scripts/deploy.mjs
 *
 * Usage (local testing):
 *   node scripts/deploy.mjs --dry-run
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run") || args.includes("-n");

function log(msg) {
  console.log(`\n\x1b[36m[deploy]\x1b[0m ${msg}`);
}
function logSuccess(msg) {
  console.log(`\x1b[32m  ✓\x1b[0m ${msg}`);
}
function logError(msg) {
  console.error(`\x1b[31m  ✗\x1b[0m ${msg}`);
}
function logWarn(msg) {
  console.log(`\x1b[33m  ⚠\x1b[0m ${msg}`);
}

function requireEnv(name) {
  const val = process.env[name];
  if (!val) {
    logError(`Missing required env var: ${name}`);
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

// ── Per-deployment modules (ENABLED_MODULES / MODULE_PRESET) ─────────────

/**
 * Resolve the build-time module set from env. Returns:
 *   - string[]  → inject into runtime-config.js
 *   - null      → no override (all modules enabled / brain decides)
 * Reads the preset lists from the freshly-built @calla/shared so the deploy
 * script and the runtime can never disagree on what a preset means.
 */
async function resolveModuleOverride() {
  const explicit = (process.env.ENABLED_MODULES || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const preset = (process.env.MODULE_PRESET || "").trim();
  if (!preset) return null;

  const shared = await import(pathToFileURL(resolve(ROOT, "../../shared/dist/index.js")).href);
  const def = shared.MODULE_PRESETS?.[preset];
  if (!def) {
    logError(
      `Unknown MODULE_PRESET "${preset}" (known: ${Object.keys(shared.MODULE_PRESETS ?? {}).join(", ")})`,
    );
    process.exit(1);
  }
  return shared.resolveModuleSet([...def.modules]);
}

/** Inject ENABLED_MODULES into the built runtime-config.js (idempotent). */
function injectModuleOverride(modules) {
  if (!modules || modules.length === 0) return;
  const file = resolve(ROOT, "dist/runtime-config.js");
  const line = `  ENABLED_MODULES: ${JSON.stringify(modules)},`;
  let src = readFileSync(file, "utf8");
  if (/^\s*ENABLED_MODULES:.*$/m.test(src)) {
    src = src.replace(/^\s*ENABLED_MODULES:.*$/m, line);
  } else {
    src = src.replace(
      /(window\.__CALLA_CONFIG__\s*=\s*\{)/,
      (m) => `${m}\n${line}`,
    );
  }
  writeFileSync(file, src);
  logSuccess(`Injected ENABLED_MODULES (${modules.length} modules) into runtime-config.js`);
}

async function main() {
  console.log(`
\x1b[1m╔══════════════════════════════════════════╗
║   Calla Console — One-Click Deploy        ║
╚══════════════════════════════════════════╝
`);

  const buyerHandle = requireEnv("BUYER_HANDLE");
  const agentBackendUrl = requireEnv("AGENT_BACKEND_URL");
  const brainUrl = getEnv("BRAIN_URL", "");
  const marketplaceUrl = getEnv("MARKETPLACE_URL", "https://agentdeploy.io");
  const deploymentApiUrl = getEnv("DEPLOYMENT_API_URL", "https://api.agentdeploy.io");
  const customDomain = getEnv("BUYER_CUSTOM_DOMAIN", "");

  const cfAccountId = requireEnv("CF_ACCOUNT_ID");
  const cfApiToken = requireEnv("CF_API_TOKEN");

  const projectName = `${buyerHandle}-calla-console`;

  log(`Buyer:     ${buyerHandle}`);
  log(`Edge:      ${agentBackendUrl}`);
  log(`Brain:     ${brainUrl || "(not configured)"}`);
  log(`Project:   ${projectName}`);
  if (customDomain) log(`Domain:    ${customDomain}`);
  if (DRY_RUN) log("Mode:      DRY RUN (no changes will be made)");
  console.log();

  // ── Step 1: Build shared + SPA ──────────────────────────────
  log("Step 1: Building SPA...");
  const viteEnv = {
    ...process.env,
    VITE_MARKETPLACE_URL: marketplaceUrl,
    VITE_DEPLOYMENT_API_URL: deploymentApiUrl,
    VITE_BRAIN_URL: brainUrl || "/brain",
    VITE_AUTH_DISABLED: "false",
  };
  if (DRY_RUN) {
    log("(dry-run) Would run: npm run build (from calla root, builds @calla/shared then @calla/ui)");
  } else {
    execSync("npm run build -w @calla/shared && npm run build -w @calla/ui", {
      cwd: resolve(ROOT, "../.."),
      stdio: "inherit",
      env: viteEnv,
    });
  }
  logSuccess("Build complete");

  // ── Step 1b: Inject per-deployment modules (if requested) ────
  if (DRY_RUN) {
    const preset = (process.env.MODULE_PRESET || "").trim();
    const explicit = (process.env.ENABLED_MODULES || "").trim();
    if (preset || explicit) {
      log("(dry-run) Would inject ENABLED_MODULES from " + (preset ? `MODULE_PRESET=${preset}` : "ENABLED_MODULES"));
    }
  } else {
    const moduleOverride = await resolveModuleOverride();
    if (moduleOverride) injectModuleOverride(moduleOverride);
  }

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

  // ── Step 3: Set runtime secrets ─────────────────────────────
  log("Step 3: Setting runtime secrets...");
  const envVars = {
    AGENT_BACKEND_URL: agentBackendUrl,
    MARKETPLACE_URL: marketplaceUrl,
    DEPLOYMENT_API_URL: deploymentApiUrl,
    ...(brainUrl ? { BRAIN_URL: brainUrl } : {}),
  };
  for (const [key, value] of Object.entries(envVars)) {
    const cmd = `npx wrangler pages secret put ${key} --project-name=${projectName}`;
    if (DRY_RUN) {
      log(`(dry-run) ${cmd} = "${value}"`);
    } else {
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
  logSuccess("Runtime secrets set");

  // ── Step 4: Custom domain ───────────────────────────────────
  if (customDomain) {
    logWarn(`Custom domain NOT configured by this script — manual step required:`);
    log(`  Cloudflare dashboard → Pages → ${projectName} → Custom domains → ${customDomain}`);
  }

  const consoleUrl = customDomain
    ? `https://${customDomain}`
    : `https://${projectName}.pages.dev`;

  console.log(`
\x1b[32m╔══════════════════════════════════════════╗
║   Deploy Complete!                        ║
╠══════════════════════════════════════════╣
║                                           ║
║   Console URL:  ${consoleUrl.padEnd(25)}║
║   Buyer:        ${buyerHandle.padEnd(25)}║
║                                           ║
╚══════════════════════════════════════════╝
`);
}

main().catch((err) => {
  logError(`Deploy failed: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
