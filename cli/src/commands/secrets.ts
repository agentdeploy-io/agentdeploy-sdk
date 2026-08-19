// ── ad secrets ───────────────────────────────────────────────────────────────

import * as readline from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { loadProjectConfig, findProjectRoot, requireAuth } from "../config.js";
import { setSecret, getSecrets, getRequiredSecrets } from "../api-client.js";

export interface SecretsArgs {
  command: "set" | "list" | "required";
  key?: string;
  value?: string;
}

export async function secretsCommand(args: SecretsArgs): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error("No AgentDeploy project found.");
    process.exit(1);
  }

  const config = loadProjectConfig(projectRoot);

  if (!config.deploymentId) {
    console.error("No deployment ID found in project config.");
    console.error("Deploy first with 'ad deploy', then manage secrets.");
    process.exit(1);
  }

  const auth = requireAuth();
  const deploymentId = config.deploymentId;

  switch (args.command) {
    case "set":
      await secretsSet(deploymentId, auth.userId || "", args.key, args.value);
      break;
    case "list":
      await secretsList(deploymentId, auth.userId || "");
      break;
    case "required":
      await secretsRequired(deploymentId, auth.userId || "");
      break;
  }
}

async function secretsSet(
  deploymentId: string,
  userId: string,
  key?: string,
  value?: string
): Promise<void> {
  if (!key) {
    const rl = readline.createInterface({ input: stdin, output: stdout });
    key = (await rl.question("Secret key: ")).trim();
    if (!key) {
      console.error("Secret key is required.");
      rl.close();
      process.exit(1);
    }
    value = (await rl.question("Secret value: ")).trim();
    rl.close();
  } else if (!value) {
    // Read value from stdin if not provided as arg
    const rl = readline.createInterface({ input: stdin, output: stdout });
    value = (await rl.question(`Value for ${key}: `)).trim();
    rl.close();
  }

  if (!value) {
    console.error("Secret value is required.");
    process.exit(1);
  }

  console.log(`Setting secret "${key}"...`);
  await setSecret(deploymentId, userId, key!, value);
  console.log(`  ✓ Secret "${key}" set.`);
}

async function secretsList(deploymentId: string, userId: string): Promise<void> {
  const result = await getSecrets(deploymentId, userId);

  console.log();
  console.log("  Deployment Secrets:");
  console.log();

  if (!result.secrets || result.secrets.length === 0) {
    console.log("    (no secrets configured)");
    console.log();
    return;
  }

  for (const secret of result.secrets) {
    const status = secret.set ? "✓" : "✗";
    console.log(`    ${status} ${secret.key}`);
  }
  console.log();
}

async function secretsRequired(deploymentId: string, userId: string): Promise<void> {
  const result = await getRequiredSecrets(deploymentId, userId);

  console.log();
  console.log("  Required Secrets:");
  console.log();

  if (!result.secrets || result.secrets.length === 0) {
    console.log("    (no required secrets)");
    console.log();
    return;
  }

  for (const secret of result.secrets) {
    const required = secret.required ? "(required)" : "(optional)";
    console.log(`    ${secret.key} ${required}`);
    if (secret.description) {
      console.log(`      ${secret.description}`);
    }
  }
  console.log();
}
