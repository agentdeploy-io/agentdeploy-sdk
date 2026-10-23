import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  looksLikeJsShell,
  probeMonetization,
  renderContent,
  closeBrowser,
} from "../pipeline/renderer.js";

describe("looksLikeJsShell", () => {
  it("flags nearly empty bodies", () => {
    expect(looksLikeJsShell("<html><body></body></html>", "   ")).toBe(true);
    expect(looksLikeJsShell("<html><body></body></html>", "Loading")).toBe(true);
  });

  it("accepts server-rendered pages with real text", () => {
    expect(looksLikeJsShell("<html><body></body></html>", "x".repeat(500))).toBe(false);
  });

  it("treats framework shells with thin text as shells", () => {
    const html = `<html><body><div id="__next"></div><script id="__NEXT_DATA__" type="application/json">{} </script></body></html>`;
    expect(looksLikeJsShell(html, "Welcome to our agency. We build websites for local businesses across the UK and beyond.".slice(0, 200))).toBe(true);
  });

  it("does not flag framework markers when text is substantial", () => {
    const html = `<html><body><div id="root">lots of content</div></body></html>`;
    expect(looksLikeJsShell(html, "x".repeat(600))).toBe(false);
  });
});

describe("probeMonetization", () => {
  it("detects payment providers, pricing links and paid-tier terms", () => {
    const html = `
      <html><head><script src="https://js.stripe.com/v3/"></script></head>
      <body>
        <a href="/pricing">Plans</a>
        <a href="/plans/pro">Pro</a>
        <p>Subscription plans. $49 per user/month. Start with a free trial.</p>
      </body></html>`;
    const signals = probeMonetization(html, "https://example.com");
    expect(signals).toContain("payment:stripe");
    expect(signals).toContain("pricing_links:2");
    expect(signals).toContain("paid_tier_terms");
  });

  it("returns nothing for a plain brochure site", () => {
    const html = `<html><body><p>Our web design studio in London.</p><a href="/about">About</a></body></html>`;
    expect(probeMonetization(html, "https://example.com")).toEqual([]);
  });
});

describe("renderContent (live chromium)", () => {
  beforeAll(() => {
    // ensure a clean browser is spun up once for the suite
  });
  afterAll(async () => {
    await closeBrowser();
  });

  it("executes JS and reads the rendered DOM", async () => {
    const dataUrl = "data:text/html," + encodeURIComponent(
      `<html><body><div id="app">shell</div>
       <script>document.getElementById("app").innerText = "RENDERED-BY-JS hello";</script>
       </body></html>`
    );
    const page = await renderContent(dataUrl);
    expect(page).not.toBeNull();
    expect(page!.text).toContain("RENDERED-BY-JS hello");
  }, 60_000);

  it("fetches a real site and returns body text", async () => {
    const page = await renderContent("https://example.com");
    expect(page).not.toBeNull();
    expect((page!.text ?? "").length).toBeGreaterThan(20);
  }, 90_000);
});
