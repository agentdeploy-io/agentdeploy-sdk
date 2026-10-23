import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  sourceList,
  probeList,
  discoverCommonCrawl,
  discoverGithub,
  discoverDefiLlama,
  hitsToCandidates,
  probeTechStack,
  fetchWayback,
  intentSummary,
} from "../pipeline/sources.js";
import type { DiscoverCtx, VerticalPack } from "../pipeline/types.js";

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
