// Local supervisor: mirrors the platform runtime-packaging shim's task
// protocol (POST /tasks, GET /tasks/:id, GET /health) so the edge agent can
// be developed against it with no Fly machine.
import http from "node:http";
import { executeTask } from "@agentdeploy-io/core-sdk";
import agent from "./server.js";

const PORT = Number(process.env.PORT || 8080);
const tasks = new Map<string, { state: string; taskType: string; output?: unknown; error?: string; transitions: Array<{ to: string; at: string }> }>();
let seq = 0;

void agent; // registers with core-sdk on import

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ status: "ok", runtime: "local-supervisor" }));
  }
  if (req.method === "POST" && url.pathname === "/tasks") {
    let body = "";
    for await (const c of req) body += c;
    const parsed = JSON.parse(body || "{}");
    if (!parsed.taskType) {
      res.writeHead(400, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "taskType required" }));
    }
    seq += 1;
    const taskId = `local-task-${seq}`;
    tasks.set(taskId, { state: "queued", taskType: parsed.taskType, transitions: [{ to: "queued", at: new Date().toISOString() }] });
    res.writeHead(202, { "content-type": "application/json" });
    res.end(JSON.stringify({ taskId, state: "queued" }));
    const t = tasks.get(taskId)!;
    t.state = "running";
    t.transitions.push({ to: "running", at: new Date().toISOString() });
    try {
      const result = await executeTask(taskId, parsed.taskType, parsed.payload ?? {});
      t.state = result.state;
      t.output = result.output;
      t.error = result.error;
    } catch (e) {
      t.state = "failed";
      t.error = (e as Error).message;
    }
    t.transitions.push({ to: t.state, at: new Date().toISOString() });
    return;
  }
  const m = url.pathname.match(/^\/tasks\/([^/]+)$/);
  if (req.method === "GET" && m) {
    const t = tasks.get(decodeURIComponent(m[1]!));
    if (!t) {
      res.writeHead(404, { "content-type": "application/json" });
      return res.end(JSON.stringify({ error: "not found" }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: m[1], state: t.state, taskType: t.taskType, transitions: t.transitions, output: t.output, error: t.error }));
  }
  res.writeHead(404);
  res.end();
});

server.listen(PORT, () => console.log(`[local-supervisor] :${PORT} (agent: ${agent.name})`));
