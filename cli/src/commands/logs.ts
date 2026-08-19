// ── ad logs ──────────────────────────────────────────────────────────────────
//
// Fetches logs from the deployment's health endpoint. For real-time logs,
// sellers can use `wrangler tail` directly.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, findProjectRoot, requireAuth } from "../config.js";
import { getDeployment } from "../api-client.js";

export interface LogsArgs {
  /** Follow logs (wrangler tail) */
  follow?: boolean;
}

/**
 * Check if wrangler is installed locally or declared in package.json.
 */
function checkWrangler(projectRoot: string): boolean {
  const localWrangler = join(projectRoot, "node_modules", ".bin", "wrangler");
  if (existsSync(localWrangler)) return true;

  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler) {
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

export async function logsCommand(args: LogsArgs): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error("No AgentDeploy project found.");
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);

  if (!config.deploymentId) {
    console.error("No deployment ID found. Deploy first with 'ad deploy'.");
    process.exit(1);
  }

  if (args.follow) {
    // Check wrangler is available before spawning tail
    if (!checkWrangler(projectRoot)) {
      console.error("wrangler is not installed in this project.");
      console.error("Live logs require wrangler. Install it with:");
      console.error("  npm install -D wrangler");
      console.error();
      process.exit(1);
    }

    // Use wrangler tail for live logs
    console.log("  Starting wrangler tail (live logs)...");
    console.log();

    const child = spawn(
      "npx",
      ["wrangler", "tail", config.projectId, "--format", "json"],
      {
        cwd: projectRoot,
        stdio: "inherit",
        shell: true,
      }
    );

    child.on("error", (err) => {
      console.error(`Failed to start wrangler tail: ${err.message}`);
      process.exit(1);
    });

    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // One-shot: fetch deployment health/status
  const auth = requireAuth();
  console.log("  Fetching deployment status...");
  console.log();

  try {
    const deployment = await getDeployment(config.deploymentId, auth.userId || "");
    console.log(JSON.stringify(deployment, null, 2));
  } catch (err) {
    console.error(`  ✗ ${(err as Error).message}`);
    console.log();
    console.log("  For live logs, try: ad logs --follow");
    process.exit(1);
  }
}
