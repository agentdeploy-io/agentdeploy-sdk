export interface IcpConfig {
  nace_include: string[];
  nace_exclude: string[];
  age_months_max: number;
  size_max: number;
  countries: string[];
  must_have: string[];
}

export interface Lead {
  sic_code: string;
  age_months: number;
  employee_count: number;
  country: string;
  registry_status?: string;
}

export type Tier = "HOT" | "WARM" | "COLD" | "SKIP";

export interface ValidationResult {
  valid: boolean;
  tier: Tier;
  signals: string[];
}

export function parseIcpFrontMatter(markdown: string): IcpConfig {
  const match = markdown.match(/^---\n([\s\S]*?)\n---/);
  if (!match) {
    throw new Error("No YAML front-matter found");
  }

  const yaml = match[1];
  const config: Record<string, unknown> = {};

  for (const line of yaml.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const colonIdx = trimmed.indexOf(":");
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    const raw = trimmed.slice(colonIdx + 1).trim();

    if (raw.startsWith("[") && raw.endsWith("]")) {
      const inner = raw.slice(1, -1);
      config[key] = inner
        .split(",")
        .map((v) => v.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean);
    } else if (/^\d+$/.test(raw)) {
      config[key] = parseInt(raw, 10);
    } else {
      config[key] = raw.replace(/^["']|["']$/g, "");
    }
  }

  return config as unknown as IcpConfig;
}

export function validateLead(lead: Lead, config: IcpConfig): ValidationResult {
  const signals: string[] = [];

  const sic = lead.sic_code.toString().padStart(2, "0").slice(0, 2);

  if (config.nace_exclude.includes(sic)) {
    signals.push(`ICP exclude: SIC ${sic}`);
    return { valid: false, tier: "SKIP", signals };
  }

  if (lead.employee_count > config.size_max) {
    signals.push(`ICP exclude: size ${lead.employee_count} exceeds max ${config.size_max}`);
    return { valid: false, tier: "SKIP", signals };
  }

  if (config.must_have.includes("active_registry_status") && lead.registry_status !== "active") {
    signals.push("ICP exclude: registry status not active");
    return { valid: false, tier: "SKIP", signals };
  }

  let tier: Tier = "HOT";

  if (lead.age_months > config.age_months_max) {
    signals.push(`ICP age ${lead.age_months}mo exceeds max ${config.age_months_max}mo`);
    tier = "COLD";
  }

  if (!config.nace_include.includes(sic)) {
    signals.push(`ICP SIC ${sic} not in include list`);
    tier = "COLD";
  }

  const country = lead.country.toLowerCase();
  if (!config.countries.map((c) => c.toLowerCase()).includes(country)) {
    signals.push(`ICP country ${country} not in target list`);
    if (tier === "HOT") tier = "WARM";
  }

  return { valid: true, tier, signals };
}
