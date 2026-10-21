// ── ad logs ──────────────────────────────────────────────────────────────────
//
// Fetches worker logs from the platform log endpoint
// (GET /cli/deployments/:id/logs), which queries Cloudflare Workers
// Observability with the platform token — no end-user Cloudflare
// credentials or wrangler required. `--follow` polls the endpoint.

import { loadProjectConfig, findProjectRoot } from "../config.js";
import { getDeploymentLogs, type WorkerLogEntry } from "../api-client.js";

export interface LogsArgs {
  /** Follow logs (poll the platform log endpoint) */
  follow?: boolean;
  /** Max entries per fetch (one-shot mode) */
  limit?: number;
}

const FOLLOW_POLL_MS = 3000;
const FOLLOW_WINDOW_MS = 10_000;

function formatEntry(entry: WorkerLogEntry): string {
  const ts = entry.timestamp.replace(/\.\d+Z$/, "Z");
  const level = entry.level.toUpperCase().padEnd(5);
  return `${ts} ${level} ${entry.message}`;
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
    console.log("  Following deployment logs (Ctrl+C to stop)...");
    console.log();
    let since = Date.now() - FOLLOW_WINDOW_MS;
    // Print an initial window so users see recent context immediately.
    const initial = await getDeploymentLogs(config.deploymentId, { limit: 20 });
    for (const entry of initial.logs) console.log(formatEntry(entry));
    if (initial.note) console.log(`  -- ${initial.note}`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
      await new Promise((resolve) => setTimeout(resolve, FOLLOW_POLL_MS));
      let logs: WorkerLogEntry[];
      try {
        const result = await getDeploymentLogs(config.deploymentId, {
          limit: 50,
          since,
        });
        logs = result.logs;
      } catch {
        continue; // transient network error — keep following
      }
      for (const entry of logs) console.log(formatEntry(entry));
      since = Date.now() - FOLLOW_WINDOW_MS;
    }
  }

  // One-shot: fetch recent worker logs (default: last hour)
  console.log("  Fetching deployment logs...");
  console.log();

  try {
    const result = await getDeploymentLogs(config.deploymentId, {
      limit: args.limit ?? 50,
    });
    if (result.logs.length === 0) {
      console.log("  No logs found in the last hour.");
      if (result.note) console.log(`  Note: ${result.note}`);
      else console.log("  (Workers must have observability enabled to emit logs.)");
    } else {
      for (const entry of result.logs) console.log(formatEntry(entry));
    }
    console.log();
    console.log("  For live logs, try: ad logs --follow");
  } catch (err) {
    console.error(`  ✗ ${(err as Error).message}`);
    process.exit(1);
  }
}
