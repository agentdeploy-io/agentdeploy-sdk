/// <reference types="@cloudflare/workers-types" />

// jev — Lead Classification Engine
// Standalone classifier worker. Receives raw registry leads, returns
// structured classification (vertical, fit, tier, language, signals).
//
// Env (set at deploy):
//   JEV_GATEWAY_BASE_URL  OpenAI-compatible base (…/compatible-mode)
//   JEV_GATEWAY_API_KEY   Bearer key for the gateway
//   JEV_MODEL             Model id (default qwen3.7-flash)
//   JEV_MAX_BATCH         Max leads per classify call (default 25)

type LeadIn = {
  key: string;
  name: string;
  country: string;
  sic?: string;
  incorporated?: string;
  officers?: string[];
  website?: string;
  emails?: string[];
  extra?: Record<string, unknown>;
};

type Classification = {
  key: string;
  vertical: string;
  vertical_detail: string;
  fit: number;
  tier: "HOT" | "WARM" | "COLD" | "SKIP";
  language: string;
  signals: string[];
  reasoning: string;
};

type ClassifyBody = {
  leads: LeadIn[];
  context?: {
    focus?: string;
    buyer_vertical?: string;
  };
};

const MAX_BATCH = Number((globalThis as any).JEV_MAX_BATCH ?? 25);

const SYSTEM = `You are jev, a B2B lead classification engine for an AI-automation sales pipeline.
You receive raw business-registry records (name, SIC/NAF code, incorporation date, officers, website).
Classify EACH lead for fit against small-business buyers of AI agents/automation.

Rules:
- "vertical": the business's actual industry in ONE short English label (e.g. "Web agency", "Dentist", "E-commerce shop", "Law firm", "Restaurant group"). Never empty.
- "vertical_detail": one sentence, what they do, in English.
- "fit": integer 0-100 — how likely this business is to buy/use AI agents (ops automation, lead handling, content, back-office).
- "tier": HOT (fit >= 70: active small business, clear automation surface), WARM (40-69: plausible fit), COLD (1-39: weak or unclear), SKIP (0: not a real active business, government, charity, holding shell, or obviously wrong ICP).
- "language": the language the business most likely operates in, ISO code (fr, en, et, pt, de, es, …).
- "signals": 1-4 short evidence strings drawn from the record (SIC meaning, name words, incorporation recency, officer titles, website domain words).
- "reasoning": one sentence justifying the tier.
- Judge from the record alone. Do not invent facts. Recency of incorporation raises fit (new businesses adopt fast).

Respond ONLY with a JSON array, one object per lead, in the SAME ORDER as input, each with exactly:
{"key":string,"vertical":string,"vertical_detail":string,"fit":number,"tier":"HOT"|"WARM"|"COLD"|"SKIP","language":string,"signals":string[],"reasoning":string}`;

function extractJson(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch {
    const m = t.match(/\[[\s\S]*\]/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {
        /* fall through */
      }
    }
    throw new Error("model returned non-JSON");
  }
}

function tierOf(fit: number): Classification["tier"] {
  if (fit >= 70) return "HOT";
  if (fit >= 40) return "WARM";
  if (fit >= 1) return "COLD";
  return "SKIP";
}

async function classify(env: Record<string, string | undefined>, leads: LeadIn[], context?: ClassifyBody["context"]): Promise<Classification[]> {
  const base = env.JEV_GATEWAY_BASE_URL;
  const key = env.JEV_GATEWAY_API_KEY;
  const model = env.JEV_MODEL || "qwen3.7-flash";
  if (!base || !key) throw new Error("JEV_GATEWAY_BASE_URL / JEV_GATEWAY_API_KEY not configured");

  const compact = leads.map((l) => ({
    key: l.key,
    name: l.name,
    country: l.country,
    sic: l.sic || null,
    incorporated: l.incorporated || null,
    officers: (l.officers || []).slice(0, 3),
    website: l.website || null,
    emails: (l.emails || []).length > 0,
  }));

  const user = [
    `Context: ${context?.focus ? `pipeline focus: ${context.focus}. ` : ""}${context?.buyer_vertical ? `Buyer sells AI agents to businesses. ` : ""}`,
    `Classify these ${leads.length} leads:`,
    JSON.stringify(compact),
  ].join("\n");

  const res = await fetch(`${base.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM },
        { role: "user", content: user },
      ],
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`gateway ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as any;
  const content: string = data?.choices?.[0]?.message?.content ?? "";
  const raw = extractJson(content);
  const arr = Array.isArray(raw) ? raw : (raw as any)?.classifications;
  if (!Array.isArray(arr)) throw new Error("classification array missing");

  const byKey = new Map<string, Classification>();
  for (const item of arr) {
    if (!item || typeof item !== "object") continue;
    const o = item as any;
    const lead = leads.find((l) => l.key === o.key) ?? leads[arr.indexOf(item)];
    if (!lead) continue;
    const fit = Math.max(0, Math.min(100, Math.round(Number(o.fit) || 0)));
    byKey.set(lead.key, {
      key: lead.key,
      vertical: String(o.vertical || "Unknown").slice(0, 80),
      vertical_detail: String(o.vertical_detail || "").slice(0, 300),
      fit,
      tier: (["HOT", "WARM", "COLD", "SKIP"].includes(o.tier) ? o.tier : tierOf(fit)) as Classification["tier"],
      language: String(o.language || lead.country).toLowerCase().slice(0, 8),
      signals: Array.isArray(o.signals) ? o.signals.map((s: unknown) => String(s).slice(0, 160)).slice(0, 4) : [],
      reasoning: String(o.reasoning || "").slice(0, 300),
    });
  }
  // Preserve input order; missing leads get a COLD placeholder so batches never drop rows.
  return leads.map((l) => byKey.get(l.key) ?? {
    key: l.key, vertical: "Unknown", vertical_detail: "", fit: 0, tier: "COLD",
    language: l.country, signals: [], reasoning: "classifier returned no row for this key",
  });
}

export default {
  async fetch(request: Request, env: any): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
      return Response.json({
        status: "ok",
        name: "jev",
        model: env.JEV_MODEL || "qwen3.7-flash",
        time: new Date().toISOString(),
      });
    }
    if (request.method === "POST" && url.pathname === "/v1/classify") {
      try {
        const body = (await request.json()) as ClassifyBody;
        if (!Array.isArray(body.leads) || body.leads.length === 0) {
          return Response.json({ error: "leads[] required" }, { status: 400 });
        }
        const leads = body.leads.slice(0, MAX_BATCH);
        const out: Classification[] = [];
        for (let i = 0; i < leads.length; i += MAX_BATCH) {
          out.push(...await classify(env, leads.slice(i, i + MAX_BATCH), body.context));
        }
        const counts = { HOT: 0, WARM: 0, COLD: 0, SKIP: 0 };
        for (const c of out) counts[c.tier] += 1;
        return Response.json({
          model: env.JEV_MODEL || "qwen3.7-flash",
          count: out.length,
          counts,
          classifications: out,
        });
      } catch (e: any) {
        return Response.json({ error: e?.message || "classify failed" }, { status: 500 });
      }
    }
    return new Response("Not found", { status: 404 });
  },
};
