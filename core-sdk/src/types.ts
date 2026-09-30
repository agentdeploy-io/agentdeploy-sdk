import type { z } from "zod";

export type TaskState =
  | "queued"
  | "running"
  | "awaiting_input"
  | "checkpointed"
  | "resumed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface CoreContext {
  deploymentId: string;
  userId: string;
  templateId: number;
  model: string;
  region: string;
  sql: SqlExecutor;
  secrets: SecretStore;
  gateway: GatewayClient;
}

export interface TaskContext {
  taskId: string;
  deploymentId: string;
  userId: string;
  templateId: number;
  model: string;
  sql: SqlExecutor;
  secrets: SecretStore;
  gateway: GatewayClient;
  telemetry: TelemetryClient;
  budget: BudgetFence;
  reportProgress(phase: string, data?: Record<string, unknown>): void;
  requestHumanInput(prompt: HumanPrompt): Promise<HumanResponse>;
  checkpoint(data: unknown): Promise<void>;
}

export interface TaskResult {
  state: "succeeded" | "failed";
  output?: unknown;
  tokensUsed?: number;
  error?: string;
}

export interface TaskHandler<TInput = unknown> {
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, ctx: TaskContext): Promise<TaskResult>;
  onCancel?(ctx: TaskContext): Promise<void>;
  onCheckpoint?(ctx: TaskContext): Promise<CheckpointBlob>;
  onRestore?(blob: CheckpointBlob, ctx: TaskContext): Promise<void>;
  onAwaitingInput?(prompt: HumanPrompt, ctx: TaskContext): Promise<void>;
}

export interface CoreAgentConfig {
  name: string;
  description?: string;
  onStart?(ctx: CoreContext): Promise<void>;
  onStop?(ctx: CoreContext): Promise<void>;
  taskHandlers: Record<string, TaskHandler<any>>;
}

export interface CoreAgent {
  name: string;
  description?: string;
  taskHandlers: Record<string, TaskHandler<any>>;
  onStart?(ctx: CoreContext): Promise<void>;
  onStop?(ctx: CoreContext): Promise<void>;
  _registered: true;
}

export interface SqlExecutor {
  run(sql: string, ...params: unknown[]): void;
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[];
  exec(sql: string): void;
}

export interface SecretStore {
  get(key: string): string;
  has(key: string): boolean;
  getAll(): Record<string, string>;
}

export interface GatewayClient {
  chat(messages: ChatMessage[], options?: ChatOptions): Promise<string>;
  chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string>;
  model(): string;
}

export interface ChatToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  name?: string;
  tool_call_id?: string;
  tool_calls?: ChatToolCall[];
}

export interface ChatToolSpec {
  type: string;
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface ChatOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  stop?: string[];
  tools?: ChatToolSpec[];
  toolChoice?: unknown;
}

export interface TelemetryClient {
  event(type: string, data?: Record<string, unknown>): void;
  toolCall(name: string, input: unknown, output: unknown, durationMs: number): void;
}

export interface BudgetFence {
  tokensRemaining(): number;
  vmMinutesRemaining(): number;
  percentUsed(): number;
  onWarning(callback: () => void): void;
  onExhausted(callback: () => void): void;
  reportTokenUsage(tokens: number): void;
}

export interface HumanPrompt {
  type: "approve" | "select" | "text" | "confirm";
  message: string;
  options?: string[];
  timeout?: number;
  defaultAction?: string;
}

export interface HumanResponse {
  action: string;
  input?: string;
  respondedAt: string;
  timedOut: boolean;
}

export interface CheckpointBlob {
  schemaVersion: number;
  taskId?: string;
  data: unknown;
  createdAt?: string;
}

export interface PlatformConfig {
  deploymentId: string;
  userId: string;
  templateId: number;
  model: string;
  region: string;
  controlPlaneUrl: string;
  gatewayBaseUrl: string;
  gatewayApiKey: string;
  brokerToken: string;
  dataDir: string;
  maxTokensPerDay: number;
  maxVmHoursPerDay: number;
}
