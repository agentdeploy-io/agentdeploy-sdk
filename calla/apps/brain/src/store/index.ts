/**
 * Calla durable store — selection, singleton, bootstrap.
 *
 * Selection is CONNECTION-STRING-PRESENCE driven (pattern adapted from
 * @elizaos/plugin-sql, MIT, (c) 2025 Shaw Walters and elizaOS Contributors —
 * NOT NODE_ENV driven): isRealPostgresUrl(DATABASE_URL) → DrizzlePgStore;
 * otherwise LibSqlStore at LIBSQL_URL ?? "file:local.db". The store is a
 * process-global singleton keyed by Symbol.for("calla.store") so the server,
 * evaluators, and scripts all share one connection/DDL bootstrap.
 */
import { isRealPostgresUrl } from "./pg-url.js";
import { DrizzlePgStore } from "./pg-store.js";
import { LibSqlStore } from "./libsql-store.js";
import type { CallaStore, CallaStoreKind } from "./types.js";

export * from "./types.js";
export * from "./hashchain.js";
export * from "./pg-url.js";
export {
  callaAgents,
  callaAgentConfigs,
  callaApprovals,
  callaAudit,
  callaCache,
  callaSkills,
  callaUsers,
} from "./schema.js";
export { DrizzlePgStore } from "./pg-store.js";
export { LibSqlStore } from "./libsql-store.js";

export interface StoreSelection {
  kind: CallaStoreKind;
  /** Postgres DSN (redacted in logs) or libsql url. */
  url: string;
}

/** Which Calla store adapter the environment selects (pure, no side effects). */
export function selectCallaStore(): StoreSelection {
  const databaseUrl = process.env.DATABASE_URL;
  if (isRealPostgresUrl(databaseUrl)) {
    return { kind: "pg", url: databaseUrl as string };
  }
  return { kind: "libsql", url: process.env.LIBSQL_URL || "file:local.db" };
}

const STORE_KEY = Symbol.for("calla.store");

type GlobalWithCallaStore = typeof globalThis & { [STORE_KEY]?: CallaStore };

function createCallaStore(selection: StoreSelection): CallaStore {
  return selection.kind === "pg"
    ? new DrizzlePgStore(selection.url)
    : new LibSqlStore(selection.url);
}

/**
 * Process-global singleton (Symbol.for keyed, ElizaOS connection-manager
 * style). Construction kicks off the idempotent bootstrap() immediately;
 * every store method awaits it internally, so fire-and-forget callers
 * (evaluators) are safe even before initCallaStore() resolves.
 */
export function getCallaStore(): CallaStore {
  const g = globalThis as GlobalWithCallaStore;
  if (!g[STORE_KEY]) {
    g[STORE_KEY] = createCallaStore(selectCallaStore());
  }
  return g[STORE_KEY];
}

/** Await the store's DDL bootstrap once at server start. */
export async function initCallaStore(): Promise<CallaStore> {
  const store = getCallaStore();
  await store.bootstrap();
  return store;
}
