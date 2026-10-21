/**
 * Dev-only entry shim for running packages/bi-edge under `wrangler dev`.
 *
 * bi-edge's src/index.ts cannot boot under workerd as-is, so this shim fixes
 * three things WITHOUT touching bi-edge source (all dev-local, documented):
 *
 * 1. `export * from "./db/index.js"` re-exports non-handler values
 *    (SCHEMA_V1, runMigrations, …) → workerd rejects the module
 *    ("Incorrect type for map entry 'SCHEMA_V1'"). We re-export only the
 *    worker default + DO classes.
 *
 * 2. CfSqlDatabase.transaction() issues `BEGIN IMMEDIATE`, which DO SQLite
 *    forbids ("use state.storage.transaction() instead") — runMigrations()
 *    and upsertSyncBatch() throw inside the DO. Passthrough is safe locally:
 *    each DO request already gets automatic atomic write coalescing.
 *
 * 3. This workerd build does not bind object-style named parameters in
 *    sql.exec (`exec(sql, {a: 1})` for `@a` silently matches nothing /
 *    errors with "Wrong number of parameter bindings"). We rewrite
 *    `@name`/`:name` tokens to positional `?` and pass values in order.
 *
 * Upstream fixes belong in packages/bi-edge/src/db/cf-sqlite.ts.
 *
 * Run from packages/bi-edge:
 *   wrangler dev ../calla/scripts/bi-edge-dev-entry.ts --config wrangler.toml \
 *     --port 8792 --ip 127.0.0.1 --persist-to /tmp/calla-bi-edge-state
 */
import worker, { BiEdgeAgent, Supervisor, CfSqlDatabase } from "../../bi-edge/src/index.js";

type AnyFn = (...args: unknown[]) => unknown;

const proto = CfSqlDatabase.prototype as unknown as {
  transaction: unknown;
  prepare: unknown;
};

// (2) transactions → passthrough wrapper (better-sqlite3-style API).
proto.transaction = function (fn: AnyFn): AnyFn {
  return fn;
};

function toPositional(query: string, args: unknown[]): { sql: string; values: unknown[] } {
  const single = args.length === 1 ? args[0] : undefined;
  if (
    single === null ||
    typeof single !== "object" ||
    Array.isArray(single) ||
    single instanceof ArrayBuffer
  ) {
    return { sql: query, values: args };
  }
  const obj = single as Record<string, unknown>;
  const values: unknown[] = [];
  // SQLite named params: @name / :name / $name (bi-edge uses @name only).
  const sql = query.replace(/[@:$]([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    values.push(obj[name] ?? null);
    return "?";
  });
  return { sql, values };
}

// (3) prepare() → statements that translate named-object bindings.
proto.prepare = function (this: { sql: SqlStorage }, query: string) {
  const storage = this.sql;
  const exec = (params: unknown[]): SqlStorageCursor => {
    const { sql, values } = toPositional(query, params);
    return storage.exec(sql, ...values);
  };
  return {
    run(...params: unknown[]) {
      const cursor = exec(params);
      cursor.toArray();
      const changes = cursor.rowsWritten;
      let lastInsertRowid = 0;
      try {
        const rows = storage.exec("SELECT last_insert_rowid() as id").toArray();
        if (rows.length > 0) {
          lastInsertRowid = Number((rows[0] as { id?: unknown }).id ?? 0);
        }
      } catch {
        // ignore
      }
      return { changes, lastInsertRowid };
    },
    get(...params: unknown[]) {
      return exec(params).toArray()[0];
    },
    all(...params: unknown[]) {
      return exec(params).toArray();
    },
  };
};

export default worker;
export { BiEdgeAgent, Supervisor };
