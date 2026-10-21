import type { VerificationSignal, VerificationResult } from "./types.js";

export const SIGNAL_WEIGHTS: Record<number, number> = {
  1: 40,
  2: 20,
  3: 15,
  4: 20,
  5: 25,
};

export const SIGNAL_NAMES: Record<number, string> = {
  1: "footer_name",
  2: "title_or_og_site_name",
  3: "h1_heading",
  4: "registry_address",
  5: "registry_number",
};

const VERIFIED_THRESHOLD = 50;
const FLAGGED_THRESHOLD = 25;

/**
 * Build a signal record with the given fire status and snippet.
 */
export function makeSignal(
  id: number,
  fired: boolean,
  snippet: string
): VerificationSignal {
  return {
    id,
    name: SIGNAL_NAMES[id],
    weight: SIGNAL_WEIGHTS[id],
    fired,
    snippet: snippet.slice(0, 120),
  };
}

/**
 * Compute the verification score and verdict from a set of signals.
 *
 * Verdict rules:
 * - score >= 50 AND (signal 1 OR signal 5 fired) → "verified"
 * - 25 <= score < 50 → "flagged"
 * - score < 25 → "rejected"
 */
export function computeVerdict(
  url: string,
  signals: VerificationSignal[]
): VerificationResult {
  const score = signals.reduce((sum, s) => sum + (s.fired ? s.weight : 0), 0);
  const s1 = signals.find((s) => s.id === 1);
  const s5 = signals.find((s) => s.id === 5);
  const mandatorySignal = s1?.fired || s5?.fired;

  let verdict: VerificationResult["verdict"];
  if (score >= VERIFIED_THRESHOLD && mandatorySignal) {
    verdict = "verified";
  } else if (score >= FLAGGED_THRESHOLD) {
    verdict = "flagged";
  } else {
    verdict = "rejected";
  }

  return { url, score, signals, verdict };
}
