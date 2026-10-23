import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sourceList,
  probeList,
  discoverCommonCrawl,
  discoverGithub,
  discoverDefiLlama,
  discoverRegistry,
  hitsToCandidates,
  probeTechStack,
  fetchWayback,
  intentSummary,
} from "../pipeline/sources.js";
import type { Candidate, DiscoverCtx, SearchHit, VerticalPack } from "../pipeline/types.js";

function basePack(over: Partial<VerticalPack> = {}): VerticalPack {
  return {
    id: "v-test",
    name: "Test",
    icp: "UK web agencies",
    countries: ["uk"],
    dorks: ['intitle:"web design" "agency"'],
    requireWebsite: true,
    useRegistry: true,
    llmEnrich: true,
    mxGuess: true,
    minScore: 50,
    perCountryLimit: 20,
    ...over,
  };
}

function ctx(pack: VerticalPack): DiscoverCtx {
  return {
    pack,
    country: "uk",
    env: {},
    search: vi.fn(async () => ({ hits: [] as Array<{ url: string; title: string; description: string }>, via: "serp-llm" as const })),
    limit: 20,
    drops: {
      registry_sic: 0,
      no_website: 0,
      fetch_failed: 0,
      website_unverified: 0,
      icp_mismatch: 0,
      below_min_score: 0,
      budget: 0,
      duplicate: 0,
    },
  };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("sourceList / probeList", () => {
  it("defaults to dorks / monetization+techstack when unset", () => {
    expect(sourceList(basePack())).toEqual(["dorks"]);
    expect(probeList(basePack())).toEqual(["monetization", "techstack"]);
  });

  it("drops unknown ids", () => {
    expect(sourceList(basePack({ sources: ["dorks", "hacker", "commoncrawl"] }))).toEqual(["dorks", "commoncrawl"]);
    expect(probeList(basePack({ probes: ["intent", "bogus"] }))).toEqual(["intent"]);
  });
});

describe("discoverCommonCrawl", () => {
  it("resolves the latest index and dedupes origins", async () => {
    const ndjson = [
      JSON.stringify({ url: "https://www.agency-one.co.uk/web-design/" }),
      JSON.stringify({ url: "https://agency-one.co.uk/other/page" }),
      JSON.stringify({ url: "https://agency-two.co.uk/webdesign/" }),
      JSON.stringify({ url: "https://twitter.com/junk" }),
      "not json",
    ].join("\n");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("collinfo.json")) {
        return new Response(JSON.stringify([{ id: "CC-MAIN-2026-31" }]), { status: 200 });
      }
      if (u.includes("index.commoncrawl.org")) {
        return new Response(ndjson, { status: 200 });
      }
      return new Response("{}", { status: 404 });
    });

    const hits = await discoverCommonCrawl(ctx(basePack()));
    expect(hits.map((h) => h.url)).toEqual([
      "https://www.agency-one.co.uk/",
      "https://agency-two.co.uk/",
    ]);
  });

  it("returns [] when the index is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("down"));
    await expect(discoverCommonCrawl(ctx(basePack()))).resolves.toEqual([]);
  });
});

describe("discoverGithub", () => {
  it("extracts homepage root domains and filters noise", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("api.github.com")) {
        return new Response(
          JSON.stringify({
            items: [
              { homepage: "https://www.studio-x.co.uk/#contact", description: "Agency site" },
              { homepage: "https://studio-x.co.uk/other" }, // dup root
              { homepage: "https://github.com/x/y" }, // noise host
              { homepage: null },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });

    const hits = await discoverGithub(ctx(basePack()));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.url).toBe("https://www.studio-x.co.uk");
  });

  it("stops cleanly on rate limit", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("rate limited", { status: 403 }));
    await expect(discoverGithub(ctx(basePack()))).resolves.toEqual([]);
  });
});

describe("discoverDefiLlama", () => {
  it("filters by chain and positive TVL", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify([
          { name: "GoodProtocol", url: "https://good.fi", chain: "Ethereum", tvl: 1_000_000, category: "Lending" },
          { name: "OtherChain", url: "https://other.fi", chain: "Solana", tvl: 500, category: "DEX" },
          { name: "Dead", url: "https://dead.fi", chain: "Ethereum", tvl: 0 },
          { name: "NoUrl", chain: "Ethereum", tvl: 10 },
        ]),
        { status: 200 },
      ),
    );

    const hits = await discoverDefiLlama(ctx(basePack({ defillamaChains: ["eth"] })));
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("GoodProtocol");
    expect(hits[0]!.description).toContain("TVL $1,000,000");
  });
});

describe("hitsToCandidates", () => {
  it("builds deduped candidates keyed by country+root", () => {
    const cands = hitsToCandidates("uk", [
      { url: "https://www.a.co.uk/", title: "A", description: "" },
      { url: "https://a.co.uk/about", title: "A dup", description: "" },
      { url: "https://b.co.uk/", title: "B", description: "" },
      { url: "not-a-url", title: "bad", description: "" },
    ], "commoncrawl");
    expect(cands).toHaveLength(2);
    expect(cands[0]!.key).toBe("uk-a.co.uk");
    expect(cands[0]!.source).toBe("source:commoncrawl");
    expect(cands[1]!.name).toBe("B");
  });
});

describe("probeTechStack", () => {
  it("detects builders and platforms", () => {
    expect(probeTechStack('<html><script src="https://cdn.gpteng.co/app.js"></script></html>')).toContain("stack:lovable");
    expect(probeTechStack('<div data-wf-site="abc"></div>')).toContain("stack:webflow");
    expect(probeTechStack('<script id="__NEXT_DATA__" type="application/json">{} </script>')).toContain("stack:nextjs");
    expect(probeTechStack("<html><body>plain</body></html>")).toEqual([]);
  });
});

describe("fetchWayback + intentSummary", () => {
  it("computes recency from CDX timestamps", async () => {
    // Recent snapshots → active
    const now = new Date();
    const ts = (daysAgo: number) => {
      const d = new Date(now.getTime() - daysAgo * 86_400_000);
      return d.toISOString().slice(0, 10).replace(/-/g, "") + "120000";
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify([["timestamp"], [ts(20)], [ts(60)]]), { status: 200 }),
    );
    const wb = await fetchWayback("example.co.uk");
    expect(wb.available).toBe(true);
    expect(wb.snapshotCount).toBe(2);
    expect(wb.active).toBe(true);
    expect(wb.ageDays!).toBeGreaterThanOrEqual(0);
    expect(wb.ageDays!).toBeLessThanOrEqual(45);
  });

  it("reports no archive presence", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify([["timestamp"]]), { status: 200 }));
    const wb = await fetchWayback("ghost.example");
    expect(wb.snapshotCount).toBe(0);
    expect(intentSummary(wb)).toBe("intent: LOW — no archive presence");
  });

  it("builds a tiered intent line with OPR", () => {
    const line = intentSummary(
      { snapshotCount: 120, lastSnapshot: "2026-10-01", ageDays: 10, active: true, available: true },
      { authority: 5.5, referringDomains: 140 },
    );
    expect(line).toContain("HIGH");
    expect(line).toContain("authority 5.5");
    expect(line).toContain("140 referring domains");
  });
});

function mockCh(listing: unknown, details: Record<string, { sic?: string[]; locality?: string }>) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u.includes("/search/companies?")) {
      return new Response(JSON.stringify({ items: listing }), { status: 200 });
    }
    const m = u.match(/\/company\/(\w+)/);
    if (m && details[m[1]!]) {
      const d = details[m[1]!];
      return new Response(JSON.stringify({ sic_codes: d.sic, registered_office_address: { locality: d.locality } }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  });
}

describe("discoverRegistry (UK)", () => {

  it("harvests active UK companies, enriches SIC/city, links websites, skips excluded SIC + social-only hosts", async () => {
    mockCh(
      [
        { company_number: "10000001", title: "ACME WEB DESIGN LTD", company_status: "active", date_of_creation: "2023-05-01" },
        { company_number: "10000002", title: "BETA DIGITAL LTD", company_status: "active", date_of_creation: "2022-01-01" },
        { company_number: "10000003", title: "GAMMA CONSULTANCY LTD", company_status: "active", date_of_creation: "2021-01-01" },
        { company_number: "10000004", title: "DELTA WEB LTD", company_status: "dissolved", date_of_creation: "2020-01-01" },
      ],
      {
        "10000001": { sic: ["62012"], locality: "London" },
        "10000002": { sic: ["74900"], locality: "Bristol" },
        "10000003": { sic: ["70102"], locality: "Manchester" },
      },
    );

    const search = vi.fn(async (q: string) => {
      const hits: SearchHit[] =
        q.includes("ACME")
          ? [
              { url: "https://www.facebook.com/acme", title: "fb", description: "" },
              { url: "https://acmeweb.example/about", title: "acme", description: "" },
            ]
          : q.includes("BETA")
            ? [{ url: "https://betadigital.example/", title: "beta", description: "" }]
            : [];
      return { hits, via: "brave" as const };
    });

    const c: DiscoverCtx = {
      pack: basePack({ sicExclude: ["701"], dorks: ['"web design" agency'] }),
      country: "uk",
      env: { COMPANIES_HOUSE_KEY: "test-key" },
      search,
      limit: 20,
      drops: { registry_sic: 0, no_website: 0, fetch_failed: 0, website_unverified: 0, icp_mismatch: 0, below_min_score: 0, budget: 0, duplicate: 0 },
    };

    const out = await discoverRegistry(c);
    expect(out).toHaveLength(2);
    const acme = out.find((x) => x.name.includes("ACME"))!;
    expect(acme.website).toBe("https://acmeweb.example/"); // facebook skipped
    expect(acme.reg_number).toBe("10000001");
    expect(acme.sic).toBe("62012");
    expect(acme.city).toBe("London");
    expect(acme.source).toBe("registry:companieshouse.gov.uk");
    expect(out.find((x) => x.name.includes("GAMMA"))).toBeUndefined(); // SIC-excluded
    expect(out.find((x) => x.name.includes("DELTA"))).toBeUndefined(); // dissolved
  });

  it("drops registry companies without a website when requireWebsite is on", async () => {
    mockCh(
      [{ company_number: "10000001", title: "ACME WEB DESIGN LTD", company_status: "active", date_of_creation: "2023-05-01" }],
      { "10000001": { sic: ["62012"], locality: "London" } },
    );
    const search = vi.fn(async () => ({ hits: [] as SearchHit[], via: "brave" as const }));
    const c: DiscoverCtx = {
      pack: basePack({ dorks: ['"web design" agency'] }),
      country: "uk",
      env: { COMPANIES_HOUSE_KEY: "test-key" },
      search,
      limit: 20,
      drops: { registry_sic: 0, no_website: 0, fetch_failed: 0, website_unverified: 0, icp_mismatch: 0, below_min_score: 0, budget: 0, duplicate: 0 },
    };
    await expect(discoverRegistry(c)).resolves.toEqual([]);
  });
});

describe("discoverRegistry (FR)", () => {
  it("queries recherche-entreprises and maps fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const u = String(input);
      if (u.includes("recherche-entreprises")) {
        return new Response(
          JSON.stringify({
            results: [
              { siren: "123456789", nom_complet: "Agence Alpha", activite_principale: "62.012Z", date_creation: "2022-03-01", date_fermeture: null, siege: { libelle_commune: "Paris" } },
              { siren: "999999999", nom_complet: "Fermee SARL", date_fermeture: "2023-01-01" },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response("{}", { status: 404 });
    });
    const search = vi.fn(async () => ({ hits: [] as SearchHit[], via: "brave" as const }));
    const c: DiscoverCtx = {
      pack: basePack({ countries: ["fr"], dorks: ['"agence web"'] }),
      country: "fr",
      env: {},
      search,
      limit: 20,
      drops: { registry_sic: 0, no_website: 0, fetch_failed: 0, website_unverified: 0, icp_mismatch: 0, below_min_score: 0, budget: 0, duplicate: 0 },
    };
    const out = await discoverRegistry(c);
    expect(out).toHaveLength(0); // no website found + requireWebsite on
    expect(search).toHaveBeenCalled(); // it did try to link
  });
});

describe("discoverRegistry candidate shape", () => {
  it("keys candidates by country+reg number", async () => {
    mockCh(
      [{ company_number: "20000001", title: "OMEGA WEB LTD", company_status: "active", date_of_creation: "2024-01-01" }],
      { "20000001": { sic: ["62012"], locality: "Leeds" } },
    );
    const search = vi.fn(async () => ({ hits: [{ url: "https://omegaweb.example/", title: "omega", description: "" }] as SearchHit[], via: "brave" as const }));
    const c: DiscoverCtx = {
      pack: basePack({ dorks: ['"web design"'] }),
      country: "uk",
      env: { COMPANIES_HOUSE_KEY: "k" },
      search,
      limit: 20,
      drops: { registry_sic: 0, no_website: 0, fetch_failed: 0, website_unverified: 0, icp_mismatch: 0, below_min_score: 0, budget: 0, duplicate: 0 },
    };
    const out: Candidate[] = await discoverRegistry(c);
    expect(out[0]!.key).toBe("uk-reg-20000001");
    expect(out[0]!.via).toBe("registry");
  });
});
