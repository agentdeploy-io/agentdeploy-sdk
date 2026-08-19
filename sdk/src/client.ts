import type {
  ClientOptions,
  ChatOptions,
  ChatResponse,
  EdgeDeployment,
  EdgeDeploymentHealth,
  EdgeUsage,
  DeployInput,
  PagedResult,
  StreamChatOptions,
  WebhookConfig,
  CreateWebhookInput,
} from "./types.js";
import { AgentDeployError } from "./types.js";

const DEFAULT_BASE_URL = "https://api.agentdeploy.io";
const DEFAULT_TIMEOUT_MS = 30_000;

export class AgentDeploy {
  readonly baseUrl: string;
  readonly #apiKey: string;
  readonly #fetchImpl: typeof fetch;
  readonly #timeoutMs: number;

  constructor(options: ClientOptions) {
    if (!options.apiKey) {
      throw new AgentDeployError("apiKey is required", 400, { code: "SDK_CONFIG_MISSING" });
    }
    this.baseUrl = (options.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
    this.#apiKey = options.apiKey;
    this.#fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#timeoutMs = options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async request<T>(
    path: string,
    init: RequestInit = {},
    timeoutMs: number = this.#timeoutMs,
  ): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await this.#fetchImpl(`${this.baseUrl}${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.#apiKey}`,
          "User-Agent": "@agentdeploy-io/sdk/0.1.0",
          ...(init.headers ?? {}),
        },
      });

      if (!response.ok) {
        const body = await response.json().catch(() => null) as
          | { error?: { message?: string; code?: string }; message?: string; code?: string }
          | null;
        const message = body?.error?.message ?? body?.message ?? `HTTP ${response.status}`;
        const code = body?.error?.code ?? body?.code;
        throw new AgentDeployError(message, response.status, {
          code,
          requestId: response.headers.get("x-request-id") ?? undefined,
        });
      }

      const payload = (await response.json().catch(() => null)) as
        | { data?: T }
        | T;

      if (payload && typeof payload === "object" && "data" in (payload as Record<string, unknown>)) {
        return (payload as { data: T }).data;
      }
      return payload as T;
    } catch (error) {
      if (error instanceof AgentDeployError) throw error;
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new AgentDeployError(`Request timed out after ${timeoutMs}ms`, 504, {
          code: "SDK_TIMEOUT",
        });
      }
      throw new AgentDeployError(
        error instanceof Error ? error.message : String(error),
        503,
        { code: "SDK_REQUEST_FAILED" },
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  async deploy(input: DeployInput): Promise<Deployment> {
    const templateId = input.templateId;
    if (!templateId && !input.templateSlug) {
      throw new AgentDeployError("templateId or templateSlug is required", 400, {
        code: "SDK_DEPLOY_INPUT_INVALID",
      });
    }

    let resolvedTemplateId = templateId;
    if (!resolvedTemplateId && input.templateSlug) {
      const templates = await this.request<PagedResult<{ id: number; slug: string }>>(
        `/api/bff/edge/templates?slug=${encodeURIComponent(input.templateSlug)}&limit=1`,
      );
      const first = templates.items[0];
      if (!first) {
        throw new AgentDeployError(`Template not found: ${input.templateSlug}`, 404, {
          code: "SDK_TEMPLATE_NOT_FOUND",
        });
      }
      resolvedTemplateId = first.id;
    }

    const result = await this.request<{
      deploymentId: string;
      workerUrl: string;
      status: string;
    }>(`/api/bff/edge/deployments`, {
      method: "POST",
      body: JSON.stringify({
        templateId: resolvedTemplateId,
        llmProvider: input.llmProvider,
        model: input.model,
        region: input.region,
      }),
    });

    const deployment = new Deployment(this, result.deploymentId, result.workerUrl);

    if (input.secrets && Object.keys(input.secrets).length > 0) {
      await deployment.setSecrets(input.secrets);
    }

    return deployment;
  }

  async chat(
    deploymentId: string,
    options: ChatOptions,
  ): Promise<ChatResponse> {
    return this.request<ChatResponse>(
      `/v1/chat/deployments/${encodeURIComponent(deploymentId)}/completions`,
      {
        method: "POST",
        body: JSON.stringify({
          messages: options.messages,
          temperature: options.temperature,
          max_tokens: options.max_tokens,
          stream: false,
        }),
      },
    );
  }

  async *chatStream(
    deploymentId: string,
    options: StreamChatOptions,
  ): AsyncGenerator<string, void, unknown> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);

    try {
      const response = await this.#fetchImpl(
        `${this.baseUrl}/v1/chat/deployments/${encodeURIComponent(deploymentId)}/completions`,
        {
          method: "POST",
          signal: controller.signal,
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: "text/event-stream",
            "User-Agent": "@agentdeploy-io/sdk/0.1.0",
          },
          body: JSON.stringify({
            messages: options.messages,
            temperature: options.temperature,
            max_tokens: options.max_tokens,
            stream: true,
          }),
        },
      );

      if (!response.ok || !response.body) {
        throw new AgentDeployError(
          `Stream request failed: ${response.status}`,
          response.status,
          { code: "SDK_STREAM_FAILED" },
        );
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith("data: ")) continue;
          const jsonStr = trimmed.slice(6);
          if (jsonStr === "[DONE]") return;

          try {
            const chunk = JSON.parse(jsonStr) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const delta = chunk.choices?.[0]?.delta?.content;
            if (delta) yield delta;
          } catch {
            // Skip malformed chunks
          }
        }
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  async getDeployment(deploymentId: string): Promise<Deployment> {
    const detail = await this.request<{
      deployment: EdgeDeployment;
    }>(
      `/api/bff/edge/deployments/${encodeURIComponent(deploymentId)}`,
    );
    return new Deployment(this, deploymentId, detail.deployment.cloudflare_worker_url);
  }

  async listDeployments(options?: {
    limit?: number;
    offset?: number;
  }): Promise<PagedResult<EdgeDeployment>> {
    const params = new URLSearchParams({
      limit: String(options?.limit ?? 25),
      offset: String(options?.offset ?? 0),
    });
    return this.request<PagedResult<EdgeDeployment>>(
      `/api/bff/edge/deployments?${params.toString()}`,
    );
  }
}

export class Deployment {
  readonly id: string;
  readonly url: string;
  #client: AgentDeploy;

  constructor(client: AgentDeploy, id: string, url: string) {
    this.#client = client;
    this.id = id;
    this.url = url;
  }

  async details(): Promise<EdgeDeployment> {
    const { deployment } = await this.#client.request<{
      deployment: EdgeDeployment;
    }>(`/api/bff/edge/deployments/${encodeURIComponent(this.id)}`);
    return deployment;
  }

  async health(): Promise<EdgeDeploymentHealth | null> {
    const { health } = await this.#client.request<{
      health: EdgeDeploymentHealth | null;
    }>(`/api/bff/edge/deployments/${encodeURIComponent(this.id)}`);
    return health;
  }

  async chat(options: ChatOptions): Promise<ChatResponse> {
    return this.#client.chat(this.id, options);
  }

  async *stream(options: Omit<StreamChatOptions, "stream">): AsyncGenerator<string, void, unknown> {
    yield* this.#client.chatStream(this.id, { ...options, stream: true });
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/secrets/${encodeURIComponent(key)}`,
      { method: "PUT", body: JSON.stringify({ value }) },
    );
  }

  async setSecrets(secrets: Record<string, string>): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/secrets/batch`,
      { method: "POST", body: JSON.stringify({ secrets }) },
    );
  }

  async deleteSecret(key: string): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/secrets/${encodeURIComponent(key)}`,
      { method: "DELETE" },
    );
  }

  async usage(): Promise<EdgeUsage> {
    const data = await this.#client.request<EdgeUsage>(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/usage`,
    );
    return data;
  }

  async restart(): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/reprovision`,
      { method: "POST" },
    );
  }

  async destroy(): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}`,
      { method: "DELETE" },
    );
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  async listWebhooks(): Promise<WebhookConfig[]> {
    return this.#client.request<WebhookConfig[]>(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/webhooks`,
    );
  }

  async createWebhook(input: CreateWebhookInput): Promise<WebhookConfig> {
    return this.#client.request<WebhookConfig>(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/webhooks`,
      { method: "POST", body: JSON.stringify(input) },
    );
  }

  async deleteWebhook(webhookId: string): Promise<void> {
    await this.#client.request(
      `/api/bff/edge/deployments/${encodeURIComponent(this.id)}/webhooks/${encodeURIComponent(webhookId)}`,
      { method: "DELETE" },
    );
  }
}
