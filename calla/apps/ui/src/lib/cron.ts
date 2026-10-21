export interface CronPreset {
  label: string;
  value: string;
  description: string;
}

export const CRON_PRESETS: CronPreset[] = [
  { label: "Every hour", value: "0 * * * *", description: "At the top of every hour" },
  { label: "Every 6 hours", value: "0 */6 * * *", description: "Every 6 hours" },
  { label: "Daily at 1 AM", value: "0 1 * * *", description: "Every day at 1:00 AM UTC" },
  { label: "Weekdays only", value: "0 9 * * 1-5", description: "Weekdays at 9:00 AM UTC" },
  { label: "Every Monday", value: "0 8 * * 1", description: "Every Monday at 8:00 AM UTC" },
  { label: "Every 30 minutes", value: "*/30 * * * *", description: "Every 30 minutes" },
  { label: "Twice daily", value: "0 8,20 * * *", description: "At 8:00 AM and 8:00 PM UTC" },
  { label: "Weekly (Sunday)", value: "0 0 * * 0", description: "Every Sunday at midnight UTC" },
];

const FIELD_NAMES = ["minute", "hour", "day of month", "month", "day of week"];

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function validateCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 7],
  ];

  return parts.every((part, i) => {
    const [min, max] = ranges[i];
    const segments = part.split(",");
    return segments.every((seg) => {
      if (seg === "*") return true;
      const stepMatch = seg.match(/^(\*|\d+(-\d+)?)\/(\d+)$/);
      if (stepMatch) {
        const step = parseInt(stepMatch[3], 10);
        if (step < 1 || step > max) return false;
        if (stepMatch[1] === "*") return true;
      }
      const rangeMatch = seg.match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const a = parseInt(rangeMatch[1], 10);
        const b = parseInt(rangeMatch[2], 10);
        return a >= min && b <= max && a <= b;
      }
      const num = parseInt(seg, 10);
      return !isNaN(num) && num >= min && num <= max;
    });
  });
}

export function cronToHumanReadable(expr: string): string {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return "Invalid expression";

  const [minute, hour, dom, month, dow] = parts;

  if (minute === "*" && hour === "*" && dom === "*" && month === "*" && dow === "*") {
    return "Every minute";
  }

  const pieces: string[] = [];

  if (minute.startsWith("*/")) {
    pieces.push(`Every ${minute.slice(2)} minutes`);
  } else if (minute === "0" && hour === "*") {
    pieces.push("Every hour at :00");
  } else if (minute !== "*" && hour !== "*") {
    const h = hour.includes(",")
      ? hour.split(",").map((v) => formatHour(v)).join(", ")
      : formatHour(hour);
    const m = minute.padStart(2, "0");
    pieces.push(`At ${h}:${m} UTC`);
  } else if (minute !== "*" && hour === "*") {
    pieces.push(`At minute ${minute} of every hour`);
  }

  if (hour.startsWith("*/")) {
    pieces.push(`Every ${hour.slice(2)} hours`);
    if (minute !== "0" && minute !== "*") {
      pieces[0] = `at :${minute.padStart(2, "0")}`;
    }
  }

  if (dom !== "*") {
    pieces.push(`on day ${dom} of the month`);
  }

  if (month !== "*") {
    const mIdx = parseInt(month, 10) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      pieces.push(`in ${MONTH_NAMES[mIdx]}`);
    } else {
      pieces.push(`in month ${month}`);
    }
  }

  if (dow !== "*") {
    if (dow.includes("-")) {
      const [start, end] = dow.split("-").map(Number);
      pieces.push(`${DAY_NAMES[start]} through ${DAY_NAMES[end]}`);
    } else if (dow.includes(",")) {
      const days = dow.split(",").map((d) => DAY_NAMES[parseInt(d, 10)] ?? d);
      pieces.push(days.join(", "));
    } else {
      const d = parseInt(dow, 10);
      if (d === 0 || d === 7) {
        pieces.push("on Sundays");
      } else {
        pieces.push(`on ${DAY_NAMES[d]}s`);
      }
    }
  }

  return pieces.join(" ");
}

function formatHour(h: string): string {
  const n = parseInt(h, 10);
  if (isNaN(n)) return h;
  const suffix = n >= 12 ? "PM" : "AM";
  const h12 = n === 0 ? 12 : n > 12 ? n - 12 : n;
  return `${h12} ${suffix}`;
}

export function getNextRun(expr: string): Date | null {
  if (!validateCron(expr)) return null;

  const parts = expr.trim().split(/\s+/);
  const [minExpr, hourExpr, domExpr, monthExpr, dowExpr] = parts;

  const now = new Date();
  const check = new Date(now.getTime() + 60_000);
  check.setSeconds(0, 0);

  const maxIterations = 525_960;
  for (let i = 0; i < maxIterations; i++) {
    const min = check.getMinutes();
    const hour = check.getHours();
    const dom = check.getDate();
    const month = check.getMonth() + 1;
    const dow = check.getDay();

    if (
      matchField(minExpr, min) &&
      matchField(hourExpr, hour) &&
      matchField(domExpr, dom) &&
      matchField(monthExpr, month) &&
      matchField(dowExpr, dow)
    ) {
      return check;
    }

    check.setMinutes(check.getMinutes() + 1);
  }

  return null;
}

function matchField(expr: string, value: number): boolean {
  if (expr === "*") return true;

  const segments = expr.split(",");
  return segments.some((seg) => {
    const stepMatch = seg.match(/^(\*|\d+(?:-\d+)?)\/(\d+)$/);
    if (stepMatch) {
      const step = parseInt(stepMatch[2], 10);
      if (stepMatch[1] === "*") return value % step === 0;
      const rangeMatch = stepMatch[1].match(/^(\d+)-(\d+)$/);
      if (rangeMatch) {
        const start = parseInt(rangeMatch[1], 10);
        const end = parseInt(rangeMatch[2], 10);
        return value >= start && value <= end && (value - start) % step === 0;
      }
      const single = parseInt(stepMatch[1], 10);
      return value >= single && (value - single) % step === 0;
    }

    const rangeMatch = seg.match(/^(\d+)-(\d+)$/);
    if (rangeMatch) {
      const a = parseInt(rangeMatch[1], 10);
      const b = parseInt(rangeMatch[2], 10);
      return value >= a && value <= b;
    }

    return parseInt(seg, 10) === value;
  });
}
