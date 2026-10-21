/// <reference types="@cloudflare/workers-types" />

interface RunResult {
  changes: number;
  lastInsertRowid: number;
}

type TransactionSync = <T>(callback: () => T) => T;

function positional(query: string, params: unknown[]): { query: string; params: unknown[] } {
  const values = params.length === 1 ? params[0] : undefined;
  if (!values || typeof values !== 'object' || Array.isArray(values) || values instanceof ArrayBuffer || ArrayBuffer.isView(values)) return { query, params };
  const record = values as Record<string, unknown>;
  const bindings: unknown[] = [];
  // Translate named bindings without touching quoted text, identifiers or SQL
  // comments. CF sql.exec only accepts positional arguments, unlike SQLite's
  // Node drivers. A missing binding must not silently become SQL NULL.
  const rewritten = query.replace(/'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\]|--[^\n]*|\/\*[\s\S]*?\*\/|([@:$][A-Za-z_][A-Za-z0-9_]*)/g, (token, parameter: string | undefined) => {
    if (!parameter) return token;
    const name = parameter.slice(1);
    if (!Object.prototype.hasOwnProperty.call(record, name)) throw new Error(`Missing SQL binding: ${name}`);
    bindings.push(record[name]); return '?';
  });
  return { query: rewritten, params: bindings };
}

class CfSqlStatement {
  private sql: SqlStorage;
  private query: string;

  constructor(sql: SqlStorage, query: string) {
    this.sql = sql;
    this.query = query;
  }

  run(...params: unknown[]): RunResult {
    const bound = positional(this.query, params);
    const cursor = this.sql.exec(bound.query, ...bound.params);
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
    const bound = positional(this.query, params);
    const cursor = this.sql.exec(bound.query, ...bound.params);
    const rows = cursor.toArray();
    return rows[0] ?? undefined;
  }

  all(...params: unknown[]): unknown[] {
    const bound = positional(this.query, params);
    const cursor = this.sql.exec(bound.query, ...bound.params);
    return cursor.toArray();
  }
}

export class CfSqlDatabase {
  private sql: SqlStorage;
  private transact?: TransactionSync;

  constructor(sql: SqlStorage, transact?: TransactionSync) {
    this.sql = sql;
    this.transact = transact;
  }

  exec(query: string): this {
    this.sql.exec(query);
    return this;
  }

  prepare(query: string): CfSqlStatement {
    return new CfSqlStatement(this.sql, query);
  }

  transaction<T extends (...args: unknown[]) => unknown>(fn: T): T {
    const transact = this.transact;
    if (!transact) throw new Error('CfSqlDatabase requires Durable Object storage.transactionSync');
    return ((...args: unknown[]) => transact(() => fn(...args))) as unknown as T;
  }

  close(): void {
    // no-op for CF DO SQLite
  }
}
