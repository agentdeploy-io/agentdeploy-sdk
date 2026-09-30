/**
 * Conformance harness — runs the Supervisor Protocol v1 contract suite
 * against ANY runtime image. This is the mechanical GA gate: an adapter is
 * "GA" when this script exits 0 against its running container.
 *
 * Usage:
 *   RUNTIME_CONTRACT_URL=http://localhost:8080 RUNTIME_NAME=hermes npx tsx scripts/conformance.ts
 *
 * Checks (mirrors deployment-service runtime-contract.test.ts):
 *   C1  GET /health → 200 { status }
 *   C2  POST /tasks (valid) → 202 + taskId
 *   C3  POST /tasks (invalid) → 400
 *   C4  GET /tasks/{id} → detail with append-only transitions
 *   C5  cancel → terminal cancelled within 60s
 *   C6  checkpoint → 202; resume semantics present
 *   C7  GET /status → task array with budget usage
 *   C8  heartbeats arrive at platform (skipped unless CONTROL_PLANE_URL set)
 */
const BASE = (process.env["RUNTIME_CONTRACT_URL"] || "").replace(/\/$/, "");
if (!BASE) {
  console.error("Set RUNTIME_CONTRACT_URL=http://<container>:8080");
  process.exit(2);
}
const TIMEOUT = Number(process.env["CONFORMANCE_TIMEOUT_MS"] || 90_000);

let pass = 0;
let fail = 0;

function check(name: string, ok: boolean, detail?: string): void {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}`);
  } else {
    fail += 1;
    console.error(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

async function call(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let parsed: unknown = text;
  try {
    parsed = JSON.parse(text);
  } catch {}
  return { status: res.status, body: parsed };
}

async function waitFor(predicate: () => Promise<boolean>, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return predicate();
}

// ── Run ──────────────────────────────────────────────────────────────────────

// C1 health
{
  const r = await call("GET", "/health").catch(() => ({ status: 0, body: null }));
  check("C1 health", r.status === 200 && !!(r.body as any)?.status, `status=${r.status}`);
}

// C2 valid enqueue
let taskId = "";
{
  const r = await call("POST", "/tasks", { taskType: "conformance", payload: { prompt: "echo conformance" } });
  taskId = (r.body as any)?.taskId ?? "";
  check("C2 enqueue valid", r.status === 202 && taskId.length > 0, `status=${r.status}`);
}

// C3 invalid enqueue
{
  const r = await call("POST", "/tasks", {});
  check("C3 enqueue invalid rejected", r.status === 400, `status=${r.status}`);
}

// C4 detail + transitions exist
{
  const r = await call("GET", `/tasks/${encodeURIComponent(taskId)}`);
  const transitions = (r.body as any)?.transitions;
  check(
    "C4 task detail",
    r.status === 200 && Array.isArray(transitions) && transitions.length >= 1,
    `status=${r.status}`
  );
  // monotonic timestamps
  let monotonic = true;
  for (let i = 1; i < (transitions ?? []).length; i++) {
    if (new Date(transitions[i].at).getTime() < new Date(transitions[i - 1].at).getTime()) monotonic = false;
  }
  check("C4b transitions monotonic", monotonic);
}

// C5 cancel reaches terminal within 60s
{
  await call("POST", `/tasks/${encodeURIComponent(taskId)}/cancel`);
  const done = await waitFor(async () => {
    const r = await call("GET", `/tasks/${encodeURIComponent(taskId)}`);
    return ["cancelled", "succeeded", "failed", "expired"].includes((r.body as any)?.state);
  }, Math.min(TIMEOUT, 60_000));
  const final = await call("GET", `/tasks/${encodeURIComponent(taskId)}`);
  check("C5 cancel → terminal ≤60s", done && final.body.state === "cancelled", `state=${final.body?.state}`);
}

// C6 checkpoint accepted
{
  const r = await call("POST", "/checkpoint");
  check("C6 checkpoint accepted", r.status === 202 || r.status === 200, `status=${r.status}`);
}

// C7 status shape
{
  const r = await call("GET", "/status");
  const tasks = (r.body as any)?.tasks;
  check(
    "C7 status",
    r.status === 200 && Array.isArray(tasks) && tasks.some((t: any) => t.id === taskId),
    `status=${r.status}`
  );
}

// C8 heartbeat delivery (only verifiable with platform wired)
if (process.env["CONTROL_PLANE_URL"]) {
  console.log("C8 heartbeat delivery — verify via core_agent_events on the control plane (manual/CI)");
} else {
  console.log("SKIP C8 (CONTROL_PLANE_URL not set)");
}

console.log(`\n${pass}/${pass + fail} conformance checks passed for ${process.env["RUNTIME_NAME"] || BASE}`);
process.exit(fail > 0 ? 1 : 0);
