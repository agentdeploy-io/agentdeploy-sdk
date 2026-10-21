import type { NormalizedName } from "./types.js";

const LEGAL_SUFFIXES = [
  "PUBLIC LIMITED COMPANY",
  "DESIGNATED ACTIVITY COMPANY",
  "LIMITED LIABILITY COMPANY",
  "PUBLIC LTD",
  "PRIVATE LIMITED",
  "LIMITED",
  "LTD",
  "PLC",
  "LLC",
  "INC",
  "GMBH",
  "SARL",
  "SAS",
  "SA",
  "BV",
  "NV",
  "COMPANY",
  "A/S",
  "OÜ",
  "OOD",
  "EOOD",
  "AD",
  "GIE",
  "SE",
  "KG",
  "AG",
  "SRL",
  "SPRL",
  "SP Z OO",
  "SP. Z O.O",
  "SP. Z O.O.",
];

const SUFFIX_RE = new RegExp(
  `\\b(${LEGAL_SUFFIXES.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b\\.?$`,
  "i"
);

const DIACRITICS_MAP: Record<string, string> = {
  à: "a", á: "a", â: "a", ã: "a", ä: "a", å: "a", æ: "ae",
  ç: "c", è: "e", é: "e", ê: "e", ë: "e",
  ì: "i", í: "i", î: "i", ï: "i",
  ð: "d", ñ: "n", ò: "o", ó: "o", ô: "o", õ: "o", ö: "o", ø: "o",
  ù: "u", ú: "u", û: "u", ü: "u", ý: "y", ÿ: "y",
  þ: "th", œ: "oe", š: "s", ž: "z", ř: "r", č: "c", ě: "e", ň: "n", ů: "u", ď: "d", ť: "t",
};

/**
 * Strip diacritics from a string.
 */
function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(
      /[àáâãäåæçèéêëìíîïðñòóôõöøùúûüýÿþœšžřčěňůďť]/gi,
      (ch) => DIACRITICS_MAP[ch.toLowerCase()] ?? ch
    );
}

/**
 * Normalize a company registry name by stripping legal suffixes,
 * punctuation, case folding, and diacritics. Returns the normalized
 * name and a distinctive fragment (≥6 chars) for matching.
 *
 * @example
 * normalizeName("ACME DESIGN LTD") // { normalized: "acme design", fragment: "acmedesign" }
 */
export function normalizeName(raw: string): NormalizedName {
  let name = raw.trim();

  let prev: string;
  do {
    prev = name;
    name = name.replace(SUFFIX_RE, "").trim();
  } while (name !== prev);

  name = stripDiacritics(name);
  name = name.toLowerCase();
  name = name.replace(/[^a-z0-9\s]/g, " ");
  name = name.replace(/\s+/g, " ").trim();

  const fragment = name.replace(/\s/g, "");

  return { normalized: name, fragment };
}

/**
 * Extract a distinctive fragment of minimum length from a normalized name.
 * Picks the longest token if the concatenated fragment is too short.
 */
export function getDistinctiveFragment(normalized: string, minLen = 6): string {
  const compact = normalized.replace(/\s/g, "");
  if (compact.length >= minLen) return compact;

  const tokens = normalized.split(/\s+/).filter((t) => t.length >= minLen);
  if (tokens.length > 0) {
    return tokens.reduce((a, b) => (a.length >= b.length ? a : b));
  }

  return compact;
}
