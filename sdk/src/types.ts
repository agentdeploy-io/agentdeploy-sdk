export type EdgeCodeFormat = "esm" | "service_worker";
export type EdgeVersionStatus = "draft" | "published" | "deprecated" | "yanked";
export type EdgeDeploymentStatus = "provisioning" | "active" | "suspended" | "deleted" | "failed";

export interface ClientOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}

export interface EdgeVersion {
  id: string;
  template_id: number;
  seller_id: string;
  version: string;
  entrypoint: string;
  format: EdgeCodeFormat;
  script_size_bytes: number;
  script_sha256: string;
  compatibility_date?: string | null;
  compatibility_flags?: string[] | null;
  bindings?: unknown;
  cpu_time_limit_ms: number;
  status: EdgeVersionStatus;
  changelog?: string | null;
  published_at?: string | null;
  created_at: string;
  updated_at: string;
}

export interface EdgeDeployment {
  id: string;
  template_id: number;
  cloudflare_worker_url: string;
  status: EdgeDeploymentStatus;
  model: string;
  llm_provider?: string | null;
  edge_invocations_total?: number;
  edge_cpu_time_used_ms?: number;
  edge_last_invocation_at?: string | null;
  created_at?: string;
  updated_at?: string;
}

export interface EdgeDeploymentHealth {
  status: string;
  provisioned: boolean;
  secrets?: {
    configured: number;
    expected: number;
    required: number;
    missing: string[];
  };
}

export interface EdgeUsage {
  invocations: number;
  cpuTimeMs: number;
  tokensUsed: number;
  lastInvokedAt?: string | null;
}

export interface DeployInput {
  templateSlug?: string;
  templateId?: number;
  llmProvider: string;
  model: string;
  region?: string;
  secrets?: Record<string, string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOptions {
  messages: ChatMessage[];
  temperature?: number;
  max_tokens?: number;
}

export interface StreamChatOptions extends ChatOptions {
  stream?: true;
}

export interface ChatResponse {
  id: string;
  object: "chat.completion";
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: ChatMessage;
    finish_reason: string;
  }>;
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    billed_tokens: number;
    charged_usd?: number;
  };
}

export interface EdgeTemplate {
  id: number;
  slug: string;
  name: string;
  description?: string;
  seller_name?: string;
  is_edge_template: boolean;
  edge_pricing?: {
    basePriceUsd: number;
    includedInvocations: number;
    overagePerInvocationUsd: number;
  };
}

export interface PagedResult<T> {
  items: T[];
  total: number;
}

// ── Webhook / Event Support ─────────────────────────────────────────────────

export type WebhookEventType =
  | "usage.threshold"
  | "deployment.restarted"
  | "deployment.failed"
  | "deployment.suspended"
  | "secret.updated"
  | "version.published";

export interface WebhookConfig {
  id: string;
  url: string;
  events: WebhookEventType[];
  secret?: string;
  enabled: boolean;
  createdAt: string;
}

export interface CreateWebhookInput {
  url: string;
  events: WebhookEventType[];
  secret?: string;
  enabled?: boolean;
}

export class AgentDeployError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly requestId?: string;

  constructor(message: string, status: number, options?: { code?: string; requestId?: string }) {
    super(message);
    this.name = "AgentDeployError";
    this.status = status;
    this.code = options?.code;
    this.requestId = options?.requestId;
  }
}
