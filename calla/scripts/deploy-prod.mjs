#!/usr/bin/env node
/**
 * Calla production deploy — one command, everything.
 *
 * Prereqs (human, once):
 *   npx wrangler login      # Cloudflare (browser OAuth)
 *   flyctl auth login       # Fly.io  (browser OAuth)
 *
 * Deploys (in order):
 *   1. bi-edge      → Cloudflare Workers (DO + DO SQLite — durable, no wipes)
 *   2. calla-edge   → Cloudflare Workers (HITL hub)
 *   3. UI           → Cloudflare Pages (standalone login)
 *   4. calla-brain  → Fly.io (volume-backed LibSQL store)
 *   5. calla-bi-core→ Fly.io (crawler + Gmail reply poller, volume-backed)
 *   6. cross-wires CORE_URL / BRAIN_URL / SYNC_URL once the URLs are known
 *
 * Secrets are read from (in order):
 *   packages/bi-edge/.dev.vars   — Brevo / LLM gateway / brand / BRAVE keys
 *   packages/bi-core/.env        — LLM / Brave / IMAP credentials
 *   packages/calla/.deploy.env   — generated INBOUND_WEBHOOK_SECRET,
 *                                  CALLA_JWT_SECRET, AD_SYNC_SECRET,
 *                                  CALLA_PAGES_PROJECT
 *
 * Usage: node scripts/deploy-prod.mjs [--dry-run] [--skip <cf|fly|ui>]
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CALLA_ROOT = resolve(__dirname, "..");
const PACKAGES_ROOT = resolve(CALLA_ROOT, "..");
const BI_EDGE = resolve(PACKAGES_ROOT, "bi-edge");
const BI_CORE = resolve(PACKAGES_ROOT, "bi-core");

const DRY = process.argv.includes("--dry-run");
const skip = (flag) => process.argv.includes(`--skip=${flag}`) || process.argv.includes(flag === "ui" ? "--skip-ui" : `--skip-${flag}`);

function log(msg) { console.log(`\n\x1b[36m[deploy]\x1b[0m ${msg}`); }
function ok(msg) { console.log(`\x1b[32m  ✓\x1b[0m ${msg}`); }
function fail(msg) { console.error(`\x1b[31m  ✗ ${msg}\x1b[0m`); process.exit(1); }
function sh(cmd, opts = {}) {
  if (DRY) { console.log(`  (dry-run) ${cmd}`); return ""; }
  return execSync(cmd, { stdio: opts.capture ? "pipe" : "inherit", encoding: "utf8", ...opts });
}
/** Like sh, but swallows failures (for idempotent create commands). */
function trysh(cmd, opts = {}) {
  if (DRY) { console.log(`  (dry-run, optional) ${cmd}`); return ""; }
  try {
    return execSync(cmd, { stdio: "pipe", encoding: "utf8", ...opts });
  } catch {
    return "";
  }
}

// ── env file parsing ────────────────────────────────────────────────────────
function parseEnvFile(path) {
  const out = {};
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i < 0) continue;
    out[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return out;
}

// ── preflight ───────────────────────────────────────────────────────────────
log("Preflight: auth checks");
const wranglerWhoami = sh("npx wrangler whoami --output json", { capture: true, cwd: CALLA_ROOT }) || "";
let cfAccount = "";
try {
  const w = JSON.parse(wranglerWhoami);
  cfAccount = w?.accounts?.[0]?.id ?? "";
  ok(`Cloudflare: logged in (account ${cfAccount?.slice(0, 8)}…)`);
} catch {
  fail("Not logged in to Cloudflare. Run: npx wrangler login   (interactive, one-time)");
}
const flyWhoami = sh("flyctl auth whoami --json", { capture: true }) || "";
let flyUser = "";
try {
  flyUser = JSON.parse(flyWhoami)?.user?.email ?? "";
  ok(`Fly.io: logged in (${flyUser})`);
} catch {
  fail("Not logged in to Fly.io. Run: flyctl auth login   (interactive, one-time)");
}

const biEdgeVars = parseEnvFile(resolve(BI_EDGE, ".dev.vars"));
const biCoreEnv = parseEnvFile(resolve(BI_CORE, ".env"));
const deployEnv = parseEnvFile(resolve(CALLA_ROOT, ".deploy.env"));
const WEBHOOK_SECRET = deployEnv.INBOUND_WEBHOOK_SECRET;
const JWT_SECRET = deployEnv.CALLA_JWT_SECRET;
const SYNC_SECRET = deployEnv.AD_SYNC_SECRET;
const PAGES_PROJECT = deployEnv.CALLA_PAGES_PROJECT || "gradient3-calla-console";
const BI_CORE_APP = "calla-bi-core";
const BRAIN_APP = "calla-brain";
const BI_CORE_URL = `https://${BI_CORE_APP}.fly.dev`;
const BRAIN_URL = `https://${BRAIN_APP}.fly.dev`;
if (!WEBHOOK_SECRET || !JWT_SECRET || !SYNC_SECRET) {
  fail(`Missing generated secrets in ${CALLA_ROOT}/.deploy.env — regenerate with openssl rand -hex 32`);
}
ok(`Secrets loaded (webhook/jwt/sync). Pages project: ${PAGES_PROJECT}`);

const urls = {};

// ── 1. bi-edge → Cloudflare Workers ─────────────────────────────────────────
if (!skip("cf")) {
  log("1/5 bi-edge → Cloudflare Workers (durable DO SQLite)");
  const out = sh(`npx wrangler deploy`, { cwd: BI_EDGE, capture: true });
  const m = out.match(/https:\/\/[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.workers\.dev/i);
  if (!m) fail(`bi-edge deploy did not report a URL. Output:\n${out.slice(-800)}`);
  urls.biEdge = m[0].replace(/\/$/, "");
  ok(`bi-edge live at ${urls.biEdge}`);

  // Secrets: everything from .dev.vars except local-only loopback values.
  const exclude = new Set(["AD_EDGE_CALLBACK_URL"]);
  const secrets = { ...biEdgeVars, INBOUND_WEBHOOK_SECRET: WEBHOOK_SECRET, AD_SYNC_SECRET: SYNC_SECRET };
  const list = Object.entries(secrets).filter(([k, v]) => v && !exclude.has(k));
  ok(`${list.length} secrets to set on bi-edge`);
  for (const [k, v] of list) {
    sh(`npx wrangler secret put ${k}`, { cwd: BI_EDGE, input: v, stdio: ["pipe", "inherit", "inherit"] });
  }
  ok("bi-edge secrets set");
}

// ── 2. calla-edge → Cloudflare Workers ──────────────────────────────────────
if (!skip("cf")) {
  log("2/5 calla-edge → Cloudflare Workers (HITL hub)");
  const out = sh(`npx wrangler deploy`, { cwd: resolve(CALLA_ROOT, "apps/edge"), capture: true });
  const m = out.match(/https:\/\/[a-z0-9][a-z0-9-]*\.[a-z0-9-]+\.workers\.dev/i);
  if (!m) fail(`calla-edge deploy did not report a URL. Output:\n${out.slice(-800)}`);
  urls.callaEdge = m[0].replace(/\/$/, "");
  ok(`calla-edge live at ${urls.callaEdge}`);
  sh(`npx wrangler secret put CALLA_JWT_SECRET`, { cwd: resolve(CALLA_ROOT, "apps/edge"), input: JWT_SECRET, stdio: ["pipe", "inherit", "inherit"] });
  sh(`npx wrangler secret put BRAIN_URL`, { cwd: resolve(CALLA_ROOT, "apps/edge"), input: BRAIN_URL, stdio: ["pipe", "inherit", "inherit"] });
  ok("calla-edge secrets set (CALLA_JWT_SECRET, BRAIN_URL)");
}

// ── 3. UI → Cloudflare Pages ────────────────────────────────────────────────
if (!skip("ui")) {
  log("3/5 UI → Cloudflare Pages (standalone login)");
  sh(`npm run build -w @calla/shared && npm run build -w @calla/ui`, {
    cwd: CALLA_ROOT,
    env: { ...process.env, VITE_AUTH_DISABLED: "false", VITE_MARKETPLACE_URL: "none", VITE_BRAIN_URL: BRAIN_URL },
  });
  // runtime-config.js → standalone auth + real brain URL
  const rcPath = resolve(CALLA_ROOT, "apps/ui/dist/runtime-config.js");
  let rc = readFileSync(rcPath, "utf8");
  rc = rc.replace(/MARKETPLACE_URL:\s*"[^"]*"/, `MARKETPLACE_URL: "none"`);
  rc = rc.replace(/BRAIN_URL:\s*"[^"]*"/, `BRAIN_URL: "${BRAIN_URL}"`);
  rc = rc.replace(/\/\/\s*AUTH_MODE:\s*"standalone"/, `AUTH_MODE: "standalone"`);
  if (!/^\s*AUTH_MODE:/m.test(rc)) rc = rc.replace(/(window\.__CALLA_CONFIG__\s*=\s*\{)/, `$1\n  AUTH_MODE: "standalone",`);
  writeFileSync(rcPath, rc);
  ok("built SPA with standalone auth + " + BRAIN_URL);

  trysh(`npx wrangler pages project create ${PAGES_PROJECT} --production-branch main`);
  sh(`npx wrangler pages deploy ${resolve(CALLA_ROOT, "apps/ui/dist")} --project-name=${PAGES_PROJECT} --commit-dirty=true`);
  urls.ui = `https://${PAGES_PROJECT}.pages.dev`;
  ok(`UI live at ${urls.ui}`);
}

// ── 4. brain → Fly.io ───────────────────────────────────────────────────────
if (!skip("fly")) {
  log("4/5 calla-brain → Fly.io");
  trysh(`flyctl apps create ${BRAIN_APP}`); // ok if exists
  trysh(`flyctl volumes create brain-data -r iad --app ${BRAIN_APP}`); // ok if exists
  sh(`flyctl secrets set CALLA_JWT_SECRET=${JWT_SECRET} CALLA_EDGE_URL=${urls.callaEdge || "https://TBD-calla-edge.workers.dev"} --app ${BRAIN_APP} -r iad`);
  sh(`flyctl deploy --app ${BRAIN_APP} -r iad`, { cwd: resolve(CALLA_ROOT, "apps/brain") });
  ok(`brain live at ${BRAIN_URL}`);
}

// ── 5. bi-core → Fly.io ─────────────────────────────────────────────────────
if (!skip("fly")) {
  log("5/5 calla-bi-core → Fly.io (crawler + Gmail reply poller)");
  trysh(`flyctl apps create ${BI_CORE_APP}`);
  trysh(`flyctl volumes create bi-core-data -r iad --app ${BI_CORE_APP}`);
  // Secrets: bi-core .env (minus local-only) + prod wiring.
  const localOnly = new Set(["PORT", "DATA_DIR", "EDGE_WEBHOOK_URL"]);
  const lines = Object.entries(biCoreEnv)
    .filter(([k, v]) => v && !localOnly.has(k))
    .map(([k, v]) => `${k}=${v}`)
    .concat([
      `EDGE_WEBHOOK_URL=${(urls.biEdge || "https://TBD-bi-edge.workers.dev")}/inbound-webhook`,
      `INBOX_WEBHOOK_SECRET=${WEBHOOK_SECRET}`,
      `SYNC_URL=${(urls.biEdge || "https://TBD-bi-edge.workers.dev")}/inbound/sync`,
      `SYNC_SECRET=${SYNC_SECRET}`,
      `DATA_DIR=/data`,
    ]);
  sh(`flyctl secrets set ${lines.join(" ")} --app ${BI_CORE_APP} -r iad`);
  sh(`flyctl deploy --app ${BI_CORE_APP} -r iad`, { cwd: BI_CORE });
  ok(`bi-core live at ${BI_CORE_URL}`);
}

// ── 6. cross-wire URLs that only existed after deploy ───────────────────────
if (urls.biEdge && !skip("cf")) {
  log("6/6 cross-wiring CORE_URL on bi-edge (engine → core)");
  sh(`npx wrangler secret put CORE_URL=${BI_CORE_URL}`, { cwd: BI_EDGE });
  ok("CORE_URL wired");
}

// ── summary ─────────────────────────────────────────────────────────────────
log("Deployed");
console.log(`
  ┌──────────────────────────────────────────────────────────────┐
  │ UI (login)      ${urls.ui || "(skipped)"}
  │ Engine (bi-edge) ${urls.biEdge || "(skipped)"}
  │ HITL hub        ${urls.callaEdge || "(skipped)"}
  │ Brain           ${BRAIN_URL}${skip("fly") ? " (skipped)" : ""}
  │ Core (crawler)  ${BI_CORE_URL}${skip("fly") ? " (skipped)" : ""}
  └──────────────────────────────────────────────────────────────┘

  REMAINING MANUAL STEPS:
  1. Open the UI → create the admin account (first and only time).
  2. Gmail relay: set INBOX_IMAP_PASSWORD on Fly:
       flyctl secrets set INBOX_IMAP_PASSWORD=<app-password> --app ${BI_CORE_APP}
     (Proton → Gmail forwarding rule must be in place first.)
  3. Smoke test:
       curl ${urls.biEdge || "https://bi-edge.workers.dev"}/health
       curl ${BRAIN_URL}/health
  4. Data: the prod engine starts with an EMPTY durable DB (your local
     leads were wiped Nov 18). Re-seed via a crawl run or POST /inbound/sync
     (X-AD-Sync: <AD_SYNC_SECRET from .deploy.env>).
`);
