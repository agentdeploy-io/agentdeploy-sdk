#!/usr/bin/env node
// ── AgentDeploy CLI — Entry Point ────────────────────────────────────────────
//
// `ad` — Build, deploy, and manage edge AI agents on AgentDeploy.
//
// Usage:
//   ad init --template chat-agent my-agent
//   ad login --api-key <key>
//   ad dev
//   ad deploy
//   ad secrets set STRIPE_API_KEY
//   ad generate tool inventory-check
//   ad logs --follow

import { initCommand } from "./commands/init.js";
import { loginCommand, logoutCommand } from "./commands/login.js";
import { devCommand } from "./commands/dev.js";
import { deployCommand } from "./commands/deploy.js";
import { secretsCommand } from "./commands/secrets.js";
import { generateCommand } from "./commands/generate.js";
import { logsCommand } from "./commands/logs.js";

// ── ANSI colors ──────────────────────────────────────────────────────────────

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const GREEN = "\x1b[32m";

// ── Version ──────────────────────────────────────────────────────────────────

const VERSION = "0.1.0";

// ── Help ─────────────────────────────────────────────────────────────────────

function printHelp(): void {
  console.log(`
${BOLD}AgentDeploy CLI${RESET} ${DIM}v${VERSION}${RESET}
Build and deploy edge AI agents on AgentDeploy.

${BOLD}USAGE${RESET}
  ad <command> [options]

${BOLD}COMMANDS${RESET}
  ${GREEN}init${RESET}       Create a new agent project
              ad init --template <chat-agent|chat-agent-with-ui|scheduled-agent|blank> [name]
              ad init --template chat-agent my-support-bot
              ad init --template chat-agent-with-ui my-agent

  ${GREEN}login${RESET}      Authenticate with your AgentDeploy API key
              ad login --api-key <key>
              ad login

  ${GREEN}logout${RESET}     Remove saved credentials
              ad logout

  ${GREEN}dev${RESET}        Run the agent locally (wraps wrangler dev)
              ad dev [--port 8787] [--remote]

  ${GREEN}deploy${RESET}     Bundle and deploy to AgentDeploy
              ad deploy [--version 1.0.0] [--dry-run] [--skip-validation]
              ad deploy

  ${GREEN}secrets${RESET}    Manage deployment secrets
              ad secrets set <KEY> [value]
              ad secrets list
              ad secrets required

  ${GREEN}generate${RESET}   Scaffold new files
              ad generate tool <name>     Create src/tools.<name>.ts
              ad generate agent <name>    Create src/agents.<name>.ts
              ad generate ui <shell>      Create UI shell (chat|widget|dashboard|split)

  ${GREEN}logs${RESET}       View deployment logs
              ad logs [--follow]

  ${GREEN}version${RESET}    Show CLI version
              ad version

  ${GREEN}help${RESET}       Show this help message

${BOLD}ENVIRONMENT VARIABLES${RESET}
  AGENTDEPLOY_API_KEY     Override login credentials
  AGENTDEPLOY_API_URL     Override API URL (default: https://api.agentdeploy.io)

${BOLD}EXAMPLES${RESET}
  ${DIM}# Create and deploy a new chat agent${RESET}
  ad init --template chat-agent my-agent
  cd my-agent
  npm install
  ad login --api-key ad_live_xxxxx
  ad deploy

  ${DIM}# Add a new tool${RESET}
  ad generate tool check-inventory

  ${DIM}# Manage secrets${RESET}
  ad secrets set STRIPE_API_KEY
  ad secrets list

${DIM}Documentation: https://docs.agentdeploy.io${RESET}
${DIM}Support: https://github.com/agentdeploy-io/agent-deploy-cli/issues${RESET}
`);
}

// ── Argument parsing ─────────────────────────────────────────────────────────

interface ParsedArgs {
  command: string;
  flags: Record<string, string | boolean>;
  positional: string[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2); // Skip node + script path
  const result: ParsedArgs = {
    command: "",
    flags: {},
    positional: [],
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      // Check if next arg is a value or another flag
      const nextArg = args[i + 1];
      if (nextArg && !nextArg.startsWith("--")) {
        result.flags[key] = nextArg;
        i++;
      } else {
        result.flags[key] = true;
      }
    } else if (arg.startsWith("-") && arg.length > 1) {
      const key = arg.slice(1);
      result.flags[key] = true;
    } else {
      result.positional.push(arg);
    }
  }

  result.command = result.positional[0] || "";
  result.positional = result.positional.slice(1);

  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const { command, flags, positional } = parseArgs(process.argv);

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  if (command === "version" || command === "--version" || command === "-v") {
    console.log(`AgentDeploy CLI v${VERSION}`);
    return;
  }

  try {
    switch (command) {
      // ── init ────────────────────────────────────────────────────────────
      case "init":
      case "create":
      case "new": {
        const template = (flags.template as string) || "chat-agent";
        const name = positional[0];

        if (!name) {
          console.error("Project name is required. Usage: ad init --template <template> <name>");
          process.exit(1);
        }

        await initCommand({ template, name });
        break;
      }

      // ── login ───────────────────────────────────────────────────────────
      case "login": {
        const apiKey = flags["api-key"] as string | undefined;
        const apiUrl = flags["api-url"] as string | undefined;
        await loginCommand({ apiKey, apiUrl });
        break;
      }

      // ── logout ──────────────────────────────────────────────────────────
      case "logout": {
        logoutCommand();
        break;
      }

      // ── dev ─────────────────────────────────────────────────────────────
      case "dev":
      case "serve": {
        const port = flags.port ? parseInt(flags.port as string, 10) : undefined;
        const remote = flags.remote === true;
        await devCommand({ port, remote });
        break;
      }

      // ── deploy ──────────────────────────────────────────────────────────
      case "deploy":
      case "publish": {
        await deployCommand({
          version: flags.version as string | undefined,
          dryRun: flags["dry-run"] === true,
          skipValidation: flags["skip-validation"] === true,
          verbose: flags.verbose === true || flags.v === true,
        });
        break;
      }

      // ── secrets ─────────────────────────────────────────────────────────
      case "secrets":
      case "secret": {
        const subcommand = (positional[0] || "list") as "set" | "list" | "required";

        if (subcommand === "set") {
          const key = positional[1];
          const value = positional[2];
          if (!key) {
            console.error("Usage: ad secrets set <KEY> [value]");
            process.exit(1);
          }
          await secretsCommand({ command: "set", key, value });
        } else {
          await secretsCommand({ command: subcommand });
        }
        break;
      }

      // ── generate ────────────────────────────────────────────────────────
      case "generate":
      case "gen":
      case "g": {
        const type = (positional[0] || "") as "tool" | "agent" | "ui";
        const name = positional[1];

        if (!type || (type !== "tool" && type !== "agent" && type !== "ui")) {
          console.error("Usage: ad generate <tool|agent|ui> <name>");
          console.error("  ad generate tool my-tool");
          console.error("  ad generate agent my-agent");
          console.error("  ad generate ui <chat|widget|dashboard|split>");
          process.exit(1);
        }

        if (!name) {
          console.error(`Name required. Usage: ad generate ${type} <name>`);
          process.exit(1);
        }

        await generateCommand({ type, name });
        break;
      }

      // ── logs ────────────────────────────────────────────────────────────
      case "logs":
      case "log": {
        const follow = flags.follow === true || flags.f === true;
        await logsCommand({ follow });
        break;
      }

      // ── Unknown ─────────────────────────────────────────────────────────
      default:
        console.error(`Unknown command: ${command}`);
        console.error("Run 'ad help' for usage information.");
        process.exit(1);
    }
  } catch (err) {
    console.error();
    console.error(`  ✗ Error: ${(err as Error).message}`);
    console.error();
    process.exit(1);
  }
}

main();
