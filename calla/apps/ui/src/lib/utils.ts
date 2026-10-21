import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function relativeTime(dateStr: string | number | Date): string {
  const d = new Date(dateStr);
  const diff = Date.now() - d.getTime();
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

export function timeUntil(dateStr: string | number | Date): string {
  const diff = new Date(dateStr).getTime() - Date.now();
  if (diff <= 0) return "expired";
  const min = Math.floor(diff / 60000);
  if (min < 60) return `${min}m remaining`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h remaining`;
  return `${Math.floor(hr / 24)}d remaining`;
}

/**
 * Convert a hex color (#rgb / #rrggbb, with or without "#") into the HSL
 * triplet string format the design tokens use ("216 76% 47%"). Returns null
 * for anything that isn't a valid hex color so callers can skip safely.
 */
export function hexToHslTriplet(hex: string): string | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!match) return null;
  let digits = match[1];
  if (digits.length === 3) {
    digits = digits
      .split("")
      .map((c) => c + c)
      .join("");
  }
  const r = parseInt(digits.slice(0, 2), 16) / 255;
  const g = parseInt(digits.slice(2, 4), 16) / 255;
  const b = parseInt(digits.slice(4, 6), 16) / 255;

  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  let h = 0;
  let s = 0;
  if (max !== min) {
    const d = max - min;
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return `${Math.round(h)} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
}

/** "property_type" → "Property Type" — for humanizing flow field names. */
export function humanizeFieldName(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const DUBLIN_TZ = "Europe/Dublin";

let dublinFormatter: Intl.DateTimeFormat | null = null;

/** e.g. "Mon, 06 Oct 2025, 14:30" — always in Europe/Dublin. */
export function formatDublinTime(value: string | number | Date): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value) || "-";
  try {
    dublinFormatter ??= new Intl.DateTimeFormat("en-IE", {
      timeZone: DUBLIN_TZ,
      weekday: "short",
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    return dublinFormatter.format(date);
  } catch {
    // Runtime without the tz database — honest local time beats a crash.
    return date.toLocaleString();
  }
}
