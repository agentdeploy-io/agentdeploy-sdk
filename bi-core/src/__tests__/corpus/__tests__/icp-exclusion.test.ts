import { describe, it, expect } from "vitest";
import leads from "../leads.json";

interface CorpusLead {
  key: string;
  country: string;
  name: string;
  reg_number: string;
  sic: string;
  sic_label: string;
  incorporated: string;
  address: string;
  city: string;
  employee_count: number;
  registry_status: string;
  source: string;
  source_url: string;
  known_website: string | null;
  known_website_source: string;
  _trap?: string;
}

interface IcpConfig {
  nace_include: string[];
  nace_exclude: string[];
  age_months_max: number;
  size_max: number;
  countries: string[];
  must_have: string[];
}

interface Lead {
  sic_code: string;
  age_months: number;
  employee_count: number;
  country: string;
  registry_status?: string;
}

type Tier = "HOT" | "WARM" | "COLD" | "SKIP";

interface ValidationResult {
  valid: boolean;
  tier: Tier;
  signals: string[];
}

const ICP_CONFIG: IcpConfig = {
  nace_include: ["69", "70", "74", "81", "82", "85", "96"],
  nace_exclude: ["62", "63", "73", "58", "59"],
  age_months_max: 36,
  size_max: 50,
  countries: ["uk", "ie", "fr"],
  must_have: ["active_registry_status"],
};

function validateLead(lead: Lead, config: IcpConfig): ValidationResult {
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

function leadToIcp(lead: CorpusLead): Lead {
  const incDate = new Date(lead.incorporated);
  const now = new Date();
  const ageMonths = (now.getFullYear() - incDate.getFullYear()) * 12 + (now.getMonth() - incDate.getMonth());

  return {
    sic_code: lead.sic,
    age_months: ageMonths,
    employee_count: lead.employee_count,
    country: lead.country,
    registry_status: lead.registry_status,
  };
}

describe("ICP exclusion — corpus traps", () => {
  const config = ICP_CONFIG;
  const allLeads = leads as CorpusLead[];

  describe("SIC-excluded traps", () => {
    const sicTraps = allLeads.filter((l) => l._trap === "sic-excluded");

    it("has 3 SIC-excluded trap leads", () => {
      expect(sicTraps).toHaveLength(3);
    });

    it.each(sicTraps)(
      "$key ($name, SIC $sic) → SKIP (ICP-excluded)",
      (lead) => {
        const icpLead = leadToIcp(lead);
        const result = validateLead(icpLead, config);
        expect(result.valid).toBe(false);
        expect(result.tier).toBe("SKIP");
        expect(result.signals.some((s) => s.startsWith("ICP exclude: SIC"))).toBe(true);
      }
    );

    it("uk-25678901 (Digital Horizons, SIC 62012) → excluded by SIC 62", () => {
      const lead = allLeads.find((l) => l.key === "uk-25678901");
      expect(lead).toBeDefined();
      const result = validateLead(leadToIcp(lead!), config);
      expect(result.valid).toBe(false);
      expect(result.signals).toContain("ICP exclude: SIC 62");
    });

    it("ie-567890 (Pixel Perfect Marketing, SIC 73110) → excluded by SIC 73", () => {
      const lead = allLeads.find((l) => l.key === "ie-567890");
      expect(lead).toBeDefined();
      const result = validateLead(leadToIcp(lead!), config);
      expect(result.valid).toBe(false);
      expect(result.signals).toContain("ICP exclude: SIC 73");
    });

    it("ie-556789 (TechNova Software, SIC 62020) → excluded by SIC 62", () => {
      const lead = allLeads.find((l) => l.key === "ie-556789");
      expect(lead).toBeDefined();
      const result = validateLead(leadToIcp(lead!), config);
      expect(result.valid).toBe(false);
      expect(result.signals).toContain("ICP exclude: SIC 62");
    });
  });

  describe("size-excluded traps", () => {
    const sizeTraps = allLeads.filter((l) => l._trap === "large-company");

    it("has 2 large-company trap leads", () => {
      expect(sizeTraps).toHaveLength(2);
    });

    it.each(sizeTraps)(
      "$key ($name, $employee_count employees) → SKIP (size-excluded)",
      (lead) => {
        const icpLead = leadToIcp(lead);
        const result = validateLead(icpLead, config);
        expect(result.valid).toBe(false);
        expect(result.tier).toBe("SKIP");
        expect(result.signals.some((s) => s.startsWith("ICP exclude: size"))).toBe(true);
      }
    );

    it("uk-13456789 (Sterling Partners, 85 employees) → excluded by size", () => {
      const lead = allLeads.find((l) => l.key === "uk-13456789");
      expect(lead).toBeDefined();
      const result = validateLead(leadToIcp(lead!), config);
      expect(result.valid).toBe(false);
      expect(result.signals).toContain("ICP exclude: size 85 exceeds max 50");
    });

    it("uk-22345678 (Grandview Estates, 120 employees) → excluded by size", () => {
      const lead = allLeads.find((l) => l.key === "uk-22345678");
      expect(lead).toBeDefined();
      const result = validateLead(leadToIcp(lead!), config);
      expect(result.valid).toBe(false);
      expect(result.signals).toContain("ICP exclude: size 120 exceeds max 50");
    });
  });

  describe("ICP-valid leads", () => {
    const validLeads = allLeads.filter((l) => !l._trap);

    it("has 25 ICP-valid leads", () => {
      expect(validLeads).toHaveLength(25);
    });

    it.each(validLeads)(
      "$key ($name, SIC $sic) → valid",
      (lead) => {
        const icpLead = leadToIcp(lead);
        const result = validateLead(icpLead, config);
        expect(result.valid).toBe(true);
        expect(result.tier).not.toBe("SKIP");
      }
    );
  });
});
