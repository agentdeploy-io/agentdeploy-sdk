import { describe, it, expect, beforeEach } from "vitest";
import { parseIcpFrontMatter, validateLead } from "./icp-validator";
import type { IcpConfig, Lead } from "./icp-validator";

const ICP_MD = `---
nace_include: ["69", "70", "74", "81", "82", "85", "96"]
nace_exclude: ["62", "63", "73", "58", "59"]
age_months_max: 36
size_max: 50
countries: [uk, ie, fr]
must_have: [active_registry_status]
---

# Ideal Customer Profile

We sell AI agents for intake, quoting, scheduling and document processing.
`;

function makeConfig(): IcpConfig {
  return parseIcpFrontMatter(ICP_MD);
}

function makeLead(overrides: Partial<Lead> = {}): Lead {
  return {
    sic_code: "69",
    age_months: 12,
    employee_count: 5,
    country: "uk",
    registry_status: "active",
    ...overrides,
  };
}

describe("parseIcpFrontMatter", () => {
  it("parses YAML front-matter into IcpConfig", () => {
    const config = makeConfig();
    expect(config.nace_include).toEqual(["69", "70", "74", "81", "82", "85", "96"]);
    expect(config.nace_exclude).toEqual(["62", "63", "73", "58", "59"]);
    expect(config.age_months_max).toBe(36);
    expect(config.size_max).toBe(50);
    expect(config.countries).toEqual(["uk", "ie", "fr"]);
    expect(config.must_have).toEqual(["active_registry_status"]);
  });

  it("throws when no front-matter found", () => {
    expect(() => parseIcpFrontMatter("# No front-matter here")).toThrow("No YAML front-matter found");
  });
});

describe("validateLead", () => {
  let config: IcpConfig;

  beforeEach(() => {
    config = makeConfig();
  });

  it("SIC 69 (accounting) → HOT", () => {
    const result = validateLead(makeLead({ sic_code: "69" }), config);
    expect(result.tier).toBe("HOT");
    expect(result.valid).toBe(true);
    expect(result.signals).toHaveLength(0);
  });

  it("SIC 62 (software) → SKIP with exclusion signal", () => {
    const result = validateLead(makeLead({ sic_code: "62" }), config);
    expect(result.tier).toBe("SKIP");
    expect(result.valid).toBe(false);
    expect(result.signals).toContain("ICP exclude: SIC 62");
  });

  it("SIC 73 (advertising) → SKIP", () => {
    const result = validateLead(makeLead({ sic_code: "73" }), config);
    expect(result.tier).toBe("SKIP");
    expect(result.valid).toBe(false);
    expect(result.signals).toContain("ICP exclude: SIC 73");
  });

  it("lead aged 48 months → COLD (exceeds 36 max)", () => {
    const result = validateLead(makeLead({ age_months: 48 }), config);
    expect(result.tier).toBe("COLD");
    expect(result.valid).toBe(true);
    expect(result.signals).toContain("ICP age 48mo exceeds max 36mo");
  });

  it("lead with 100 employees → SKIP (exceeds 50 max)", () => {
    const result = validateLead(makeLead({ employee_count: 100 }), config);
    expect(result.tier).toBe("SKIP");
    expect(result.valid).toBe(false);
    expect(result.signals).toContain("ICP exclude: size 100 exceeds max 50");
  });

  it("UK lead with SIC 70 → HOT", () => {
    const result = validateLead(makeLead({ sic_code: "70", country: "uk" }), config);
    expect(result.tier).toBe("HOT");
    expect(result.valid).toBe(true);
    expect(result.signals).toHaveLength(0);
  });

  it("inactive registry status → SKIP", () => {
    const result = validateLead(makeLead({ registry_status: "dissolved" }), config);
    expect(result.tier).toBe("SKIP");
    expect(result.valid).toBe(false);
    expect(result.signals).toContain("ICP exclude: registry status not active");
  });

  it("country not in target list → WARM", () => {
    const result = validateLead(makeLead({ country: "de" }), config);
    expect(result.tier).toBe("WARM");
    expect(result.valid).toBe(true);
    expect(result.signals).toContain("ICP country de not in target list");
  });

  it("SIC not in include list → COLD", () => {
    const result = validateLead(makeLead({ sic_code: "41" }), config);
    expect(result.tier).toBe("COLD");
    expect(result.valid).toBe(true);
    expect(result.signals).toContain("ICP SIC 41 not in include list");
  });
});
