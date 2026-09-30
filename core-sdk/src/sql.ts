import Database from "better-sqlite3";
import type { SqlExecutor } from "./types.js";
import { join } from "node:path";

class SqliteExecutor implements SqlExecutor {
  private db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
  }

  run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

let instance: SqliteExecutor | null = null;

export function createSqlExecutor(dataDir?: string): SqlExecutor {
  if (instance) return instance;
  const dir = dataDir || process.env["DATA_DIR"] || "/data";
  const dbPath = join(dir, "agent.db");
  instance = new SqliteExecutor(dbPath);
  return instance;
}

export function taggedSql(strings: TemplateStringsArray, ...values: unknown[]): void {
  const sql = strings.reduce((acc, str, i) => acc + str + (values[i] !== undefined ? `?` : ""), "");
  const executor = createSqlExecutor();
  executor.run(sql, ...values);
}
