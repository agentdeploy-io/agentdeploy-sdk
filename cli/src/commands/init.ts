// ── ad init ──────────────────────────────────────────────────────────────────

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { TEMPLATES, getTemplate, type TemplateFile } from "../templates.js";

export interface InitArgs {
  template: string;
  name: string;
  directory?: string;
}

export async function initCommand(args: InitArgs): Promise<void> {
  const template = getTemplate(args.template);
  const targetDir = resolve(args.directory || args.name);

  // Validate template name → default to chat-agent
  if (!TEMPLATES[args.template]) {
    console.error(`Unknown template: ${args.template}`);
    console.error(`Available templates: ${Object.keys(TEMPLATES).join(", ")}`);
    process.exit(1);
  }

  // Check if directory already exists and is non-empty
  if (existsSync(targetDir)) {
    const { readdirSync } = await import("node:fs");
    const entries = readdirSync(targetDir);
    if (entries.length > 0 && !entries.every((e) => e.startsWith("."))) {
      console.error(`Directory ${targetDir} is not empty. Use a fresh directory.`);
      process.exit(1);
    }
  } else {
    mkdirSync(targetDir, { recursive: true });
  }

  // Derive project values
  const projectName = args.name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  const agentName = projectName.replace(/-/g, "_");
  const pascalName = projectName
    .split(/[-_]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join("");

  // Write all template files
  for (const file of template.files) {
    const content = substituteTemplate(file.content, {
      PROJECT_NAME: projectName,
      AGENT_NAME: agentName,
      PASCAL_NAME: pascalName,
    });

    const filePath = join(targetDir, file.path);
    const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));

    // Create parent directories
    if (!existsSync(fileDir)) {
      mkdirSync(fileDir, { recursive: true });
    }

    writeFileSync(filePath, content, "utf-8");
  }

  console.log();
  console.log(`  ✓ Created ${projectName} in ${targetDir}`);
  console.log();
  console.log(`  Template: ${template.name} — ${template.description}`);
  console.log();
  console.log(`  Next steps:`);
  console.log();
  console.log(`    cd ${projectName}`);
  console.log(`    npm install`);
  console.log(`    npm run dev      # Run locally`);
  console.log(`    npm run deploy   # Deploy to AgentDeploy`);
  console.log();
}

// ── Template substitution ────────────────────────────────────────────────────

function substituteTemplate(
  content: string,
  vars: Record<string, string>
): string {
  let result = content;
  for (const [key, value] of Object.entries(vars)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}
