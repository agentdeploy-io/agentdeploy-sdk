import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import {
  SCHEMA_V1,
  runMigrations,
  listVerticals,
  getVertical,
  getDefaultVertical,
  upsertVertical,
  deleteVertical,
  type Vertical,
} from "../db/index.js";
import { crawlCron } from "../cron/crawl.js";

function initDb(): Database.Database {
  const db = new Database(":memory:");
  db.exec(SCHEMA_V1);
  runMigrations(db);
  return db;
}

function sample(over: Partial<Vertical> = {}): Vertical {
  return {
    id: "v-test",
    name: "UK Web Agencies",
    icp: "Small UK web agencies",
    countries: ["uk"],
    dorks: ['"web design" site:co.uk'],
    requireWebsite: true,
    useRegistry: true,
    llmEnrich: true,
    mxGuess: true,
    minScore: 50,
    perCountryLimit: 5,
    isDefault: false,
    ...over,
  };
}

describe("verticals CRUD", () => {
  it("upsert, list, get round-trip the pack", () => {
    const db = initDb();
    expect(listVerticals(db)).toEqual([]);
    upsertVertical(db, sample());
    const all = listVerticals(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ id: "v-test", name: "UK Web Agencies", minScore: 50, perCountryLimit: 5, isDefault: false });
    expect(getVertical(db, "v-test")?.dorks).toEqual(['"web design" site:co.uk']);
    expect(getVertical(db, "nope")).toBeNull();
    db.close();
  });

  it("updates an existing pack in place", () => {
    const db = initDb();
    upsertVertical(db, sample());
    upsertVertical(db, sample({ minScore: 70, name: "Renamed" }));
    const all = listVerticals(db);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ name: "Renamed", minScore: 70 });
    db.close();
  });

  it("clears the previous default when a new one is set", () => {
    const db = initDb();
    upsertVertical(db, sample({ id: "v-a", isDefault: true }));
    upsertVertical(db, sample({ id: "v-b", isDefault: true }));
    expect(getDefaultVertical(db)?.id).toBe("v-b");
    expect(listVerticals(db).filter((v) => v.isDefault)).toHaveLength(1);
    db.close();
  });

  it("deleteVertical removes and reports false for unknown ids", () => {
    const db = initDb();
    upsertVertical(db, sample());
    expect(deleteVertical(db, "v-test")).toBe(true);
    expect(deleteVertical(db, "v-test")).toBe(false);
    expect(listVerticals(db)).toHaveLength(0);
    db.close();
  });

  it("survives corrupt config JSON with safe defaults", () => {
    const db = initDb();
    db.prepare("INSERT INTO verticals (id, name, config, is_default) VALUES (?, ?, ?, 0)").run(
      "v-bad", "Broken", "{not json"
    );
    const v = getVertical(db, "v-bad");
    expect(v).toMatchObject({ id: "v-bad", countries: [], dorks: [], minScore: 50, requireWebsite: true });
    db.close();
  });
});

describe("crawlCron vertical handoff", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => new Response(JSON.stringify({ taskId: "t1", state: "queued" }), { status: 202 }));
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends the vertical pack in the handoff body when verticalId is given", async () => {
    const db = initDb();
    upsertVertical(db, sample({ perCountryLimit: 4, countries: ["uk", "ie"] }));
    const res = await crawlCron({ CORE_URL: "http://core.test" }, db, { verticalId: "v-test", trigger: "manual" });
    expect(res.state).toBe("succeeded");
    const call = fetchSpy.mock.calls[0]!;
    expect(call[0]).toBe("http://core.test/v1/handoff");
    const body = JSON.parse((call[1] as { body: string }).body);
    expect(body.vertical).toMatchObject({ id: "v-test", name: "UK Web Agencies", perCountryLimit: 4 });
    expect(body.countries).toEqual(["uk", "ie"]);
    expect(body.limit).toBe(8); // perCountryLimit × countries
    expect(body.trigger).toBe("manual");
    db.close();
  });

  it("uses the default vertical when no verticalId is given", async () => {
    const db = initDb();
    upsertVertical(db, sample({ id: "v-def", isDefault: true }));
    await crawlCron({ CORE_URL: "http://core.test" }, db);
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body);
    expect(body.vertical?.id).toBe("v-def");
    db.close();
  });

  it("falls back to the legacy countries setting when no vertical exists", async () => {
    const db = initDb();
    db.prepare("INSERT INTO settings (key, value) VALUES ('countries', 'Ireland'), ('crawlLimit', '30')").run();
    const res = await crawlCron({ CORE_URL: "http://core.test" }, db);
    expect(res.state).toBe("succeeded");
    const body = JSON.parse((fetchSpy.mock.calls[0]![1] as { body: string }).body);
    expect(body.vertical).toBeUndefined();
    expect(body.countries).toEqual(["ie"]);
    expect(body.limit).toBe(30);
    db.close();
  });

  it("fails loudly when the selected vertical has an unsupported country", async () => {
    const db = initDb();
    upsertVertical(db, sample({ countries: ["spain"] }));
    const res = await crawlCron({ CORE_URL: "http://core.test" }, db, { verticalId: "v-test" });
    expect(res.state).toBe("failed");
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });
});
