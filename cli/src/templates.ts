// ── AgentDeploy CLI — Scaffolding Templates ──────────────────────────────────
//
// These are the templates used by `ad init`. Each template is a collection of
// file paths + contents that get written to the new project directory.

export interface TemplateFile {
  /** Relative path from project root */
  path: string;
  /** File content (uses {{VAR}} placeholders for substitution) */
  content: string;
}

export interface ProjectTemplate {
  name: string;
  description: string;
  files: TemplateFile[];
}

// ── Helper: shared files ─────────────────────────────────────────────────────

function sharedTsconfig(): string {
  return `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ES2022",
    "moduleResolution": "bundler",
    "lib": ["ES2022"],
    "types": ["@cloudflare/workers-types"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "noEmit": true
  },
  "include": ["src/**/*.ts"]
}
`;
}

function sharedWranglerJsonc(agentName: string, doClassName: string): string {
  return `{
  "name": "${agentName}",
  "main": "src/server.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // Durable Object bindings (auto-detected by platform on deploy)
  "durable_objects": {
    "bindings": [
      {
        "name": "${doClassName.toUpperCase().replace(/-/g, "_")}",
        "class_name": "${doClassName}"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["${doClassName}"]
    }
  ],

  // For local dev — these are overridden by the platform on deploy
  "vars": {
    "AD_DEPLOYMENT_ID": "local-dev",
    "AD_USER_ID": "local-dev",
    "AD_TEMPLATE_ID": "0",
    "AD_MODEL": "openai/gpt-4o-mini",
    "AD_REGION": "auto",
    "AD_GATEWAY_BASE_URL": "http://localhost:8787"
  }
}
`;
}

function sharedGitignore(): string {
  return `node_modules/
dist/
.agentdeploy/credentials
.wrangler/
.dev.vars
*.log
.env
`;
}

function sharedPackageJson(projectName: string): string {
  return `{
  "name": "${projectName}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "deploy": "ad deploy"
  },
  "dependencies": {
    "@agentdeploy-io/edge-sdk": "^0.1.0",
    "agents": "^0.18.0",
    "@cloudflare/ai-chat": "^0.9.0",
    "ai": "^6.0.0",
    "zod": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0",
    "typescript": "^5.7.0",
    "@cloudflare/workers-types": "^4.0.0"
  }
}
`;
}

// ── Template: chat-agent ─────────────────────────────────────────────────────

export const chatAgentTemplate: ProjectTemplate = {
  name: "chat-agent",
  description: "A chat agent with tool calling and streaming responses",
  files: [
    {
      path: "package.json",
      content: sharedPackageJson("{{PROJECT_NAME}}"),
    },
    {
      path: "tsconfig.json",
      content: sharedTsconfig(),
    },
    {
      path: "wrangler.jsonc",
      content: sharedWranglerJsonc("{{PROJECT_NAME}}", "MyAgent"),
    },
    {
      path: ".gitignore",
      content: sharedGitignore(),
    },
    {
      path: ".agentdeploy/config.json",
      content: `{
  "projectId": "{{PROJECT_NAME}}",
  "name": "{{PROJECT_NAME}}",
  "template": "chat-agent",
  "entrypoint": "src/server.ts",
  "model": "openai/gpt-4o-mini"
}
`,
    },
    {
      path: "src/server.ts",
      content: `import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const MyAgent = createChatAgent({
  name: "{{AGENT_NAME}}",
  systemPrompt: \`You are a helpful AI assistant built on AgentDeploy.
Be concise, accurate, and friendly. If you don't know something, say so.\`,
  maxSteps: 10,
});

export default createHandler(MyAgent);
`,
    },
    {
      path: "src/tools.ts",
      content: `import { defineTool } from "@agentdeploy-io/edge-sdk";
import { z } from "zod";

/**
 * Example tool — replace with your own business logic.
 */
export const exampleTool = defineTool({
  description: "An example tool that returns a greeting",
  inputSchema: z.object({
    name: z.string().describe("The name to greet"),
  }),
  execute: async ({ name }, ctx) => {
    return { greeting: \`Hello, \${name}!\`, timestamp: new Date().toISOString() };
  },
});
`,
    },
    {
      path: "README.md",
      content: `# {{PROJECT_NAME}}

An AI chat agent built with [@agentdeploy-io/edge-sdk](https://www.npmjs.com/package/@agentdeploy-io/edge-sdk).

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to AgentDeploy
npm run deploy
\`\`\`

## Add Tools

Edit \`src/tools.ts\` to define tools, then import them in \`src/server.ts\`:

\`\`\`typescript
import { exampleTool } from "./tools.js";

export const MyAgent = createChatAgent({
  name: "{{AGENT_NAME}}",
  systemPrompt: "You are a helpful assistant.",
  tools: { exampleTool },
});
\`\`\`
`,
    },
  ],
};

// ── Template: scheduled-agent ────────────────────────────────────────────────

export const scheduledAgentTemplate: ProjectTemplate = {
  name: "scheduled-agent",
  description: "A scheduled agent with cron tasks and SQLite state",
  files: [
    {
      path: "package.json",
      content: sharedPackageJson("{{PROJECT_NAME}}"),
    },
    {
      path: "tsconfig.json",
      content: sharedTsconfig(),
    },
    {
      path: "wrangler.jsonc",
      content: sharedWranglerJsonc("{{PROJECT_NAME}}", "ScheduledAgent"),
    },
    {
      path: ".gitignore",
      content: sharedGitignore(),
    },
    {
      path: ".agentdeploy/config.json",
      content: `{
  "projectId": "{{PROJECT_NAME}}",
  "name": "{{PROJECT_NAME}}",
  "template": "scheduled-agent",
  "entrypoint": "src/server.ts",
  "model": "openai/gpt-4o-mini"
}
`,
    },
    {
      path: "src/server.ts",
      content: `import { createAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const ScheduledAgent = createAgent({
  name: "{{AGENT_NAME}}",

  // Runs once when the agent first starts
  onStart() {
    // Initialize SQLite table for storing results
    this.sql\`
      CREATE TABLE IF NOT EXISTS task_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_name TEXT NOT NULL,
        result TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    \`;

    // Schedule a recurring task every 5 minutes
    this.scheduleEvery("*/5 * * * *", "healthCheck");
  },

  // Called when a scheduled task fires
  async onSchedule(task) {
    if (task.name === "healthCheck") {
      const result = { status: "healthy", time: new Date().toISOString() };

      this.sql\`
        INSERT INTO task_results (task_name, result)
        VALUES ('healthCheck', JSON(?))
      \`.bind(JSON.stringify(result));

      this.setState({ lastCheck: result });
    }
  },

  // HTTP endpoint to view results
  onRequest(request) {
    const url = new URL(request.url);

    if (url.pathname === "/results") {
      const rows = this.sql\`SELECT * FROM task_results ORDER BY created_at DESC LIMIT 50\`;
      return Response.json(rows);
    }

    if (url.pathname === "/health") {
      const lastRun = this.state?.lastCheck;
      return Response.json({
        status: "ok",
        lastRun,
        schedules: this.getSchedules(),
      });
    }

    return new Response("Scheduled Agent. Use /results or /health.", { status: 200 });
  },
});

export default createHandler(ScheduledAgent);
`,
    },
    {
      path: "README.md",
      content: `# {{PROJECT_NAME}}

A scheduled agent built with [@agentdeploy-io/edge-sdk](https://www.npmjs.com/package/@agentdeploy-io/edge-sdk).

## Features

- Runs on a configurable cron schedule
- Stores results in embedded SQLite
- HTTP endpoints for querying results

## Quick Start

\`\`\`bash
npm install
npm run dev      # Run locally with wrangler
npm run deploy   # Deploy to AgentDeploy
\`\`\`

## Customization

- Edit \`src/server.ts\` to change the cron schedule or add more tasks
- Add tools with \`defineTool()\` and call them via \`this.callTool()\`
`,
    },
  ],
};

// ── Template: blank ──────────────────────────────────────────────────────────

export const blankTemplate: ProjectTemplate = {
  name: "blank",
  description: "Minimal starter with no example code",
  files: [
    {
      path: "package.json",
      content: sharedPackageJson("{{PROJECT_NAME}}"),
    },
    {
      path: "tsconfig.json",
      content: sharedTsconfig(),
    },
    {
      path: "wrangler.jsonc",
      content: sharedWranglerJsonc("{{PROJECT_NAME}}", "Agent"),
    },
    {
      path: ".gitignore",
      content: sharedGitignore(),
    },
    {
      path: ".agentdeploy/config.json",
      content: `{
  "projectId": "{{PROJECT_NAME}}",
  "name": "{{PROJECT_NAME}}",
  "template": "blank",
  "entrypoint": "src/server.ts"
}
`,
    },
    {
      path: "src/server.ts",
      content: `import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

// Replace this with your agent logic
export const Agent = createChatAgent({
  name: "{{AGENT_NAME}}",
  systemPrompt: "You are a helpful assistant.",
});

export default createHandler(Agent);
`,
    },
  ],
};

// ── Template: chat-agent-with-ui ─────────────────────────────────────────────

function uiIndexHtml(title: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body, #app { height: 100%; }
  </style>
</head>
<body>
  <div id="app"></div>
  <script type="module" src="./main.tsx"></script>
</body>
</html>
`;
}

function uiMainTsx(agentName: string, shellType: string): string {
  if (shellType === "chat") {
    return `import React from "react";
import { createRoot } from "react-dom/client";
import { ChatShell } from "@agentdeploy-io/edge-ui";

const root = createRoot(document.getElementById("app")!);
root.render(
  <React.StrictMode>
    <ChatShell
      agent="${agentName}"
      name="default"
      title="${agentName}"
      greeting="Hello! How can I help you today?"
    />
  </React.StrictMode>
);
`;
  }
  if (shellType === "widget") {
    return `import React from "react";
import { createRoot } from "react-dom/client";
import { WidgetShell } from "@agentdeploy-io/edge-ui";

const root = createRoot(document.getElementById("app")!);
root.render(
  <React.StrictMode>
    <WidgetShell
      agent="${agentName}"
      name="default"
      title="${agentName}"
    />
  </React.StrictMode>
);
`;
  }
  if (shellType === "dashboard") {
    return `import React from "react";
import { createRoot } from "react-dom/client";
import { DashboardShell } from "@agentdeploy-io/edge-ui";

const root = createRoot(document.getElementById("app")!);
root.render(
  <React.StrictMode>
    <DashboardShell
      agent="${agentName}"
      name="default"
      title="${agentName} Dashboard"
      metrics={[]}
    />
  </React.StrictMode>
);
`;
  }
  // split
  return `import React from "react";
import { createRoot } from "react-dom/client";
import { SplitShell } from "@agentdeploy-io/edge-ui";

const root = createRoot(document.getElementById("app")!);
root.render(
  <React.StrictMode>
    <SplitShell
      agent="${agentName}"
      name="default"
      title="${agentName} Console"
    />
  </React.StrictMode>
);
`;
}

export function uiTemplateFiles(projectName: string, agentName: string, shellType: string): TemplateFile[] {
  return [
    {
      path: "ui/index.html",
      content: uiIndexHtml(projectName),
    },
    {
      path: "ui/main.tsx",
      content: uiMainTsx(agentName, shellType),
    },
    {
      path: "ui/vite.config.ts",
      content: `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "../dist/ui",
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      "/agents": "http://localhost:8787",
    },
  },
});
`,
    },
  ];
}

export const chatAgentWithUITemplate: ProjectTemplate = {
  name: "chat-agent-with-ui",
  description: "A chat agent with a bundled React UI shell",
  files: [
    {
      path: "package.json",
      content: `{
  "name": "{{PROJECT_NAME}}",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "wrangler dev",
    "dev:ui": "vite --config ui/vite.config.ts",
    "build:ui": "vite build --config ui/vite.config.ts",
    "deploy": "npm run build:ui && ad deploy"
  },
  "dependencies": {
    "@agentdeploy-io/edge-sdk": "^0.1.0",
    "@agentdeploy-io/agents": "^0.1.0",
    "@agentdeploy-io/edge-ui": "^0.1.0",
    "agents": "^0.18.0",
    "@cloudflare/ai-chat": "^0.9.0",
    "ai": "^6.0.0",
    "zod": "^4.0.0",
    "@ai-sdk/openai": "^1.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "wrangler": "^4.0.0",
    "typescript": "^5.7.0",
    "@cloudflare/workers-types": "^4.0.0",
    "vite": "^6.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0"
  }
}
`,
    },
    {
      path: "tsconfig.json",
      content: sharedTsconfig(),
    },
    {
      path: "wrangler.jsonc",
      content: `{
  "name": "{{PROJECT_NAME}}",
  "main": "src/server.ts",
  "compatibility_date": "2025-01-01",
  "compatibility_flags": ["nodejs_compat"],

  // Static assets for UI
  "assets": {
    "directory": "./dist/ui",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application"
  },

  "durable_objects": {
    "bindings": [
      {
        "name": "MY_AGENT",
        "class_name": "MyAgent"
      }
    ]
  },

  "migrations": [
    {
      "tag": "v1",
      "new_sqlite_classes": ["MyAgent"]
    }
  ],

  "vars": {
    "AD_DEPLOYMENT_ID": "local-dev",
    "AD_USER_ID": "local-dev",
    "AD_TEMPLATE_ID": "0",
    "AD_MODEL": "openai/gpt-4o-mini",
    "AD_REGION": "auto",
    "AD_GATEWAY_BASE_URL": "http://localhost:8787"
  }
}
`,
    },
    {
      path: ".gitignore",
      content: sharedGitignore() + "dist/ui/\n",
    },
    {
      path: ".agentdeploy/config.json",
      content: `{
  "projectId": "{{PROJECT_NAME}}",
  "name": "{{PROJECT_NAME}}",
  "template": "chat-agent-with-ui",
  "entrypoint": "src/server.ts",
  "model": "openai/gpt-4o-mini",
  "ui": {
    "shell": "chat",
    "dir": "ui",
    "buildDir": "dist/ui"
  }
}
`,
    },
    {
      path: "src/server.ts",
      content: `import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";
import { createUIHandler, isUIPath } from "@agentdeploy-io/edge-ui/runtime";

export const MyAgent = createChatAgent({
  name: "{{AGENT_NAME}}",
  systemPrompt: \`You are a helpful AI assistant built on AgentDeploy.
Be concise, accurate, and friendly. If you don't know something, say so.\`,
  maxSteps: 10,
});

const handler = createHandler(MyAgent);

export default {
  async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {
    const url = new URL(request.url);

    // Serve UI assets at /ui/*
    if (isUIPath(url.pathname)) {
      const uiResponse = await createUIHandler(request, env);
      if (uiResponse) return uiResponse;
    }

    // Route to agent
    return handler.fetch(request, env);
  },
};
`,
    },
    {
      path: "src/tools.ts",
      content: `import { defineTool } from "@agentdeploy-io/edge-sdk";
import { z } from "zod";

export const exampleTool = defineTool({
  description: "An example tool that returns a greeting",
  inputSchema: z.object({
    name: z.string().describe("The name to greet"),
  }),
  execute: async ({ name }) => {
    return { greeting: \`Hello, \${name}!\`, timestamp: new Date().toISOString() };
  },
});
`,
    },
    // UI files
    ...uiTemplateFiles("{{PROJECT_NAME}}", "{{AGENT_NAME}}", "chat"),
    {
      path: "README.md",
      content: `# {{PROJECT_NAME}}

An AI chat agent with bundled UI, built with [@agentdeploy-io/edge-sdk](https://www.npmjs.com/package/@agentdeploy-io/edge-sdk).

## Quick Start

\`\`\`bash
# Install dependencies
npm install

# Run agent + UI in development
npm run dev        # Start the agent (port 8787)
npm run dev:ui     # Start the UI dev server (port 5173)

# Build UI for production
npm run build:ui

# Deploy everything
npm run deploy
\`\`\`

## Architecture

- \`src/server.ts\` — Agent logic (Cloudflare Worker + Durable Object)
- \`ui/\` — React UI shell (served at /ui/* in production)
- The UI connects to the agent via WebSocket using \`useAgent\` from \`@agentdeploy-io/agents/react\`

## Customize the UI

Edit \`ui/main.tsx\` to change the shell type, theme, or layout.
Available shells: ChatShell, WidgetShell, DashboardShell, SplitShell.
`,
    },
  ],
};

// ── Template: core-agent ─────────────────────────────────────────────────────

export const coreAgentTemplate: ProjectTemplate = {
  name: "core-agent",
  description: "A long-running core agent on Fly.io VM with task handlers, SQLite, and budget fencing",
  files: [
    {
      path: "src/server.ts",
      content: `import { createCoreAgent, defineTaskHandler } from "@agentdeploy-io/core-sdk";
import { z } from "zod";

const defaultHandler = defineTaskHandler({
  description: "Process a task",
  inputSchema: z.object({
    prompt: z.string().describe("The task prompt"),
  }),

  async execute(input, ctx) {
    ctx.reportProgress("processing", { prompt: input.prompt });

    const result = await ctx.gateway.chat([
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: input.prompt },
    ]);

    return {
      state: "succeeded",
      output: { response: result },
    };
  },
});

export default createCoreAgent({
  name: "{{AGENT_NAME}}",
  description: "A long-running AI agent with task handlers",
  taskHandlers: {
    default: defaultHandler,
  },
  async onStart(ctx) {
    ctx.sql.exec(\`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        input TEXT,
        output TEXT,
        status TEXT DEFAULT 'pending',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    \`);
  },
});
`,
    },
    {
      path: "package.json",
      content: `{
  "name": "{{PROJECT_NAME}}",
  "private": true,
  "type": "module",
  "scripts": {
    "build": "tsc",
    "dev": "tsx watch src/server.ts",
    "start": "node dist/server.js"
  },
  "dependencies": {
    "@agentdeploy-io/core-sdk": "^0.1.0",
    "zod": "^4.0.0"
  },
  "devDependencies": {
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "@types/node": "^22.0.0"
  }
}
`,
    },
    {
      path: "tsconfig.json",
      content: `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "dist"
  },
  "include": ["src/**/*"]
}
`,
    },
    {
      path: "Dockerfile",
      content: `FROM node:22-alpine
WORKDIR /app
COPY package.json ./
RUN npm ci --omit=dev
COPY src/ ./src/
RUN npm install tsx && npx tsx --version
VOLUME /data
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=3 \\
  CMD wget -q --spider http://localhost:8080/health || exit 1
CMD ["npx", "tsx", "src/server.ts"]
`,
    },
    {
      path: "docker-compose.yml",
      content: `version: "3.9"
services:
  agent:
    build: .
    ports:
      - "8080:8080"
    volumes:
      - agent-data:/data
    environment:
      PORT: "8080"
      DATA_DIR: /data
      DEPLOYMENT_ID: local-dev
      USER_ID: local-dev
      TEMPLATE_ID: "0"
      MODEL: openai/gpt-4o-mini
      MAX_TOKENS_PER_DAY: "500000"
      MAX_VM_HOURS_PER_DAY: "4"
volumes:
  agent-data:
`,
    },
    {
      path: ".agentdeploy/config.json",
      content: `{
  "projectId": "{{PROJECT_NAME}}",
  "name": "{{PROJECT_NAME}}",
  "template": "core-agent",
  "runtime": "core",
  "entrypoint": "src/server.ts",
  "model": "openai/gpt-4o-mini"
}
`,
    },
    {
      path: "README.md",
      content: `# {{PROJECT_NAME}}

A long-running AI agent built with @agentdeploy-io/core-sdk.

## Quick Start

\\\`\\\`\\\`bash
npm install
npm run dev        # Run locally with tsx watch
docker compose up  # Run in Docker with /data volume
\\\`\\\`\\\`

## Deploy

\\\`\\\`\\\`bash
ad deploy --runtime core
\\\`\\\`\\\`

## Architecture

This agent runs on a Fly.io VM with:
- **Supervisor Protocol** for platform health monitoring
- **SQLite** on /data volume for persistent state
- **Checkpoint/restore** for crash recovery
- **Budget fencing** (token + VM-hour limits)
- **LLM gateway** for billed inference
`,
    },
    {
      path: ".gitignore",
      content: sharedGitignore() + "dist/\n*.db\n",
    },
  ],
};

// ── Template registry ────────────────────────────────────────────────────────

export const TEMPLATES: Record<string, ProjectTemplate> = {
  "chat-agent": chatAgentTemplate,
  "chat-agent-with-ui": chatAgentWithUITemplate,
  "scheduled-agent": scheduledAgentTemplate,
  "core-agent": coreAgentTemplate,
  blank: blankTemplate,
};

export function getTemplate(name: string): ProjectTemplate {
  const tmpl = TEMPLATES[name];
  if (!tmpl) {
    throw new Error(
      `Unknown template: ${name}. Available: ${Object.keys(TEMPLATES).join(", ")}`
    );
  }
  return tmpl;
}

// ── Template for generate:tool ───────────────────────────────────────────────

export function toolTemplate(toolName: string, pascalName: string): string {
  return `import { defineTool } from "@agentdeploy-io/edge-sdk";
import { z } from "zod";

export const ${toolName} = defineTool({
  description: "${pascalName} — TODO: describe what this tool does",
  inputSchema: z.object({
    // TODO: Add your input fields here
    // example: z.string().describe("Description of this field"),
  }),
  execute: async (input, ctx) => {
    // TODO: Implement your tool logic here
    // ctx.agent — the calling agent instance
    // ctx.env — environment bindings / secrets
    // ctx.deploymentId — deployment ID

    return {
      success: true,
      message: "${pascalName} executed",
    };
  },
});
`;
}

// ── Template for generate:agent ──────────────────────────────────────────────

export function agentTemplate(agentName: string, pascalName: string): string {
  return `import { createChatAgent, createHandler } from "@agentdeploy-io/edge-sdk";

export const ${pascalName} = createChatAgent({
  name: "${agentName}",
  systemPrompt: \`TODO: Write your system prompt for ${pascalName}.\`,
  maxSteps: 10,
  // tools: { ... },  // Import from ./tools.ts and pass here
});

// If this is the only agent, export it as default handler.
// For multi-agent routing, import all agents into your main server.ts
// and use createHandler(AgentA, AgentB, ...)
export default createHandler(${pascalName});
`;
}
