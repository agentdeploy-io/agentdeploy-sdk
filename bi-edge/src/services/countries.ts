export const SUPPORTED_COUNTRY_CODES = ["uk", "ie", "fr", "ee", "pt"] as const;

const NAME_TO_CODE: Record<string, (typeof SUPPORTED_COUNTRY_CODES)[number]> = {
  uk: "uk",
  gb: "uk",
  "united kingdom": "uk",
  "great britain": "uk",
  britain: "uk",
  ie: "ie",
  ireland: "ie",
  fr: "fr",
  france: "fr",
  ee: "ee",
  estonia: "ee",
  pt: "pt",
  portugal: "pt",
};

export interface ParsedCountries {
  codes: string[];
  unknown: string[];
}

export function parseCountries(raw: string): ParsedCountries {
  const parts = raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const codes: string[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    const code = NAME_TO_CODE[part];
    if (code) {
      if (!codes.includes(code)) codes.push(code);
    } else if (!unknown.includes(part)) {
      unknown.push(part);
    }
  }
  return { codes, unknown };
}
