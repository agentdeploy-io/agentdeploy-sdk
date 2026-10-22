import type Database from "better-sqlite3";

export interface LlmTrace {
  id: number;
  stage: string;
  lead_key: string | null;
  model: string | null;
  prompt_excerpt: string | null;
  raw_response: string | null;
  latency_ms: number | null;
  at: string;
}

const INSERT = `
  INSERT INTO llm_traces (stage, lead_key, model, prompt_excerpt, raw_response, latency_ms, at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`;
const TRIM = `DELETE FROM llm_traces WHERE id NOT IN (SELECT id FROM llm_traces ORDER BY id DESC LIMIT 200)`;
const SELECT_RECENT = `SELECT * FROM llm_traces ORDER BY id DESC LIMIT ?`;

/**
 * Record one LLM call for the "Thinking" debug view. Never throws — a trace
 * failure must not break the pipeline. Kept to the most recent 200 rows.
 */
export function logLlmTrace(
  db: Database.Database,
  trace: {
    stage: string;
    leadKey?: string | null;
    model?: string | null;
    promptExcerpt?: string | null;
    rawResponse?: string | null;
    latencyMs?: number | null;
  }
): void {
  try {
    db.prepare(INSERT).run(
      trace.stage,
      trace.leadKey ?? null,
      trace.model ?? null,
      String(trace.promptExcerpt ?? "").slice(0, 4000),
      String(trace.rawResponse ?? "").slice(0, 8000),
      trace.latencyMs ?? null,
      new Date().toISOString()
    );
    db.prepare(TRIM).run();
  } catch (e) {
    console.error("logLlmTrace failed:", e);
  }
}

export function listTraces(db: Database.Database, limit = 20): LlmTrace[] {
  return db.prepare(SELECT_RECENT).all(Math.min(Math.max(limit, 1), 100)) as LlmTrace[];
}
