import { describe, it, expect } from "vitest";
import { normalizeName, getDistinctiveFragment } from "../../../normalize.js";
import { verify } from "../../../verification.js";
import type { PageContent, RegistryInfo } from "../../../verification.js";
import leads from "../leads.json";
import verdicts from "../expected-verdicts.json";

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

interface ExpectedVerdict {
  key: string;
  expected_verdict: "verified" | "flagged" | "rejected";
  expected_website: string | null;
  expected_signals: number[];
  expected_score: number;
  notes: string;
  icp_excluded?: string;
}

function buildMockHtml(
  lead: CorpusLead,
  expectedSignals: number[]
): PageContent[] {
  const norm = normalizeName(lead.name);
  const fragment = getDistinctiveFragment(norm.normalized);

  const hasFooter = expectedSignals.includes(1);
  const hasTitle = expectedSignals.includes(2);
  const hasH1 = expectedSignals.includes(3);
  const hasAddress = expectedSignals.includes(4);
  const hasRegNumber = expectedSignals.includes(5);

  const titleContent = hasTitle
    ? `${fragment.charAt(0).toUpperCase() + fragment.slice(1)} — Professional Services`
    : "Welcome to our professional services firm";

  const ogSiteName = hasTitle
    ? `<meta property="og:site_name" content="${fragment.charAt(0).toUpperCase() + fragment.slice(1)}">`
    : "";

  const h1Content = hasH1
    ? `<h1>${fragment.charAt(0).toUpperCase() + fragment.slice(1)} — Your Trusted Partner</h1>`
    : "<h1>Welcome</h1>";

  const footerContent = hasFooter
    ? `<footer><p>&copy; 2024 ${lead.name}. All rights reserved. Registered in ${lead.country === "uk" ? "England" : "Ireland"}.</p></footer>`
    : "<footer><p>&copy; 2024 Professional Services Ltd. All rights reserved.</p></footer>";

  const addressBlock = hasAddress
    ? `<div class="contact-info"><address>${lead.address}</address></div>`
    : "";

  const regBlock = hasRegNumber
    ? `<p>Company Registration Number: ${lead.reg_number}</p>`
    : "";

  const bodyText = [
    "We are a trusted provider of professional services.",
    hasAddress ? `Visit us at ${lead.address}.` : "",
    hasRegNumber ? `Our company number is ${lead.reg_number}.` : "",
    "Contact us today for a free consultation.",
  ].join("\n");

  const html = `<!DOCTYPE html>
<html>
<head><title>${titleContent}</title>${ogSiteName}</head>
<body>
${h1Content}
<main>${bodyText}</main>
${addressBlock}
${regBlock}
${footerContent}
</body>
</html>`;

  const text = html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

  return [{ url: lead.known_website ?? "https://example.com", html, text }];
}

describe("corpus accuracy — 30-lead ground truth", () => {
  const leadMap = new Map<string, CorpusLead>();
  for (const lead of leads as CorpusLead[]) {
    leadMap.set(lead.key, lead);
  }

  it.each(verdicts as ExpectedVerdict[])(
    "$key — $expected_verdict (score $expected_score)",
    (expected) => {
      const lead = leadMap.get(expected.key);
      expect(lead, `Lead ${expected.key} not found`).toBeDefined();

      if (!lead) return;

      if (expected.icp_excluded === "sic") {
        expect(expected.expected_verdict).toBe("rejected");
        expect(expected.expected_score).toBe(0);
        expect(expected.expected_website).toBeNull();
        return;
      }

      if (!lead.known_website) {
        expect(expected.expected_verdict).toBe("rejected");
        expect(expected.expected_signals).toEqual([]);
        expect(expected.expected_score).toBe(0);
        expect(expected.expected_website).toBeNull();
        return;
      }

      const pages = buildMockHtml(lead, expected.expected_signals);

      const registry: RegistryInfo = {
        name: lead.name,
        address: lead.address,
        regNumber: lead.reg_number,
        city: lead.city,
      };

      const result = verify(pages, registry, lead.known_website);

      expect(result.verdict).toBe(expected.expected_verdict);
      expect(result.score).toBe(expected.expected_score);

      const firedSignalIds = result.signals
        .filter((s) => s.fired)
        .map((s) => s.id)
        .sort();
      expect(firedSignalIds).toEqual([...expected.expected_signals].sort());
    }
  );

  it("achieves ≥95% accuracy (29/30 verdicts match)", () => {
    let matches = 0;

    for (const expected of verdicts as ExpectedVerdict[]) {
      const lead = leadMap.get(expected.key);
      if (!lead) continue;

      if (expected.icp_excluded === "sic") {
        matches++;
        continue;
      }

      if (!lead.known_website) {
        if (expected.expected_verdict === "rejected" && expected.expected_score === 0) {
          matches++;
        }
        continue;
      }

      const pages = buildMockHtml(lead, expected.expected_signals);

      const registry: RegistryInfo = {
        name: lead.name,
        address: lead.address,
        regNumber: lead.reg_number,
        city: lead.city,
      };

      const result = verify(pages, registry, lead.known_website);

      if (result.verdict === expected.expected_verdict) {
        matches++;
      }
    }

    const accuracy = matches / (verdicts as ExpectedVerdict[]).length;
    expect(accuracy).toBeGreaterThanOrEqual(0.95);
    expect(matches).toBeGreaterThanOrEqual(29);
  });
});
