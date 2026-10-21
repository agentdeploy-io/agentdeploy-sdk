import { describe, it, expect } from 'vitest';
import { CfSqlDatabase } from '../db/cf-sqlite.js';

function fixture() {
  const calls: unknown[][] = [];
  const sql = { exec(...args: unknown[]) { calls.push(args); return { toArray: () => [{ id: 1 }], rowsWritten: 1 }; } } as unknown as SqlStorage;
  let transactions = 0;
  const db = new CfSqlDatabase(sql, callback => { transactions++; return callback(); });
  return { db, calls, transactions: () => transactions };
}
describe('CF SQLite adapter', () => {
  it('uses native transactionSync, with no raw BEGIN/COMMIT or swallowed errors', () => {
    const f = fixture();
    expect(f.db.transaction(() => 42)()).toBe(42);
    expect(() => f.db.transaction(() => { throw new Error('rollback'); })()).toThrow('rollback');
    expect(f.transactions()).toBe(2); expect(f.calls).toEqual([]);
    expect(() => new CfSqlDatabase({} as SqlStorage).transaction(() => 1)).toThrow('transactionSync');
  });
  it('translates repeated named parameters but not quoted strings, identifiers or comments', () => {
    const f = fixture();
    f.db.prepare("SELECT '@not', \"@identifier\", `:column`, [$col] FROM leads WHERE id=@id OR parent=:id -- @comment\n /* $comment */ AND tag=$tag").all({ id: 5, tag: 'safe' });
    expect(f.calls[0]).toEqual(["SELECT '@not', \"@identifier\", `:column`, [$col] FROM leads WHERE id=? OR parent=? -- @comment\n /* $comment */ AND tag=?", 5, 5, 'safe']);
  });
  it('keeps positional arguments and rejects missing or inherited named bindings', () => {
    const f = fixture(); f.db.prepare('SELECT ?').get('x'); expect(f.calls[0]).toEqual(['SELECT ?', 'x']);
    expect(() => f.db.prepare('SELECT @missing').get({})).toThrow('Missing SQL binding');
    expect(() => f.db.prepare('SELECT @inherited').get(Object.create({ inherited: 'not-owned' }))).toThrow('Missing SQL binding');
  });
});
