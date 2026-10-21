/**
 * Hash-chained audit log primitives.
 *
 * SQL equivalent of the @thirtieth/elizaos-plugin-cloudflare audit-log
 * (MIT, (c) 2026 thirtieth): every entry carries {seq, ts, kind, entry,
 * prev_hash, entry_hash}, the chain is rooted at GENESIS, and verifyAudit()
 * recomputes every hash to detect tampering or gaps.
 *
 * Hashing is over a canonical JSON form (stableStringify — recursive key
 * sort) so the hash survives storage round-trips through Postgres jsonb
 * (which does not preserve key order).
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "GENESIS";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Canonical JSON: object keys sorted recursively; arrays keep their order. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(",")}}`;
}

/** Fields covered by the entry hash (canonical, key-sorted). */
export interface AuditHashInput {
  seq: number;
  ts: string;
  agentId: string | null;
  kind: string;
  entry: Record<string, unknown>;
  prevHash: string;
}

export function computeEntryHash(input: AuditHashInput): string {
  return sha256Hex(
    stableStringify({
      seq: input.seq,
      ts: input.ts,
      agentId: input.agentId ?? null,
      kind: input.kind,
      entry: input.entry,
      prevHash: input.prevHash,
    }),
  );
}

/** One persisted audit row (dialect-normalized: ts ISO string, entry object). */
export interface AuditRecord {
  seq: number;
  ts: string;
  agentId: string | null;
  kind: string;
  entry: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface AuditRowInput {
  seq: number;
  ts: string;
  agentId: string | null;
  kind: string;
  entry: Record<string, unknown>;
  prevHash: string;
  entryHash: string;
}

export interface GetAuditOptions {
  limit?: number;
  agentId?: string;
  kind?: string;
  /** "desc" (newest first) is the default for API reads; verify uses "asc". */
  order?: "asc" | "desc";
}

/** The low-level audit primitives a CallaStore must provide. */
export interface AuditLogStore {
  getAuditTail(): Promise<{ seq: number; entryHash: string } | null>;
  insertAuditRow(row: AuditRowInput): Promise<AuditRecord>;
  getAudit(options?: GetAuditOptions): Promise<AuditRecord[]>;
}

export interface AppendAuditInput {
  agentId?: string | null;
  kind: string;
  entry: Record<string, unknown>;
}

export interface VerifyAuditResult {
  valid: boolean;
  count: number;
  /** seq of the first row whose linkage or hash did not verify. */
  brokenAt?: number;
}

/**
 * In-process append serialization: two concurrent appends must not read the
 * same tail and collide on seq. Appends are cheap and rare; a promise queue
 * is enough for a single brain process.
 */
let appendQueue: Promise<unknown> = Promise.resolve();

/**
 * Append an entry to the hash chain: read the tail, link prevHash to the
 * tail's entryHash (GENESIS for the first row), compute the new entryHash
 * over the canonical form, insert with the explicit next seq.
 */
export function appendAudit(store: AuditLogStore, input: AppendAuditInput): Promise<AuditRecord> {
  const run = appendQueue.then(async () => {
    const tail = await store.getAuditTail();
    const seq = (tail?.seq ?? 0) + 1;
    const ts = new Date().toISOString();
    const prevHash = tail?.entryHash ?? GENESIS_HASH;
    const agentId = input.agentId ?? null;
    const entryHash = computeEntryHash({ seq, ts, agentId, kind: input.kind, entry: input.entry, prevHash });
    return store.insertAuditRow({ seq, ts, agentId, kind: input.kind, entry: input.entry, prevHash, entryHash });
  });
  // Keep the queue alive even when an append fails.
  appendQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Walk the chain from GENESIS and recompute every entry hash.
 * Returns {valid, count, brokenAt?} — never throws for a broken chain.
 */
export async function verifyAudit(store: AuditLogStore): Promise<VerifyAuditResult> {
  const rows = await store.getAudit({ order: "asc" });
  let prevHash = GENESIS_HASH;
  let expectedSeq = 1;
  for (const row of rows) {
    if (row.seq !== expectedSeq || row.prevHash !== prevHash) {
      return { valid: false, count: rows.length, brokenAt: row.seq };
    }
    const recomputed = computeEntryHash({
      seq: row.seq,
      ts: row.ts,
      agentId: row.agentId,
      kind: row.kind,
      entry: row.entry,
      prevHash: row.prevHash,
    });
    if (recomputed !== row.entryHash) {
      return { valid: false, count: rows.length, brokenAt: row.seq };
    }
    prevHash = row.entryHash;
    expectedSeq += 1;
  }
  return { valid: true, count: rows.length };
}
