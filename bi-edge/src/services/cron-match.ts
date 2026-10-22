/**
 * cron-match — minimal 5-field cron matcher (minute hour dom month dow)
 * ────────────────────────────────────────────────────────────────────────────────────────────
 * Supports: `*`, `*\/n`, `a`, `a-b`, `a-b/n`, comma lists, dow 7 as Sunday.
 * Standard cron dom/dow rule: when BOTH are restricted (not `*`), the
 * expression matches if EITHER field matches.
 *
 * Used by the BiEdgeAgent DO alarm tick to decide which stored schedules
 * are due between the last run and now (no external cron library).
 */

type FieldSpec = Set<number> | null; // null = unrestricted (`*`)

interface CronSpec {
  minute: FieldSpec;
  hour: FieldSpec;
  dom: FieldSpec;
  month: FieldSpec;
  dow: FieldSpec;
}

function parseField(field: string, min: number, max: number, allowSevenDow = false): FieldSpec {
  if (field === "*") return null;
  const values = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`bad step in "${part}"`);
    }
    let lo: number;
    let hi: number;
    if (rangePart === "*" || rangePart === "") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      // single value with a step (e.g. "5/15") = range from that value on
      hi = stepPart !== undefined ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`bad range "${part}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) {
      values.add(allowSevenDow && v === 7 ? 0 : v);
    }
  }
  return values;
}

/** Validate the expression; throws on any malformation. */
function parseCron(expr: string): CronSpec {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error("cron expression must have 5 fields: minute hour dom month dow");
  }
  return {
    minute: parseField(fields[0], 0, 59),
    hour: parseField(fields[1], 0, 23),
    dom: parseField(fields[2], 1, 31),
    month: parseField(fields[3], 1, 12),
    dow: parseField(fields[4], 0, 7, true),
  };
}

export function isValidCron(expr: string): boolean {
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

export function cronMatches(expr: string, date: Date): boolean {
  const c = parseCron(expr);
  if (c.minute !== null && !c.minute.has(date.getMinutes())) return false;
  if (c.hour !== null && !c.hour.has(date.getHours())) return false;
  if (c.month !== null && !c.month.has(date.getMonth() + 1)) return false;
  const domOk = c.dom === null || c.dom.has(date.getDate());
  const dowOk = c.dow === null || c.dow.has(date.getDay());
  if (c.dom !== null && c.dow !== null) return domOk || dowOk;
  return domOk && dowOk;
}

/**
 * True if the expression fired at least once in the half-open window
 * (fromMs, toMs]. Minute-granularity; gaps over 48h collapse to a
 * single check at `toMs` (catch-up runs once, no backlog replay).
 */
export function cronWasDue(expr: string, fromMs: number, toMs: number): boolean {
  if (toMs <= fromMs) return false;
  const MAX_MINUTES = 2880;
  if (Math.floor((toMs - fromMs) / 60_000) > MAX_MINUTES) {
    return cronMatches(expr, new Date(toMs));
  }
  const start = Math.floor(fromMs / 60_000 + 1) * 60_000;
  for (let t = start; t <= toMs; t += 60_000) {
    if (cronMatches(expr, new Date(t))) return true;
  }
  return false;
}
