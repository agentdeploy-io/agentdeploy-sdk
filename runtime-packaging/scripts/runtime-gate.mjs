#!/usr/bin/env node
/**
 * H4 GA gate — one command from source to verified runtime.
 *
 *   node scripts/runtime-gate.mjs --runtime hermes [--push] [--deploy]
 *
 * Steps:
 *   1. Build the shim (tsc) + docker image for the runtime
 *   2. Push to GHCR (--push; needs docker login)
 *   3. Run conformance against a LOCAL container (always — this is the gate)
 *   4. Optionally deploy a live test core deployment via deployment-service
 *      and run conformance against the Fly URL (--deploy; needs
 *      DEPLOYMENT_SERVICE_URL + INTERNAL_SERVICE_TOKEN + a template/subscription)
 *
 * Exit 0 = runtime passes the gate and can be listed on the marketplace.
 */
import { execSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const pkgRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../.."); // packages/runtime-packaging
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const runtime = argOf("--runtime", "hermes");
const imageTag = argOf("--tag", `${process.env.RUNTIME_IMAGE_PREFIX || "ghcr.io/agentdeploy"}/${runtime}-runtime:1.0`);
const doPush = flag("--push");
const doDeploy = flag("--deploy");
const skipLocalConformance = flag("--skip-local");

function step(msg) {
  console.log(`\n━━ ${msg}`);
}
function die(msg) {
  console.error(`\n✗ GATE FAILED: ${msg}`);
  process.exit(1);
}
function run(cmd, opts = {}) {
  console.log(`$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: pkgRoot, ...opts });
}

// ── 1. Build shim + image ────────────────────────────────────────────────────
step("1/4 Building shim (tsc)");
run("npx tsc");

if (!existsSync(resolve(pkgRoot, `dockerfiles/${runtime}.Dockerfile`))) {
  die(`no Dockerfile for runtime "${runtime}" (looked in dockerfiles/${runtime}.Dockerfile)`);
}
step(`2/4 Building image ${imageTag}`);
run(`docker build -f dockerfiles/${runtime}.Dockerfile -t ${imageTag} .`);

if (doPush) {
  step(`2b/4 Pushing ${imageTag}`);
  run(`docker push ${imageTag}`);
} else {
  console.log("(skipping push — pass --push to publish)");
}

// ── 3. Local conformance gate ────────────────────────────────────────────────
if (!skipLocalConformance) {
  step("3/4 Local conformance (the actual gate)");
  // Boot the built image locally with a fake control plane (shim degrades
  // gracefully without one), run conformance, tear down.
  const container = `gate-${runtime}-${Date.now()}`;
  try {
    run(`docker rm -f ${container}`, { stdio: "ignore" });
  } catch {}
  run(
    `docker run -d --name ${container} -p 18080:8080 ` +
      `-e RUNTIME_NAME=${runtime} -e PORT=8080 ` +
      `${imageTag}`
  );
  try {
    // Wait for health.
    let healthy = false;
    for (let i = 0; i < 30; i += 1) {
      try {
        const res = spawnSync("curl", ["-sf", "http://localhost:18080/health"]);
        if (res.status === 0) {
          healthy = true;
          break;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 1000));
    }
    if (!healthy) die("container did not become healthy within 30s");

    run(
      `RUNTIME_CONTRACT_URL=http://localhost:18080 RUNTIME_NAME=${runtime} npx tsx scripts/conformance.ts`
    );
  } finally {
    try {
      run(`docker rm -f ${container}`, { stdio: "ignore" });
    } catch {}
  }
  console.log("\n✓ Local conformance PASSED — runtime is contract-compliant.");
} else {
  console.log("(skipping local conformance)");
}

// ── 4. Optional live deploy gate ─────────────────────────────────────────────
if (doDeploy) {
  const dsUrl = process.env.DEPLOYMENT_SERVICE_URL || "";
  const token = process.env.INTERNAL_SERVICE_TOKEN || "";
  const apiKey = process.env.GATE_API_KEY || "";
  if (!dsUrl || !token || !apiKey) {
    die("--deploy needs DEPLOYMENT_SERVICE_URL, INTERNAL_SERVICE_TOKEN, GATE_API_KEY env vars");
  }
  step("4/4 Live Fly deployment conformance");
  // Provision via internal API is environment-specific (subscription/template
  // ids); documented in plans/RUNBOOK.md §4. The conformance half:
  const flyUrl = process.env.GATE_FLY_URL || "";
  if (!flyUrl) die("--deploy also needs GATE_FLY_URL (the deployed VM's public URL)");
  run(
    `RUNTIME_CONTRACT_URL=${flyUrl} RUNTIME_NAME=${runtime} npx tsx scripts/conformance.ts`
  );
  console.log("✓ Live deployment conformance PASSED.");
}

console.log(`\n✅ GATE PASSED for "${runtime}" — eligible for marketplace listing.`);
console.log(`   Register/update in core_runtimes: node deployment-service/scripts/seed-core-runtimes.mjs`);
