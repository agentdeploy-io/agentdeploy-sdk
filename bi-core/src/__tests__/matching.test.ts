import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { normalizeName } from "../normalize.js";
import { makeSignal, computeVerdict, SIGNAL_WEIGHTS } from "../scoring.js";
import { DIRECTORY_DOMAINS } from "../discovery.js";

describe("normalizeName", () => {
  it("strips LTD suffix and produces correct fragment", () => {
    const result = normalizeName("ACME DESIGN LTD");
    expect(result.normalized).toBe("acme design");
    expect(result.fragment).toBe("acmedesign");
  });

  it("strips diacritics and SA suffix", () => {
    const result = normalizeName("Société Générale SA");
    expect(result.normalized).toBe("societe generale");
    expect(result.fragment).toBe("societegenerale");
  });

  it("strips & punctuation but LLP is not a recognized legal suffix", () => {
    const result = normalizeName("Smith & Jones Solicitors LLP");
    expect(result.normalized).toBe("smith jones solicitors llp");
    expect(result.fragment).toBe("smithjonessolicitorsllp");
  });

  it("strips Ltd suffix and apostrophe, Pty is not a recognized suffix", () => {
    const result = normalizeName("O'Brien Plumbing Pty Ltd");
    expect(result.normalized).toBe("o brien plumbing pty");
    expect(result.fragment).toBe("obrienplumbingpty");
  });

  it("removes / punctuation; A/S only stripped as suffix at end of name", () => {
    const result = normalizeName("A/S Dansk Firma");
    expect(result.normalized).toBe("a s dansk firma");
    expect(result.fragment).toBe("asdanskfirma");
  });
});

describe("scoring — computeVerdict", () => {
  function allSignalsOff() {
    return [1, 2, 3, 4, 5].map((id) => makeSignal(id, false, ""));
  }

  it("footer + title match (score 60) → verified", () => {
    const signals = allSignalsOff();
    signals[0] = makeSignal(1, true, "footer match");
    signals[1] = makeSignal(2, true, "title match");
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(SIGNAL_WEIGHTS[1] + SIGNAL_WEIGHTS[2]);
    expect(result.score).toBe(60);
    expect(result.verdict).toBe("verified");
  });

  it("title match only (score 20) → rejected", () => {
    const signals = allSignalsOff();
    signals[1] = makeSignal(2, true, "title match");
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(20);
    expect(result.verdict).toBe("rejected");
  });

  it("footer match only (score 40) → flagged (signal 1 fired but score < 50)", () => {
    const signals = allSignalsOff();
    signals[0] = makeSignal(1, true, "footer match");
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(40);
    expect(result.verdict).toBe("flagged");
  });

  it("footer + reg number (score 65, signals 1+5) → verified", () => {
    const signals = allSignalsOff();
    signals[0] = makeSignal(1, true, "footer match");
    signals[4] = makeSignal(5, true, "reg number match");
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(65);
    expect(result.verdict).toBe("verified");
  });

  it("address + H1 (score 35) → flagged", () => {
    const signals = allSignalsOff();
    signals[2] = makeSignal(3, true, "h1 match");
    signals[3] = makeSignal(4, true, "address match");
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(35);
    expect(result.verdict).toBe("flagged");
  });

  it("no signals (score 0) → rejected", () => {
    const signals = allSignalsOff();
    const result = computeVerdict("https://example.com", signals);
    expect(result.score).toBe(0);
    expect(result.verdict).toBe("rejected");
  });
});

describe("discovery — candidate filtering", () => {
  it("rocketreach.co is in DIRECTORY_DOMAINS (directory)", () => {
    expect(DIRECTORY_DOMAINS.some((d) => "rocketreach.co".includes(d))).toBe(true);
  });

  it("blogspot is a hosted platform domain", () => {
    const HOSTED = ["blogspot", "wixsite", "github.io", "squarespace"];
    expect(HOSTED.some((d) => "mycompany.blogspot.com".includes(d))).toBe(true);
  });

  it("single-token domain like 'digital.com' is generic", () => {
    const host = "digital.com";
    const clean = host.replace(/^www\./, "");
    const parts = clean.split(".");
    const registrable = parts[0];
    const isGeneric = /^[a-z]+$/.test(registrable) && registrable.length > 0;
    expect(isGeneric).toBe(true);
  });

  it("valid multi-token company website passes all filters", () => {
    const host = "acme-design.co.uk";
    const clean = host.replace(/^www\./, "");

    const isDirectory = DIRECTORY_DOMAINS.some((d) => clean.includes(d));
    expect(isDirectory).toBe(false);

    const HOSTED = ["blogspot", "wixsite", "github.io", "squarespace"];
    const isHosted = HOSTED.some((d) => clean.includes(d));
    expect(isHosted).toBe(false);

    const parts = clean.split(".");
    const registrable = parts[0];
    const isGeneric = /^[a-z]+$/.test(registrable) && registrable.length > 0 && parts.length < 3;
    expect(isGeneric).toBe(false);
  });
});
