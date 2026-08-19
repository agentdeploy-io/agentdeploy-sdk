// ── ad generate ──────────────────────────────────────────────────────────────

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { findProjectRoot } from "../config.js";
import { toolTemplate, agentTemplate, uiTemplateFiles, type TemplateFile } from "../templates.js";

export interface GenerateArgs {
  type: "tool" | "agent" | "ui";
  name: string;
}

export async function generateCommand(args: GenerateArgs): Promise<void> {
  const projectRoot = findProjectRoot();
  if (!projectRoot) {
    console.error("No AgentDeploy project found. Run 'ad init' first.");
    process.exit(1);
  }

  // Convert name to different cases
  const camelName = args.name
    .replace(/[-_\s]+(.)|^(.)/g, (_, p1, p2) => (p1 || p2 || "").toUpperCase())
    .replace(/^./, (c) => c.toLowerCase());

  const pascalName = camelName.charAt(0).toUpperCase() + camelName.slice(1);

  switch (args.type) {
    case "tool": {
      const filePath = join(projectRoot, "src", `tools.${args.name.replace(/[-\s]/g, "_")}.ts`);

      if (existsSync(filePath)) {
        console.error(`File already exists: ${filePath}`);
        process.exit(1);
      }

      const content = toolTemplate(camelName, pascalName);
      writeFileSync(filePath, content, "utf-8");

      console.log();
      console.log(`  ✓ Created ${filePath}`);
      console.log();
      console.log(`  Import in your server.ts:`);
      console.log(`    import { ${camelName} } from "./tools.${args.name.replace(/[-\s]/g, "_")}.js";`);
      console.log();
      break;
    }

    case "agent": {
      const agentFileName = args.name.replace(/[-\s]/g, "_");
      const filePath = join(projectRoot, "src", `agents.${agentFileName}.ts`);

      if (existsSync(filePath)) {
        console.error(`File already exists: ${filePath}`);
        process.exit(1);
      }

      const content = agentTemplate(agentFileName, pascalName);
      writeFileSync(filePath, content, "utf-8");

      console.log();
      console.log(`  ✓ Created ${filePath}`);
      console.log();
      console.log(`  Import in your server.ts:`);
      console.log(`    import { ${pascalName} } from "./agents.${agentFileName}.js";`);
      console.log();
      console.log(`  For multi-agent routing:`);
      console.log(`    export default createHandler(${pascalName}, OtherAgent);`);
      console.log();
      break;
    }

    case "ui": {
      // Validate shell type
      const shellType = args.name;
      const validShells = ["chat", "widget", "dashboard", "split"];
      if (!validShells.includes(shellType)) {
        console.error(`Invalid UI shell type: ${shellType}`);
        console.error(`Available shells: ${validShells.join(", ")}`);
        process.exit(1);
      }

      const uiDir = join(projectRoot, "ui");
      if (existsSync(join(uiDir, "main.tsx"))) {
        console.error(`UI already exists at ${uiDir}`);
        console.error(`To regenerate, delete the ui/ directory first.`);
        process.exit(1);
      }

      // Derive agent name from project config
      const agentName = projectRoot.split("/").pop()?.replace(/-/g, "_") ?? "agent";
      const projectName = agentName;

      const files = uiTemplateFiles(projectName, agentName, shellType);
      for (const file of files) {
        const filePath = join(projectRoot, file.path);
        const fileDir = filePath.substring(0, filePath.lastIndexOf("/"));
        if (!existsSync(fileDir)) {
          mkdirSync(fileDir, { recursive: true });
        }
        writeFileSync(filePath, file.content, "utf-8");
      }

      console.log();
      console.log(`  ✓ Created UI in ${uiDir}`);
      console.log();
      console.log(`  Shell type: ${shellType}`);
      console.log();
      console.log(`  Next steps:`);
      console.log(`    npm install   # Install React deps if needed`);
      console.log(`    npm run dev:ui   # Start Vite dev server`);
      console.log();
      break;
    }
  }
}
