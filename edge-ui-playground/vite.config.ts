import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { readFileSync } from "node:fs";
import http from "node:http";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Local agent proxy ────────────────────────────────────────────
// local-agents.json maps an agent namespace to a local worker port, e.g.
//   { "markie-agent": 8791, "support": 8789 }
// Proxies /agents/<namespace>/* (HTTP + WebSocket) and /health/<port>
// to the local worker, so any dev/seller can wire a locally-running
// agent into the console with one JSON line — no vite edits.
function loadLocalAgents(): Record<string, number> {
  try {
    return JSON.parse(readFileSync(resolve(__dirname, "local-agents.json"), "utf8"));
  } catch {
    return {};
  }
}

function localAgentPort(url: string): number | null {
  const hm = url.match(/^\/health\/(\d+)/);
  if (hm) return Number(hm[1]);
  const pm = url.match(/^\/agents\/([A-Za-z0-9_-]+)/);
  if (pm) {
    const port = loadLocalAgents()[pm[1]];
    if (port) return port;
  }
  return null;
}

function localAgentsPlugin() {
  return {
    name: "local-agents-proxy",
    configureServer(server: {
      middlewares: { use: (fn: (req: http.IncomingMessage, res: http.ServerResponse, next: () => void) => void) => void };
    }) {
      // Generic health probes: /health/<port> → /health on the local worker.
      // (The SPA polls /health/{agent.port} in dev mode.)
      server.middlewares.use((req, res, next) => {
        const port = localAgentPort(req.url || "");
        if (!port) return next();
        const path = (req.url || "").match(/^\/health\/\d+/) ? "/health" : req.url;
        const up = http.request(
          {
            host: "127.0.0.1",
            port,
            path,
            method: req.method,
            headers: { ...req.headers, host: `127.0.0.1:${port}` },
          },
          (upres) => {
            res.writeHead(upres.statusCode ?? 502, upres.headers);
            upres.pipe(res);
          },
        );
        up.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "content-type": "application/json" });
          res.end('{"error":"local agent proxy failed"}');
        });
        req.pipe(up);
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), localAgentsPlugin()],
  resolve: {
    alias: {
      "@agentdeploy-io/edge-ui": resolve(__dirname, "../edge-ui/src/index.ts"),
      "@agentdeploy-io/edge-ui/chat": resolve(__dirname, "../edge-ui/src/shells/chat/index.ts"),
      "@agentdeploy-io/edge-ui/widget": resolve(__dirname, "../edge-ui/src/shells/widget/index.ts"),
      "@agentdeploy-io/edge-ui/dashboard": resolve(__dirname, "../edge-ui/src/shells/dashboard/index.ts"),
      "@agentdeploy-io/edge-ui/split": resolve(__dirname, "../edge-ui/src/shells/split/index.ts"),
      "@agentdeploy-io/edge-ui/theme": resolve(__dirname, "../edge-ui/src/theme.ts"),
    },
  },
  server: {
    port: 5173,
    open: true,
    proxy: {
      // ── Polymarket intel agent (port 8787) ────────────────────────
      //   /agents/polymarket-intel/* → polymarket worker
      //   MUST come before the catch-all /agents entry
      "/agents/polymarket-intel": {
        target: "http://localhost:8787",
        ws: true,
        changeOrigin: true,
      },
      // ── Gmail invoices agent (port 8788) ──────────────────────────
      //   /agents/gmail-invoices/* → gmail worker
      //   MUST come before the catch-all /agents entry
      "/agents/gmail-invoices": {
        target: "http://localhost:8788",
        ws: true,
        changeOrigin: true,
      },
      // ── Generic local agents (local-agents.json) ─────────────────
      //   One JSON line per locally-running worker; each namespace gets a
      //   WS-capable proxy entry generated here (before the catch-all).
      ...Object.fromEntries(
        Object.entries(loadLocalAgents()).map(([ns, port]) => [
          `/agents/${ns}`,
          { target: `http://localhost:${port}`, ws: true, changeOrigin: true },
        ]),
      ),
      // ── Chat agents (port 8789) ──────────────────────────────────
      //   /agents/support/*  → customer-support worker
      //   /agents/sales/*    → customer-support worker
      //   Catch-all for any other agent name
      "/agents": {
        target: "http://localhost:8789",
        ws: true,
        changeOrigin: true,
      },
      // ── Health endpoints ────────────────────────────────────────
      "/health/8787": {
        target: "http://localhost:8787",
        changeOrigin: true,
        rewrite: (path) => path.replace("/health/8787", "/health"),
      },
      "/health/8788": {
        target: "http://localhost:8788",
        changeOrigin: true,
        rewrite: (path) => path.replace("/health/8788", "/health"),
      },
      "/health/8789": {
        target: "http://localhost:8789",
        changeOrigin: true,
        rewrite: (path) => path.replace("/health/8789", "/health"),
      },
      "/health": {
        target: "http://localhost:8789",
        changeOrigin: true,
      },
    },
  },
});
