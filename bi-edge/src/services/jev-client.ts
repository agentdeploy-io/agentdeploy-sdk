export interface JevLeadInput {
  key: string;
  name: string;
  sic?: string | null;
  sic_label?: string | null;
  country: string;
  city?: string | null;
  website?: string | null;
  incorporated?: string | null;
  emails?: string[];
}

export interface JevClassification {
  key: string;
  vertical: string;
  vertical_detail: string;
  fit: number;
  tier: "HOT" | "WARM" | "COLD" | "SKIP";
  language: string;
  signals: string[];
  reasoning: string;
}

export class JevUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JevUnreachableError";
  }
}

const MAX_BATCH = 25;
const REQUEST_TIMEOUT_MS = 30_000;

export class JevClient {
  constructor(
    private jevUrl: string,
    private gatewayKey: string,
  ) {}

  async classifyBatch(
    leads: JevLeadInput[],
    icpDigest: string,
    buyerVertical = "AI agents for small business automation",
  ): Promise<JevClassification[]> {
    if (leads.length === 0) return [];

    const results: JevClassification[] = [];
    for (let i = 0; i < leads.length; i += MAX_BATCH) {
      const chunk = leads.slice(i, i + MAX_BATCH);
      const batch = await this.callClassify(chunk, icpDigest, buyerVertical);
      results.push(...batch);
    }
    return results;
  }

  private async callClassify(
    leads: JevLeadInput[],
    icpDigest: string,
    buyerVertical: string,
  ): Promise<JevClassification[]> {
    const baseUrl = this.jevUrl.replace(/\/$/, "");
    const url = `${baseUrl}/v1/classify`;

    const body = {
      leads: leads.map((l) => ({
        key: l.key,
        name: l.name,
        sic: l.sic ?? null,
        sic_label: l.sic_label ?? null,
        country: l.country,
        city: l.city ?? null,
        website: l.website ?? null,
        incorporated: l.incorporated ?? null,
        emails: l.emails ?? [],
      })),
      context: {
        focus: icpDigest,
        buyer_vertical: buyerVertical,
      },
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.gatewayKey ? { Authorization: `Bearer ${this.gatewayKey}` } : {}),
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : "unknown";
      throw new JevUnreachableError(`jev unreachable: ${msg}`);
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (res.status >= 500 || res.status === 502 || res.status === 503) {
        throw new JevUnreachableError(`jev ${res.status}: ${text.slice(0, 200)}`);
      }
      throw new Error(`jev classify failed (${res.status}): ${text.slice(0, 200)}`);
    }

    const data = (await res.json()) as {
      classifications?: JevClassification[];
    };

    if (!data.classifications || !Array.isArray(data.classifications)) {
      throw new Error("jev response missing classifications array");
    }

    const byKey = new Map<string, JevClassification>();
    for (const c of data.classifications) {
      byKey.set(c.key, c);
    }

    return leads.map(
      (l) =>
        byKey.get(l.key) ?? {
          key: l.key,
          vertical: "Unknown",
          vertical_detail: "",
          fit: 0,
          tier: "COLD",
          language: l.country.toLowerCase(),
          signals: [],
          reasoning: "jev returned no classification for this key",
        },
    );
  }
}

export function buildIcpDigest(icpConfig: {
  nace_include: string[];
  nace_exclude: string[];
  age_months_max: number;
  size_max: number;
  countries: string[];
}): string {
  return `ICP targets: ${icpConfig.nace_include.join(", ")} SIC codes (exclude: ${icpConfig.nace_exclude.join(", ")}), max ${icpConfig.size_max} employees, countries: ${icpConfig.countries.join(", ")}, age max ${icpConfig.age_months_max}mo`;
}

export function unclassifiedResult(key: string, country: string, reason: string): JevClassification {
  return {
    key,
    vertical: "Unknown",
    vertical_detail: "",
    fit: 0,
    tier: "COLD",
    language: country.toLowerCase(),
    signals: ["unclassified: jev unreachable"],
    reasoning: reason,
  };
}
