import { describe, it, expect } from "vitest";
import { parseCountries, SUPPORTED_COUNTRY_CODES } from "../services/countries.js";

describe("parseCountries", () => {
  it("normalises full names to codes", () => {
    expect(parseCountries("Ireland, France")).toEqual({ codes: ["ie", "fr"], unknown: [] });
    expect(parseCountries("UK, United Kingdom, GB")).toEqual({ codes: ["uk"], unknown: [] });
    expect(parseCountries("Portugal, Estonia")).toEqual({ codes: ["pt", "ee"], unknown: [] });
  });

  it("keeps valid 2-letter codes and dedupes", () => {
    expect(parseCountries("uk,ie,fr")).toEqual({ codes: ["uk", "ie", "fr"], unknown: [] });
    expect(parseCountries("uk, UK, ireland, ie")).toEqual({ codes: ["uk", "ie"], unknown: [] });
  });

  it("flags unknown countries", () => {
    expect(parseCountries("ireland, spain")).toEqual({ codes: ["ie"], unknown: ["spain"] });
    expect(parseCountries("germany")).toEqual({ codes: [], unknown: ["germany"] });
  });

  it("handles empty / whitespace", () => {
    expect(parseCountries("")).toEqual({ codes: [], unknown: [] });
    expect(parseCountries(" , , ")).toEqual({ codes: [], unknown: [] });
  });

  it("exposes the supported code list", () => {
    expect([...SUPPORTED_COUNTRY_CODES].sort()).toEqual(["ee", "fr", "ie", "pt", "uk"]);
  });
});
