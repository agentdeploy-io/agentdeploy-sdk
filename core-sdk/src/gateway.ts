import type { GatewayClient, ChatMessage, ChatOptions } from "./types.js";

class GatewayClientImpl implements GatewayClient {
  private baseUrl: string;
  private deploymentId: string;
  private defaultModel: string;
  private apiKey: string;

  constructor(baseUrl: string, deploymentId: string, model: string, apiKey = "") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
    this.deploymentId = deploymentId;
    this.defaultModel = model;
    this.apiKey = apiKey.trim();
  }

  model(): string {
    return this.defaultModel;
  }

  /**
   * The gateway authenticates with the per-deployment key (Authorization:
   * Bearer); X-AD-Deployment is routing/observability metadata only.
   */
  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-AD-Deployment": this.deploymentId,
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }
    return headers;
  }

  private body(messages: ChatMessage[], options: ChatOptions | undefined, stream: boolean): string {
    return JSON.stringify({
      model: options?.model || this.defaultModel,
      messages,
      temperature: options?.temperature,
      max_tokens: options?.maxTokens,
      stop: options?.stop,
      ...(options?.tools?.length ? { tools: options.tools } : {}),
      ...(options?.toolChoice !== undefined ? { tool_choice: options.toolChoice } : {}),
      stream,
    });
  }

  async chat(messages: ChatMessage[], options?: ChatOptions): Promise<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(messages, options, false),
      signal: AbortSignal.timeout(120_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gateway chat failed (${res.status}): ${text.slice(0, 500)}`);
    }

    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content || "";
  }

  async *chatStream(messages: ChatMessage[], options?: ChatOptions): AsyncGenerator<string> {
    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      body: this.body(messages, options, true),
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Gateway stream failed (${res.status}): ${text.slice(0, 500)}`);
    }

    if (!res.body) {
      throw new Error("Gateway stream: no response body");
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith("data: ")) continue;
        const payload = trimmed.slice(6);
        if (payload === "[DONE]") return;

        try {
          const parsed = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>;
          };
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) yield content;
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }
}

export function createGatewayClient(
  baseUrl: string,
  deploymentId: string,
  model: string,
  apiKey = ""
): GatewayClient {
  return new GatewayClientImpl(baseUrl, deploymentId, model, apiKey);
}
