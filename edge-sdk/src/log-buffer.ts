// ── Worker Request Log Buffer ───────────────────────────────────────────────
// Bounded in-memory ring buffer of recent requests. The AgentDeploy platform
// pulls it via GET /_logs during health probes and persists entries into
// edge_deployment_logs (keyed by the entry id, so repeated pulls are
// idempotent).

export interface WorkerLogEntry {
  /** Stable id used for idempotent ingestion (uuid, restart-safe). */
  id: string;
  /** ISO timestamp of the request. */
  ts: string;
  level: "info" | "warn" | "error";
  method: string;
  path: string;
  status: number;
  durMs: number;
}

const LOG_BUFFER_SIZE = 200;
const buffer: WorkerLogEntry[] = [];
let seq = 0;

export function recordRequest(
  method: string,
  path: string,
  status: number,
  durMs: number,
): void {
  seq += 1;
  const level = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  buffer.push({
    id: crypto.randomUUID(),
    ts: new Date().toISOString(),
    level,
    method,
    path,
    status,
    durMs,
  });
  if (buffer.length > LOG_BUFFER_SIZE) {
    buffer.splice(0, buffer.length - LOG_BUFFER_SIZE);
  }
}

export function readLogBuffer(): { seq: number; logs: WorkerLogEntry[] } {
  return { seq, logs: buffer.slice() };
}
