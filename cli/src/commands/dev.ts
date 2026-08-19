// ── ad dev ───────────────────────────────────────────────────────────────────
//
// Wraps `wrangler dev` with AgentDeploy-specific configuration.
// Sellers can also just run `npx wrangler dev` directly.

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadProjectConfig, findProjectRoot } from "../config.js";

export interface DevArgs {
  port?: number;
  remote?: boolean;
}

/**
 * Check if wrangler is installed (either locally or via npx).
 * Checks local node_modules first, then falls back to npx availability.
 */
function checkWrangler(projectRoot: string): boolean {
  // Check local node_modules
  const localWrangler = join(projectRoot, "node_modules", ".bin", "wrangler");
  if (existsSync(localWrangler)) return true;

  // Check if wrangler is in package.json dependencies
  const pkgPath = join(projectRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      if (pkg.devDependencies?.wrangler || pkg.dependencies?.wrangler) {
        // Declared but not installed — npx will pick it up
        return true;
      }
    } catch {
      // Ignore parse errors
    }
  }

  return false;
}

export async function devCommand(args: DevArgs): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error("No AgentDeploy project found. Run 'ad init' first.");
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);

  // Check wrangler.jsonc exists
  const wranglerPath = join(projectRoot, "wrangler.jsonc");
  if (!existsSync(wranglerPath)) {
    console.error("wrangler.jsonc not found. Ensure your project has a wrangler config.");
    process.exit(1);
  }

  // Check wrangler is available
  if (!checkWrangler(projectRoot)) {
    console.error("wrangler is not installed in this project.");
    console.error();
    console.error("Install it with:");
    console.error("  npm install -D wrangler");
    console.error();
    process.exit(1);
  }

  console.log(`Starting dev server for "${config.name}"...`);
  console.log();

  // Build wrangler dev args
  const wranglerArgs = ["wrangler", "dev"];

  if (args.port) {
    wranglerArgs.push("--port", String(args.port));
  }

  if (args.remote) {
    wranglerArgs.push("--remote");
  }

  // Spawn wrangler dev
  const child = spawn("npx", wranglerArgs, {
    cwd: projectRoot,
    stdio: "inherit",
    shell: true,
  });

  child.on("error", (err) => {
    console.error(`Failed to start wrangler: ${err.message}`);
    console.error("Make sure wrangler is installed: npm install -D wrangler");
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}
