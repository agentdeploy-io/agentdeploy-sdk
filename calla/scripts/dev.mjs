#!/usr/bin/env node

/**
 * Calla — one-command local dev
 * ──────────────────────────────
 * Starts the full stack locally:
 *
 *   edge   wrangler dev          → http://127.0.0.1:8787  (DOs, /events WS, workflow)
 *   brain  tsx watch server.ts   → http://127.0.0.1:3000  (Mastra; optional)
 *   ui     vite                   → http://localhost:5173  (proxies to both)
 *
 * Usage:
 *   npm run dev                # all three
 *   npm run dev -- --no-brain  # edge + ui only
 *   npm run dev -- --brain-only
 *   npm run dev -- --with-engine   # + real bi-edge engine on :8792; the UI's
 *                                  # /d/* data plane proxies to it instead of
 *                                  # the calla-edge dev stubs (see README
 *                                  # "Testing against the real engine")
 *
 * Env (all optional):
 *   ANTHROPIC_API_KEY  enables real LLM calls in the brain
 *   CALLA_EDGE_PORT / CALLA_BRAIN_PORT / CALLA_UI_PORT override ports
 *   CALLA_DATA_PORT    bi-edge engine port (default 8792, --with-engine)
 */

import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const args = process.argv.slice(2);
const NO_BRAIN = args.includes("--no-brain");
const BRAIN_ONLY = args.includes("--brain-only");
const WITH_ENGINE = args.includes("--with-engine");

const EDGE_PORT = Number(process.env.CALLA_EDGE_PORT ?? 8787);
const BRAIN_PORT = Number(process.env.CALLA_BRAIN_PORT ?? 3001);
const UI_PORT = Number(process.env.CALLA_UI_PORT ?? 5174);
const ENGINE_PORT = Number(process.env.CALLA_DATA_PORT ?? 8792);

// Real lead-gen engine (packages/bi-edge), sibling of packages/calla.
const ENGINE_DIR = resolve(ROOT, "..", "bi-edge");
const ENGINE_ENTRY = resolve(ROOT, "scripts", "bi-edge-dev-entry.ts");
const ENGINE_STATE_DIR = "/tmp/calla-bi-edge-state";
// Prefer calla's local wrangler; fall back to npx (downloads on demand).
const LOCAL_WRANGLER = resolve(ROOT, "node_modules", ".bin", "wrangler");

const COLORS = {
  edge: "\x1b[33m",
  engine: "\x1b[31m",
  brain: "\x1b[35m",
  ui: "\x1b[36m",
  dev: "\x1b[90m",
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

function devLog(msg) {
  console.log(`${COLORS.dev}[dev]${COLORS.reset} ${msg}`);
}

// ── Build shared first (fast; everything imports @calla/shared) ──
if (!BRAIN_ONLY || !existsSync(resolve(ROOT, "shared/dist/index.js"))) {
  devLog("building @calla/shared...");
  execSync("npm run build -w @calla/shared", { cwd: ROOT, stdio: "inherit" });
}

// ── Preflight: fail fast with a clear message when ports are already taken ──
import { createConnection } from "node:net";

function portInUse(port) {
  return new Promise((resolve) => {
    const sock = createConnection({ port, host: "127.0.0.1" });
    sock.once("connect", () => { sock.destroy(); resolve(true); });
    sock.once("error", () => { sock.destroy(); resolve(false); });
    setTimeout(() => { sock.destroy(); resolve(false); }, 800);
  });
}

const plannedPorts = [
  ...(BRAIN_ONLY ? [] : [{ name: "edge", port: EDGE_PORT, env: "CALLA_EDGE_PORT" }]),
  ...(NO_BRAIN ? [] : [{ name: "brain", port: BRAIN_PORT, env: "CALLA_BRAIN_PORT" }]),
  ...(BRAIN_ONLY ? [] : [{ name: "ui", port: UI_PORT, env: "CALLA_UI_PORT" }]),
  ...(WITH_ENGINE && !BRAIN_ONLY ? [{ name: "engine", port: ENGINE_PORT, env: "CALLA_DATA_PORT" }] : []),
];
for (const p of plannedPorts) {
  if (await portInUse(p.port)) {
    devLog(`${COLORS.red}port ${p.port} (${p.name}) is already in use — another Calla stack running?${COLORS.reset}`);
    devLog(`  stop it (pkill -f "scripts/dev.mjs") or pick another port: ${p.env}=<port> npm run dev`);
    process.exit(1);
  }
}

// ── Brain LLM config ─────────────────────────────────────────────
// The brain needs an OpenAI-compatible gateway. Reuse the engine's Chutes
// credentials from bi-edge/.dev.vars (AD_GATEWAY_*) so there is a single
// source of truth for local keys. Shell-provided LLM_* always win.
function brainLlmEnv() {
  const out = {};
  try {
    const vars = {};
    for (const line of readFileSync(resolve(ENGINE_DIR, ".dev.vars"), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (m && m[1]) vars[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
    if (vars.AD_GATEWAY_BASE_URL) {
      let base = vars.AD_GATEWAY_BASE_URL.replace(/\/+$/, "");
      if (!/\/v\d+$/.test(base)) base += "/v1";
      out.LLM_BASE_URL = base;
    }
    if (vars.AD_GATEWAY_API_KEY) out.LLM_API_KEY = vars.AD_GATEWAY_API_KEY;
    if (vars.AD_MODEL) out.LLM_MODEL = vars.AD_MODEL;
  } catch {
    /* no .dev.vars — brain boots unconfigured, LLM calls fail with a hint */
  }
  for (const k of ["LLM_BASE_URL", "LLM_API_KEY", "LLM_MODEL"]) {
    if (process.env[k]) out[k] = process.env[k];
  }
  return out;
}

// ── Service definitions ──────────────────────────────────────────
const services = [];

if (!BRAIN_ONLY) {
  services.push({
    name: "edge",
    cwd: resolve(ROOT, "apps/edge"),
    cmd: "npx",
    args: ["wrangler", "dev", "--port", String(EDGE_PORT), "--ip", "127.0.0.1"],
    readyUrl: `http://127.0.0.1:${EDGE_PORT}/health`,
    required: true,
  });
}

if (WITH_ENGINE && !BRAIN_ONLY) {
  if (!existsSync(ENGINE_DIR)) {
    devLog(`${COLORS.red}--with-engine: engine not found at ${ENGINE_DIR} — skipping${COLORS.reset}`);
  } else {
    const wranglerArgs = [
      "dev",
      ENGINE_ENTRY,
      "--config",
      "wrangler.toml",
      "--port",
      String(ENGINE_PORT),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      ENGINE_STATE_DIR,
    ];
    services.push({
      name: "engine",
      cwd: ENGINE_DIR,
      cmd: existsSync(LOCAL_WRANGLER) ? LOCAL_WRANGLER : "npx",
      args: existsSync(LOCAL_WRANGLER) ? wranglerArgs : ["--yes", "wrangler", ...wranglerArgs],
      readyUrl: `http://127.0.0.1:${ENGINE_PORT}/health`,
      required: true,
    });
  }
}

if (!NO_BRAIN) {
  services.push({
    name: "brain",
    cwd: resolve(ROOT, "apps/brain"),
    cmd: "npx",
    args: ["tsx", "watch", "src/server.ts"],
    env: { PORT: String(BRAIN_PORT), ...brainLlmEnv() },
    readyUrl: `http://127.0.0.1:${BRAIN_PORT}/health`,
    required: false, // UI degrades gracefully when the brain is down
  });
}

if (!BRAIN_ONLY) {
  services.push({
    name: "ui",
    cwd: resolve(ROOT, "apps/ui"),
    cmd: "npx",
    // vite.config proxies /agents,/events,/d,/health → edge and /brain → brain.
    // CALLA_DATA_PORT re-points /d/* at the real bi-edge engine (see vite.config.ts).
    args: ["vite", "--port", String(UI_PORT), "--strictPort"],
    env: WITH_ENGINE ? { CALLA_DATA_PORT: String(ENGINE_PORT) } : {},
    readyUrl: `http://localhost:${UI_PORT}/`,
    required: true,
  });
}

// ── Spawn ────────────────────────────────────────────────────────
const children = [];
let shuttingDown = false;

function prefixLines(name, stream, out) {
  let buf = "";
  stream.on("data", (chunk) => {
    buf += chunk.toString();
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim()) out.write(`${COLORS[name]}[${name}]${COLORS.reset} ${line}\n`);
    }
  });
}

function startService(svc) {
  devLog(`starting ${svc.name}: ${svc.cmd} ${svc.args.join(" ")} (cwd ${svc.cwd})`);
  const child = spawn(svc.cmd, svc.args, {
    cwd: svc.cwd,
    env: { ...process.env, ...(svc.env ?? {}) },
    detached: true, // own process group → clean kill of wrangler/workerd children
    stdio: ["ignore", "pipe", "pipe"],
  });
  prefixLines(svc.name, child.stdout, process.stdout);
  prefixLines(svc.name, child.stderr, process.stderr);
  child.on("exit", (code) => {
    if (shuttingDown) return;
    if (svc.required) {
      devLog(`${COLORS.red}${svc.name} exited (code ${code}) — shutting down${COLORS.reset}`);
      shutdown(1);
    } else {
      devLog(`${COLORS.red}${svc.name} exited (code ${code}) — continuing without it${COLORS.reset}`);
    }
  });
  children.push(child);
  svc.child = child;
}

function shutdown(code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
    }
  }
  setTimeout(() => process.exit(code), 400);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

// ── Readiness poll ───────────────────────────────────────────────
async function waitFor(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.ok || res.status === 404) return true;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 750));
  }
  return false;
}

// ── Staged startup: backends first, UI last (no proxy ECONNREFUSED noise) ──
const uiSvc = services.find((s) => s.name === "ui");
const backendSvcs = services.filter((s) => s.name !== "ui");
const edgeSvc = backendSvcs.find((s) => s.name === "edge");
const engineSvc = backendSvcs.find((s) => s.name === "engine");

for (const svc of backendSvcs) startService(svc);

const results = [];
if (edgeSvc) {
  results.push({ name: "edge", ok: await waitFor(edgeSvc.readyUrl, 90_000) });
}
if (engineSvc) {
  // wrangler cold build of bi-edge can take a while on first run
  results.push({ name: "engine", ok: await waitFor(engineSvc.readyUrl, 120_000) });
}
if (uiSvc) {
  startService(uiSvc);
}
const pending = [
  ...backendSvcs
    .filter((s) => s !== edgeSvc && s !== engineSvc)
    .map(async (svc) => ({ name: svc.name, ok: await waitFor(svc.readyUrl, 45_000) })),
  ...(uiSvc ? [waitFor(uiSvc.readyUrl, 45_000).then((ok) => ({ name: "ui", ok }))] : []),
];
results.push(...(await Promise.all(pending)));

console.log("");
for (const r of results) {
  const mark = r.ok ? `${COLORS.green}✓${COLORS.reset}` : `${COLORS.red}✗${COLORS.reset}`;
  devLog(`${mark} ${r.name}`);
}
console.log(`
${COLORS.green}╔══════════════════════════════════════════════════════════╗
║  Calla dev stack                                          ║
╠══════════════════════════════════════════════════════════╣
║  UI      http://localhost:${String(UI_PORT).padEnd(31)}║
║  Edge    http://127.0.0.1:${String(EDGE_PORT).padEnd(31)}║
║  Brain   http://127.0.0.1:${String(BRAIN_PORT).padEnd(31)}║${
  engineSvc
    ? `\n║  Engine  http://127.0.0.1:${String(ENGINE_PORT).padEnd(31)}║`
    : ""
}
╚══════════════════════════════════════════════════════════╝${COLORS.reset}

   Demo the HITL gate:
     curl -sX POST localhost:${EDGE_PORT}/steps/demo-1 -H 'content-type: application/json' \\
       -d '{"id":"s1","action":"send-email","params":{"to":"client@example.com"},"risk":"high","requiresApproval":true}'
     → open http://localhost:${UI_PORT}/inbox  (approval appears live over /events)
${
  engineSvc
    ? `
   Real-engine HITL loop (bi-edge on :${ENGINE_PORT}, UI /d/* proxies to it):
     node scripts/seed-engine.mjs            # 3 leads at pending_review
     → open http://localhost:${UI_PORT}/ (data/leads views read the REAL engine)
     → approve → POST /d/supervisor/cmd/supervisor {"message":"/send <key>"}
       (dry-run by default: sendEnabled=false, dryRun=true — no real email)
`
    : ""
}
   Ctrl+C stops everything.
`);
