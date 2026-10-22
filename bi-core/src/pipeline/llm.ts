// Minimal OpenAI-compatible chat client for the pipeline (DeepSeek via the
// Chutes gateway by default). Deliberately dependency-free: plain fetch +
// JSON-mode prompting. The model is swappable via env — that's the "make
// the LLM smarter" knob: drop in a better model and every flow improves.

const DEFAULT_BASE_URL = "https://llm.chutes.ai/v1";
const DEFAULT_MODEL = "deepseek-ai/DeepSeek-V4-Flash-0731-TEE";

function cfg(env: Record<string, string>): { baseUrl: string; key: string; model: string } {
  return {
    baseUrl: (env.LLM_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, ""),
    key: env.LLM_API_KEY || "",
    model: env.LLM_MODEL || DEFAULT_MODEL,
  };
}

export function llmConfigured(env: Record<string, string>): boolean {
  return !!env.LLM_API_KEY;
}

/**
 * Single chat completion that must return JSON. Retries once on parse
 * failure with a stricter nudge. Returns null on any unrecoverable error —
 * callers decide whether the LLM is optional for that step.
 */
export async function llmJson<T = Record<string, unknown>>(
  env: Record<string, string>,
  system: string,
  user: string,
): Promise<{ data: T | null; model: string; error?: string }> {
  const { baseUrl, key, model } = cfg(env);
  if (!key) return { data: null, model, error: "LLM_API_KEY not set" };

  const base = {
    model,
    temperature: 0.1,
    response_format: { type: "json_object" },
  };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          ...base,
          messages: [
            { role: "system", content: system + (attempt === 1 ? " Respond with STRICT JSON only, no markdown." : "") },
            { role: "user", content: user },
          ],
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        return { data: null, model, error: `LLM ${res.status}: ${text.slice(0, 160)}` };
      }
      const data = (await res.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const parsed = parseJsonLoose(content);
      if (parsed !== undefined) return { data: parsed as T, model };
    } catch (e: any) {
      return { data: null, model, error: e.message };
    }
  }
  return { data: null, model, error: "LLM returned unparseable JSON twice" };
}

function parseJsonLoose(content: string): unknown {
  const trimmed = content.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // strip accidental markdown fences
    const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (fenced?.[1]) {
      try {
        return JSON.parse(fenced[1].trim());
      } catch {
        /* fallthrough */
      }
    }
    const start = trimmed.indexOf("{");
    const end = trimmed.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}
