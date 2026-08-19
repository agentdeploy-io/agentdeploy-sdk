// ── AgentDeploy Edge SDK — Public Types ─────────────────────────────────────

import type { z } from "zod";

/**
 * Runtime context available inside tool execution and agent lifecycle hooks.
 */
export interface AgentContext {
  /** The deployment ID for this agent instance */
  deploymentId: string;
  /** The user ID of the deployment owner */
  userId: string;
  /** The template ID this agent was created from */
  templateId: number;
  /** The model string assigned to this deployment */
  model: string;
  /** The region for this deployment */
  region: string;
  /** The gateway base URL for LLM calls */
  gatewayBaseUrl: string;
  /** Environment bindings (secrets, KV, R2, etc.) */
  env: Record<string, unknown>;
}

/**
 * Configuration for a Durable Object agent (non-chat).
 */
export interface AgentConfig<TState = Record<string, unknown>> {
  /** Agent name — used in URL routing (/agents/:name/:instance) */
  name: string;

  /** Called when the agent starts (first invocation or wake from hibernation) */
  onStart?(this: AgentDeployAgent<TState>): void | Promise<void>;

  /** Called for each HTTP request that isn't an agent websocket upgrade */
  onRequest?(
    this: AgentDeployAgent<TState>,
    request: Request,
  ): Response | Promise<Response>;

  /** Called on WebSocket connection */
  onConnect?(this: AgentDeployAgent<TState>, connection: WebSocket): void;

  /** Called on WebSocket message */
  onMessage?(
    this: AgentDeployAgent<TState>,
    connection: WebSocket,
    message: unknown,
  ): void;

  /** Called on WebSocket close */
  onClose?(this: AgentDeployAgent<TState>, connection: WebSocket): void;

  /** Scheduled task handler — called when a scheduled task fires */
  onSchedule?(
    this: AgentDeployAgent<TState>,
    task: AgentSchedule,
  ): void | Promise<void>;

  /** Tools the agent can call via this.callTool() */
  tools?: Record<string, AgentDeployTool<any, any>>;

  /** MCP servers to connect */
  mcpServers?: McpServerConfig[];
}

/**
 * Configuration for a chat agent (AIChatAgent wrapper).
 */
export interface ChatAgentConfig {
  /** Agent name — used in URL routing */
  name: string;

  /** System prompt — can be a static string or a function that receives context */
  systemPrompt: string | ((ctx: AgentContext) => string | Promise<string>);

  /** Model hint — the platform may override based on deployment config */
  model?: string;

  /** Tools the agent can call */
  tools?: Record<string, AgentDeployTool<any, any>>;

  /** MCP servers to connect for additional tools */
  mcpServers?: McpServerConfig[];

  /** Maximum number of tool-call round trips before stopping (default: 10) */
  maxSteps?: number;

  /** Temperature override (default: provider default) */
  temperature?: number;

  /** Max tokens for completion (default: provider default) */
  maxTokens?: number;

  /** Called before each chat message is processed */
  onBeforeChat?(ctx: AgentContext): void | Promise<void>;

  /** Called after chat completes with usage info */
  onAfterChat?(
    ctx: AgentContext,
    usage: { tokensIn: number; tokensOut: number; totalTokens: number },
  ): void | Promise<void>;
}

/**
 * A tool definition created by defineTool().
 */
export interface AgentDeployTool<TInput = unknown, TOutput = unknown> {
  /** Human-readable description of what the tool does */
  description: string;
  /** Zod schema for input validation */
  inputSchema: z.ZodType<TInput>;
  /** Execute the tool with validated input and runtime context */
  execute: (
    input: TInput,
    ctx: ToolContext,
  ) => Promise<TOutput>;
  /** Whether this tool requires user approval before executing */
  needsApproval?: boolean;
}

/**
 * Context available during tool execution.
 */
export interface ToolContext {
  /** The calling agent instance */
  agent: AgentDeployAgent;
  /** Environment bindings */
  env: Record<string, unknown>;
  /** Deployment ID */
  deploymentId: string;
  /** Model string */
  model: string;
  /** Gateway base URL */
  gatewayBaseUrl: string;
}

/**
 * MCP server configuration for connecting external tool servers.
 */
export interface McpServerConfig {
  /** Transport type */
  transport:
    | { type: "sse"; url: string; headers?: Record<string, string> }
    | { type: "stdio"; command: string; args?: string[] }
    | { type: "ws"; url: string };
  /** Optional name for the server */
  name?: string;
}

/**
 * A scheduled task definition.
 */
export interface AgentSchedule {
  /** The cron expression or time the task was scheduled for */
  schedule: string;
  /** The task name/handler to invoke */
  name: string;
  /** Description of the task */
  description?: string;
  /** When the task was created */
  createdAt: string;
}

/**
 * The base class that AgentDeploy agents extend.
 * This wraps the Cloudflare Agents SDK Agent class with platform integrations.
 */
export interface AgentDeployAgent<TState = Record<string, unknown>> {
  // ── State ────────────────────────────────────────────────────────────────
  /** Current agent state */
  state: TState;
  /** Set agent state (syncs to connected clients) */
  setState(state: TState): void;

  // ── Environment ──────────────────────────────────────────────────────────
  /** Environment bindings */
  env: Record<string, unknown>;
  /** Durable Object context */
  ctx: DurableObjectState;

  // ── SQL ──────────────────────────────────────────────────────────────────
  /** Execute a SQL query against the agent's embedded SQLite */
  sql<T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): T[];

  // ── Scheduling ───────────────────────────────────────────────────────────
  /** Schedule a one-time task */
  schedule(when: string | Date, name: string, ...args: unknown[]): Promise<string>;
  /** Schedule a recurring task */
  scheduleEvery(cron: string, name: string, ...args: unknown[]): Promise<string>;
  /** Get all scheduled tasks */
  getSchedules(): AgentSchedule[];
  /** Cancel a scheduled task */
  cancelSchedule(id: string): void;

  // ── MCP ──────────────────────────────────────────────────────────────────
  /** MCP client for connecting to external tool servers */
  mcp: {
    connect(server: McpServerConfig): Promise<void>;
    getAITools(): Record<string, unknown>;
    disconnect(name?: string): Promise<void>;
  };

  // ── Tools ────────────────────────────────────────────────────────────────
  /** Call a tool by name with the given input */
  callTool(name: string, input: unknown): Promise<unknown>;

  // ── AgentDeploy Platform ─────────────────────────────────────────────────
  /** Get the runtime context */
  __adContext(): AgentContext;
  /** Report token usage to the platform for billing */
  __adReportUsage(usage: {
    tokensIn: number;
    tokensOut: number;
    totalTokens: number;
  }): void;
  /** Record a telemetry event */
  __adTelemetry(event: string, data?: Record<string, unknown>): void;
}

/**
 * The base class that AgentDeploy chat agents extend.
 */
export interface AgentDeployChatAgent extends AgentDeployAgent {
  /** Chat messages persisted in the agent's SQLite */
  messages: Array<{
    id: string;
    role: string;
    content: unknown;
    createdAt: string;
  }>;

  /** Called when a new chat message arrives — must return a Response */
  onChatMessage(
    onFinish: (result: unknown) => void | Promise<void>,
  ): Promise<Response>;
}

/**
 * Handler export for the worker fetch entry point.
 */
export interface AgentHandler {
  fetch(request: Request, env: Record<string, unknown>): Promise<Response>;
}

// ── Ambient constants injected by the platform renderer ─────────────────────

declare global {
  /** Deployment ID — injected by AgentDeploy renderer */
  const AD_DEPLOYMENT_ID: string;
  /** User ID — injected by AgentDeploy renderer */
  const AD_USER_ID: string;
  /** Template ID — injected by AgentDeploy renderer */
  const AD_TEMPLATE_ID: number;
  /** Model string — injected by AgentDeploy renderer */
  const AD_MODEL: string;
  /** Region — injected by AgentDeploy renderer */
  const AD_REGION: string;
  /** Gateway base URL — injected by AgentDeploy renderer */
  const AD_GATEWAY_BASE_URL: string;
  /** Gateway API key — injected for local dev; platform uses "ad-deployment-managed" */
  const AD_GATEWAY_API_KEY: string;
}
