// Cron expressions are evaluated in the runtime's local time — UTC on
// Workers (production) and in the workerd dev sandbox. Pin UTC here so the
// test suite is deterministic regardless of the host timezone.
process.env.TZ = "UTC";

import { describe, it, expect } from "vitest";
import { isValidCron, cronMatches, cronWasDue } from "../services/cron-match.js";

const at = (iso: string) => new Date(iso);

describe("cron-match", () => {
  describe("isValidCron", () => {
    it("accepts the default schedules", () => {
      expect(isValidCron("0 1 * * *")).toBe(true);
      expect(isValidCron("*/30 * * * *")).toBe(true);
      expect(isValidCron("*/15 * * * *")).toBe(true);
      expect(isValidCron("0 3 * * *")).toBe(true);
    });

    it("accepts lists, ranges and steps", () => {
      expect(isValidCron("0,30 9-17 * * 1-5")).toBe(true);
      expect(isValidCron("5/15 * * * *")).toBe(true);
      expect(isValidCron("*/5 * * * 7")).toBe(true);
    });

    it("rejects malformed expressions", () => {
      expect(isValidCron("")).toBe(false);
      expect(isValidCron("* * * *")).toBe(false);
      expect(isValidCron("* * * * * *")).toBe(false);
      expect(isValidCron("60 * * * *")).toBe(false);
      expect(isValidCron("* 24 * * *")).toBe(false);
      expect(isValidCron("0 0 32 * *")).toBe(false);
      expect(isValidCron("*/0 * * * *")).toBe(false);
      expect(isValidCron("a * * * *")).toBe(false);
      expect(isValidCron("5-1 * * * *")).toBe(false);
    });
  });

  describe("cronMatches", () => {
    it("matches an exact minute/hour", () => {
      expect(cronMatches("0 1 * * *", at("2026-10-21T01:00:00Z"))).toBe(true);
      expect(cronMatches("0 1 * * *", at("2026-10-21T01:01:00Z"))).toBe(false);
      expect(cronMatches("0 1 * * *", at("2026-10-21T02:00:00Z"))).toBe(false);
    });

    it("matches star-steps", () => {
      expect(cronMatches("*/15 * * * *", at("2026-10-21T10:00:00Z"))).toBe(true);
      expect(cronMatches("*/15 * * * *", at("2026-10-21T10:15:00Z"))).toBe(true);
      expect(cronMatches("*/15 * * * *", at("2026-10-21T10:16:00Z"))).toBe(false);
      expect(cronMatches("*/30 * * * *", at("2026-10-21T10:30:00Z"))).toBe(true);
    });

    it("matches ranges and lists", () => {
      expect(cronMatches("0,30 9-17 * * 1-5", at("2026-10-21T09:30:00Z"))).toBe(true); // Wed
      expect(cronMatches("0,30 9-17 * * 1-5", at("2026-10-21T18:00:00Z"))).toBe(false); // 18h out of range
      expect(cronMatches("0,30 9-17 * * 1-5", at("2026-10-25T09:00:00Z"))).toBe(false); // Sun
    });

    it("treats dow 7 as Sunday", () => {
      expect(cronMatches("0 0 * * 7", at("2026-10-25T00:00:00Z"))).toBe(true); // Sun
      expect(cronMatches("0 0 * * 0", at("2026-10-25T00:00:00Z"))).toBe(true); // Sun
    });

    it("dom/dow: both restricted → OR semantics", () => {
      // 13th of the month OR a Friday
      expect(cronMatches("0 0 13 * 5", at("2026-10-16T00:00:00Z"))).toBe(true); // Fri
      expect(cronMatches("0 0 13 * 5", at("2026-10-13T00:00:00Z"))).toBe(true); // Tue 13th
      expect(cronMatches("0 0 13 * 5", at("2026-10-15T00:00:00Z"))).toBe(false);
    });
  });

  describe("cronWasDue", () => {
    it("fires when a matching minute falls inside (from, to]", () => {
      // window 10:00 → 10:05 contains 10:00? no (open at from) — use 09:59→10:05
      expect(cronWasDue("0 10 * * *", Date.parse("2026-10-21T09:59:00Z"), Date.parse("2026-10-21T10:05:00Z"))).toBe(true);
      expect(cronWasDue("0 10 * * *", Date.parse("2026-10-21T10:00:00Z"), Date.parse("2026-10-21T10:05:00Z"))).toBe(false);
    });

    it("does not fire when nothing matched in the window", () => {
      expect(cronWasDue("0 10 * * *", Date.parse("2026-10-21T10:01:00Z"), Date.parse("2026-10-21T10:06:00Z"))).toBe(false);
      expect(cronWasDue("*/30 * * * *", Date.parse("2026-10-21T10:01:00Z"), Date.parse("2026-10-21T10:29:00Z"))).toBe(false);
      expect(cronWasDue("*/30 * * * *", Date.parse("2026-10-21T10:01:00Z"), Date.parse("2026-10-21T10:30:00Z"))).toBe(true);
    });

    it("catches up after a 5-minute tick alignment offset", () => {
      // daily 01:00; last run yesterday 01:00, now 01:03 → due
      expect(cronWasDue("0 1 * * *", Date.parse("2026-10-20T01:00:00Z"), Date.parse("2026-10-21T01:03:00Z"))).toBe(true);
      // already ran today → not due again
      expect(cronWasDue("0 1 * * *", Date.parse("2026-10-21T01:00:00Z"), Date.parse("2026-10-21T01:05:00Z"))).toBe(false);
    });

    it("collapses huge gaps to a single check at to", () => {
      const from = Date.parse("2026-01-01T00:00:00Z");
      const to = Date.parse("2026-10-21T01:00:00Z");
      expect(cronWasDue("0 1 * * *", from, to)).toBe(true);
      const to2 = Date.parse("2026-10-21T01:30:00Z");
      expect(cronWasDue("0 1 * * *", from, to2)).toBe(false);
    });

    it("returns false for empty/zero-length windows", () => {
      expect(cronWasDue("* * * * *", 100, 100)).toBe(false);
      expect(cronWasDue("* * * * *", 200, 100)).toBe(false);
    });
  });
});
