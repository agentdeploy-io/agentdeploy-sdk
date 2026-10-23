import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  validateScraperCode,
  registerCustomSource,
  unregisterCustomSource,
  loadCustomSources,
  getCustomSource,
  listCustomSources,
  isCustomSource,
} from "../pipeline/custom-sources.js";
import { sourceList } from "../pipeline/sources.js";
import { emptyDrops, type VerticalPack } from "../pipeline/types.js";

const GOOD = `module.exports = {
  id: "test-src",
  description: "a test source",
  async discover(ctx) {
    try {
      const res = await fetch("https://example.com", { signal: AbortSignal.timeout(1000) });
      if (!res.ok) return [];
      return [{ url: "https://example.com", title: "Example" }].slice(0, ctx.limit);
    } catch {
      return [];
    }
  }
};`;

describe("custom-sources (AI scraper builder sandbox)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "scraper-test-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("accepts a valid module", () => {
    const out = validateScraperCode(GOOD);
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.id).toBe("test-src");
  });

  it("rejects missing discover()", () => {
    const out = validateScraperCode(`module.exports = { id: "no-discover" };`);
    expect(out.ok).toBe(false);
  });

  it("rejects missing/invalid id", () => {
    expect(validateScraperCode(`module.exports = { discover: async () => [] };`).ok).toBe(false);
    expect(validateScraperCode(`module.exports = { id: "UPPER CASE", discover: async () => [] };`).ok).toBe(false);
  });

  it("rejects syntax errors", () => {
    expect(validateScraperCode(`module.exports = {` ).ok).toBe(false);
  });

  it("rejects id mismatch against expectedId", () => {
    expect(validateScraperCode(GOOD, "other-id").ok).toBe(false);
    expect(validateScraperCode(GOOD, "test-src").ok).toBe(true);
  });

  it("rejects oversized code", () => {
    expect(validateScraperCode(GOOD + "x".repeat(60_000)).ok).toBe(false);
  });

  it("register persists to DATA_DIR/custom-sources and lists it", () => {
    const out = registerCustomSource(dir, "test-src", "a test source", GOOD);
    expect(out.ok).toBe(true);
    expect(fs.existsSync(path.join(dir, "custom-sources", "test-src.js"))).toBe(true);
    expect(listCustomSources().map((s) => s.id)).toContain("test-src");
    expect(isCustomSource("test-src")).toBe(true);
    expect(getCustomSource("test-src")?.discover).toBeTypeOf("function");
  });

  it("rejects double registration with a different id", () => {
    expect(registerCustomSource(dir, "other-id", "", GOOD).ok).toBe(false);
  });

  it("unregister removes from registry and disk", () => {
    registerCustomSource(dir, "test-src", "", GOOD);
    expect(unregisterCustomSource(dir, "test-src")).toBe(true);
    expect(isCustomSource("test-src")).toBe(false);
    expect(fs.existsSync(path.join(dir, "custom-sources", "test-src.js"))).toBe(false);
    expect(unregisterCustomSource(dir, "test-src")).toBe(false);
  });

  it("loadCustomSources restores approved files at boot", () => {
    registerCustomSource(dir, "test-src", "a test source", GOOD);
    // Simulate a fresh process: clear the in-memory registry by loading into
    // a brand new registry is not possible here, so just confirm idempotent reload.
    const loaded = loadCustomSources(dir);
    expect(loaded).toContain("test-src");
    expect(listCustomSources().map((s) => s.id)).toContain("test-src");
  });

  it("registered source executes in the vm sandbox and returns hits", async () => {
    registerCustomSource(dir, "test-src", "", GOOD);
    const src = getCustomSource("test-src")!;
    const ctx = {
      pack: { name: "t", countries: ["uk"], dorks: [], perCountryLimit: 5 } as unknown as VerticalPack,
      country: "uk",
      env: {},
      limit: 5,
      drops: emptyDrops(),
      search: async () => ({ hits: [], via: "serp-llm" as const }),
    };
    // example.com fetch may fail from the sandbox network — the module is
    // best-effort and must return [] rather than throw.
    const hits = await src.discover(ctx);
    expect(Array.isArray(hits)).toBe(true);
    for (const h of hits) {
      expect(typeof h.url).toBe("string");
      expect(typeof h.title).toBe("string");
    }
  });

  it("blocks require() inside registered sources", async () => {
    const evil = `module.exports = {
      id: "evil",
      async discover() {
        try {
          const fs = require("fs");
          return [{ url: "https://x", title: String(fs) }];
        } catch (e) {
          return [{ url: "https://x", title: "blocked: " + String(e) }];
        }
      }
    };`;
    const out = registerCustomSource(dir, "evil", "", evil);
    expect(out.ok).toBe(true);
    const hits = await getCustomSource("evil")!.discover({
      pack: { name: "t", countries: ["uk"], dorks: [], perCountryLimit: 5 } as unknown as VerticalPack,
      country: "uk",
      env: {},
      limit: 5,
      drops: emptyDrops(),
      search: async () => ({ hits: [], via: "serp-llm" as const }),
    });
    expect(hits[0]!.title).toContain("not available");
  });

  it("sourceList admits registered custom ids and still drops unknowns", () => {
    registerCustomSource(dir, "test-src", "", GOOD);
    const pack = { sources: ["dorks", "test-src", "bogus-source"] } as unknown as VerticalPack;
    expect(sourceList(pack)).toEqual(["dorks", "test-src"]);
  });
});
