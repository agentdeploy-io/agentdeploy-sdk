/// <reference types="@cloudflare/workers-types" />

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

class CfSqlStatement {
  private sql: SqlStorage;
  private query: string;

  constructor(sql: SqlStorage, query: string) {
    this.sql = sql;
    this.query = query;
  }

  run(...params: unknown[]): RunResult {
    const cursor = this.sql.exec(this.query, ...params);
    const _rows = cursor.toArray();
    const changes = cursor.rowsWritten;
    let lastInsertRowid = 0;
    try {
      const ridCursor = this.sql.exec("SELECT last_insert_rowid() as id");
      const rows = ridCursor.toArray();
      if (rows.length > 0) {
        lastInsertRowid = Number((rows[0] as Record<string, unknown>).id ?? 0);
      }
    } catch {
      // ignore
    }
    return { changes, lastInsertRowid };
  }

  get(...params: unknown[]): unknown | undefined {
    const cursor = this.sql.exec(this.query, ...params);
    const rows = cursor.toArray();
    return rows[0] ?? undefined;
  }

  all(...params: unknown[]): unknown[] {
    const cursor = this.sql.exec(this.query, ...params);
    return cursor.toArray();
  }
}

export class CfSqlDatabase {
  private sql: SqlStorage;

  constructor(sql: SqlStorage) {
    this.sql = sql;
  }

  exec(query: string): this {
    this.sql.exec(query);
    return this;
  }

  prepare(query: string): CfSqlStatement {
    return new CfSqlStatement(this.sql, query);
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const self = this;
    return ((...args: unknown[]) => {
      self.sql.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(...args);
        self.sql.exec("COMMIT");
        return result;
      } catch (e) {
        self.sql.exec("ROLLBACK");
        throw e;
      }
    }) as unknown as T;
  }

  close(): void {
    // no-op for CF DO SQLite
  }
}
