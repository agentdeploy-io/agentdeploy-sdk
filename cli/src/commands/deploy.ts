// ── ad deploy ────────────────────────────────────────────────────────────────
//
// Flow:
// 1. Load project config
// 2. Bundle with esbuild → single ESM module
// 3. Create edge version on platform (upload script)
// 4. Register detected agents in the agent registry
// 5. Validate
// 6. Publish
// 7. Provision (if first deploy) or reprovision (if updating)
// 8. Print the worker URL

import { bundleAgent, formatBytes } from "../bundler.js";
import { loadProjectConfig, findProjectRoot, requireAuth } from "../config.js";
import {
  createEdgeVersion,
  validateEdgeVersion,
  publishEdgeVersion,
  provisionEdgeDeployment,
  reprovisionDeployment,
  registerAgents,
  validateAgentRegistry,
  type AgentDeclarationInput,
} from "../api-client.js";

export interface DeployArgs {
  /** Skip validation step */
  skipValidation?: boolean;
  /** Bump version before deploying */
  version?: string;
  /** Dry run — bundle only, don't upload */
  dryRun?: boolean;
  /** Print verbose output */
  verbose?: boolean;
}

// ── Default version generator ────────────────────────────────────────────────

function generateVersion(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const mins = String(now.getMinutes()).padStart(2, "0");
  return `0.1.${now.getFullYear()}${month}${day}${hours}${mins}`;
}

export async function deployCommand(args: DeployArgs): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error("No AgentDeploy project found.");
    console.error("Run 'ad init' to create a new project.");
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);
  const auth = requireAuth();

  console.log();
  console.log(`  Deploying "${config.name}"...`);
  console.log();

  // ── Step 1: Bundle ──────────────────────────────────────────────────────
  console.log("  [1/6] Bundling with esbuild...");

  const bundle = await bundleAgent({
    projectRoot,
    entrypoint: config.entrypoint || "src/server.ts",
    minify: true,
    sourcemap: false,
  });

  if (bundle.warnings.length > 0 && args.verbose) {
    for (const w of bundle.warnings) {
      console.log(`       ⚠ ${w}`);
    }
  }

  console.log(`       ✓ Bundle size: ${formatBytes(bundle.sizeBytes)}`);

  if (bundle.sizeBytes > 3_145_728) {
    console.error(`       ✗ Bundle exceeds 3MB limit (${formatBytes(bundle.sizeBytes)})`);
    process.exit(1);
  }

  if (args.dryRun) {
    console.log();
    console.log("  Dry run complete. No upload performed.");
    console.log(`  Output: ${formatBytes(bundle.sizeBytes)}`);
    console.log();
    // Output to stdout for piping
    process.stdout.write(bundle.code);
    return;
  }

  // ── Step 2: Create edge version ─────────────────────────────────────────
  const version = args.version || generateVersion();
  console.log(`  [2/6] Uploading version ${version}...`);

  const versionResponse = await createEdgeVersion({
    templateId: config.templateId || 0,
    sellerId: auth.userId || auth.apiKey,
    version,
    entrypoint: "worker.js",
    format: "esm",
    source: "cli",
    script: bundle.code,
    compatibilityDate: new Date().toISOString().split("T")[0],
    compatibilityFlags: ["nodejs_compat"],
    changelog: `Deployed via CLI at ${new Date().toISOString()}`,
  });

  console.log(`       ✓ Version ID: ${versionResponse.id}`);

  // Show detected SDK capabilities if available
  const cap = versionResponse.capabilityInfo;
  if (cap) {
    console.log(`       ✓ Detected SDK agent: ${cap.agentCount} agent(s)${cap.durableObjectClasses.length ? ` [${cap.durableObjectClasses.join(", ")}]` : ""}`);
    const features: string[] = [];
    if (cap.usesAgentRouting) features.push("routing");
    if (cap.usesMcp) features.push("MCP");
    if (cap.usesScheduling) features.push("scheduling");
    if (cap.needsAiBinding) features.push("Workers AI");
    if (features.length > 0) {
      console.log(`       ✓ Capabilities: ${features.join(", ")}`);
    }
  }

  // ── Step 3: Register agents ─────────────────────────────────────────────
  // Auto-register detected Durable Object classes with default settings.
  // Sellers can customize weights and routing in the dashboard later.
  if (cap?.durableObjectClasses?.length) {
    console.log(`  [3/6] Registering ${cap.durableObjectClasses.length} agent(s)...`);

    const agents: AgentDeclarationInput[] = cap.durableObjectClasses.map((className, i) => ({
      class_name: className,
      display_name: className.replace(/([A-Z])/g, " $1").trim(), // "TriageAgent" → "Triage Agent"
      capacity_weight: 1,
      is_entrypoint: i === 0, // First detected class is the entrypoint
      uses_mcp: false,
      uses_scheduling: false,
    }));

    try {
      const result = await registerAgents(versionResponse.id, agents);
      if (result.skipped) {
        console.log("       ℹ Agents already registered for this version");
      } else {
        console.log(`       ✓ Registered ${result.registered} agent(s)`);
      }

      // Validate the registry matches the script
      const validation = await validateAgentRegistry(versionResponse.id);
      if (!validation.valid) {
        console.log("       ⚠ Registry validation warnings:");
        for (const err of validation.errors) {
          console.log(`         • ${err}`);
        }
        console.log("       (Publish will fail if these are not resolved)");
      }
    } catch (err) {
      console.log(`       ⚠ Agent registration skipped: ${(err as Error).message}`);
      console.log("       (You may need to register agents manually in the dashboard)");
    }
  } else {
    console.log("  [3/6] No Durable Object agents detected — skipping registry");
  }

  // ── Step 4: Validate ────────────────────────────────────────────────────
  if (!args.skipValidation) {
    console.log("  [4/6] Validating...");

    const declaredSecretKeys = (config.secrets || []).map((s) => s.key);
    const validationResult = await validateEdgeVersion(versionResponse.id);

    if (args.verbose) {
      console.log("       Validation report:", JSON.stringify(validationResult, null, 2));
    }

    console.log("       ✓ Validation passed");
  } else {
    console.log("  [4/6] Validation skipped");
  }

  // ── Step 5: Publish ─────────────────────────────────────────────────────
  console.log("  [5/6] Publishing...");

  await publishEdgeVersion(versionResponse.id, `Deployed via CLI`);

  console.log("       ✓ Published");

  // ── Step 6: Provision or reprovision ────────────────────────────────────
  if (config.deploymentId) {
    console.log("  [6/6] Reprovisioning existing deployment...");
    const updated = await reprovisionDeployment(config.deploymentId, auth.userId || "");

    console.log(`       ✓ Deployment: ${updated.id}`);
    console.log();
    console.log("  ──────────────────────────────────────────────");
    console.log(`  ✓ Deployed: ${updated.cloudflareWorkerUrl || "(URL pending)"}`);
    console.log(`    Model: ${updated.model || config.model || "(platform default)"}`);
    console.log(`    Dashboard: https://dashboard.agentdeploy.io/deployments/${config.deploymentId}`);
    console.log("  ──────────────────────────────────────────────");
    console.log();
  } else {
    console.log("  [6/6] Provisioning new deployment...");
    console.log("       ℹ First deployment — use the AgentDeploy dashboard to");
    console.log("         provision a deployment from this template version.");
    console.log();
    console.log("  ──────────────────────────────────────────────");
    console.log("  ✓ Template version published!");
    console.log(`    Version: ${version}`);
    console.log(`    Template ID: ${config.templateId || "(new — check dashboard)"}`);
    console.log(`    Dashboard: https://dashboard.agentdeploy.io/templates${config.templateId ? `/${config.templateId}` : ""}`);
    console.log("  ──────────────────────────────────────────────");
    console.log();
    console.log("  To create a deployment, visit the dashboard link above");
    console.log("  or use the platform API:");
    console.log("    POST /internal/edge/deploy");
    console.log();
  }
}
