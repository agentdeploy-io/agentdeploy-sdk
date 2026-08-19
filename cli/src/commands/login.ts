// ── ad login ─────────────────────────────────────────────────────────────────

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { verifyAndSaveCredentials } from "../api-client.js";
import { loadCredentials, saveCredentials } from "../config.js";

export interface LoginArgs {
  apiKey?: string;
  apiUrl?: string;
}

export async function loginCommand(args: LoginArgs): Promise<void> {
  let apiKey = args.apiKey;
  let apiUrl = args.apiUrl;

  // If no API key provided, prompt interactively
  if (!apiKey) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const existing = loadCredentials();

    apiUrl =
      apiUrl ||
      existing?.apiUrl ||
      process.env.AGENTDEPLOY_API_URL ||
      "https://api.agentdeploy.io";

    console.log();
    console.log(`  AgentDeploy CLI Login`);
    console.log(`  API URL: ${apiUrl}`);
    console.log();

    apiKey = (await rl.question("  API Key: ")).trim();
    rl.close();

    if (!apiKey) {
      console.error("API key is required.");
      process.exit(1);
    }
  }

  console.log();
  console.log("  Verifying credentials...");

  try {
    await verifyAndSaveCredentials(apiKey, apiUrl || undefined);
    console.log("  ✓ Logged in successfully!");
    console.log();
    console.log("  You can now use 'ad deploy' to deploy agents.");
    console.log();
  } catch (err) {
    console.error(`  ✗ Login failed: ${(err as Error).message}`);
    process.exit(1);
  }
}

export function logoutCommand(): void {
  const creds = loadCredentials();
  if (!creds) {
    console.log("  Not logged in.");
    return;
  }
  saveCredentials({ apiKey: "", apiUrl: "" });
  console.log("  ✓ Logged out.");
}
