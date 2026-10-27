import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { isLinkFailed, markLinkFailed, linkCacheSize } from "../pipeline/negative-cache.js";

describe("negative link cache", () => {
  let dir: string;
  let prevDataDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "link-cache-"));
    prevDataDir = process.env["DATA_DIR"];
    process.env["DATA_DIR"] = dir;
  });

  afterEach(() => {
    if (prevDataDir === undefined) delete process.env["DATA_DIR"];
    else process.env["DATA_DIR"] = prevDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("remembers a failed link and reports it on the next run", () => {
    expect(isLinkFailed("06029114")).toBe(false);
    markLinkFailed("06029114");
    expect(isLinkFailed("06029114")).toBe(true);
    expect(isLinkFailed("99999999")).toBe(false);
  });

  it("expires entries after the 30d TTL", () => {
    markLinkFailed("06029114");
    const file = path.join(dir, "link-cache.json");
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { at: number }> };
    c.entries["06029114"]!.at = Date.now() - 31 * 86_400_000;
    fs.writeFileSync(file, JSON.stringify(c));
    expect(isLinkFailed("06029114")).toBe(false);
    expect(linkCacheSize()).toBe(0);
  });

  it("falls back to no cache on a corrupt file", () => {
    fs.writeFileSync(path.join(dir, "link-cache.json"), "{not json");
    expect(isLinkFailed("06029114")).toBe(false);
    markLinkFailed("06029114"); // rewrites the file cleanly
    expect(isLinkFailed("06029114")).toBe(true);
  });

  it("prunes expired entries on write", () => {
    markLinkFailed("0001");
    markLinkFailed("0002");
    const file = path.join(dir, "link-cache.json");
    const c = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { at: number }> };
    c.entries["0001"]!.at = Date.now() - 60 * 86_400_000;
    fs.writeFileSync(file, JSON.stringify(c));
    markLinkFailed("0003");
    const after = JSON.parse(fs.readFileSync(file, "utf8")) as { entries: Record<string, { at: number }> };
    expect(Object.keys(after.entries).sort()).toEqual(["0002", "0003"]);
  });
});
