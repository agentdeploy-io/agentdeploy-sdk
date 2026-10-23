// Scraper smoke-test runner. Spawned as a separate node process by
// src/scraper/service.ts with argv[2] = JSON { code, pack, country, limit, env }.
// Runs the generated module inside a node:vm context that exposes only safe
// globals (no require/process/fs), then calls discover(ctx) once and prints a
// single line: SCRAPER_OK <json hits>  |  SCRAPER_FAIL <message>.

import * as vm from "node:vm";
import { pipelineSearch } from "../pipeline/search.js";
import type { VerticalPack } from "../pipeline/types.js";

interface Payload {
  code: string;
  pack: VerticalPack;
  country: string;
  limit: number;
  env: Record<string, string | undefined>;
}

function fail(msg: string): never {
  process.stdout.write(`SCRAPER_FAIL ${msg.replace(/\n/g, " ")}\n`);
  process.exit(1);
}

const hardKill = setTimeout(() => fail("timeout (60s)"), 60_000);
hardKill.unref();

try {
  const payload = JSON.parse(process.argv[2] ?? "{}") as Payload;
  if (!payload.code) fail("no code in payload");

  // Keep only defined string values so we satisfy pipelineSearch's env type.
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload.env)) if (typeof v === "string") env[k] = v;

  const drops: Record<string, number> = {};
  const ctx = {
    pack: payload.pack,
    country: payload.country,
    env,
    limit: payload.limit,
    drops,
    search: (query: string) => pipelineSearch(query, payload.pack, env),
  };

  const mod = { exports: {} as Record<string, unknown> };
  const sandbox: Record<string, unknown> = {
    console: {
      log: (...a: unknown[]) => process.stderr.write(a.map(String).join(" ") + "\n"),
      error: (...a: unknown[]) => process.stderr.write("ERR " + a.map(String).join(" ") + "\n"),
    },
    fetch,
    URL,
    AbortSignal,
    TextDecoder,
    TextEncoder,
    setTimeout: (fn: () => void, ms?: number) => setTimeout(fn, Math.min(ms ?? 0, 5_000)),
    clearTimeout,
    require: () => {
      throw new Error("require() is not available in scrapers");
    },
    module: mod,
    exports: mod.exports,
    ctx,
  };
  const context = vm.createContext(sandbox);
  new vm.Script(payload.code, { filename: "scraper.js" }).runInContext(context, { timeout: 5_000 });

  const discover = (mod.exports as { discover?: unknown }).discover;
  if (typeof discover !== "function") fail("module does not export discover(ctx)");

  interface Hit {
    url?: unknown;
    title?: unknown;
    description?: unknown;
  }
  Promise.resolve((discover as (c: unknown) => Promise<Hit[]>)(ctx))
    .then((hits) => {
      if (!Array.isArray(hits)) throw new Error("discover() must return an array of {url,title,description}");
      const out = hits
        .filter((h) => h && typeof h.url === "string" && typeof h.title === "string")
        .slice(0, 25)
        .map((h) => ({ url: h.url as string, title: h.title as string, description: typeof h.description === "string" ? h.description : "" }));
      process.stdout.write(`SCRAPER_OK ${JSON.stringify(out)}\n`);
      process.exit(0);
    })
    .catch((e) => fail(e instanceof Error ? e.message : String(e)));
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
}
