import { defineConfig, type Plugin, type PluginOption } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

/**
 * Local dev proxy targets.
 *   CALLA_EDGE_PORT   — `wrangler dev` port for apps/edge (default 8787)
 *   CALLA_BRAIN_PORT  — Mastra brain port (default 3000)
 *   CALLA_PLATFORM_PORT — deployment-service port for /v1 platform API (default 3010)
 *   CALLA_DATA_PORT   — real engine (packages/bi-edge `wrangler dev`) port.
 *                       When set, /d/* bypasses the calla-edge dev stubs and is
 *                       proxied straight to the engine (prefix /d/<deploymentId>
 *                       stripped — bi-edge serves /cmd/* at the worker root).
 */
const EDGE = `http://127.0.0.1:${process.env.CALLA_EDGE_PORT ?? 8787}`;
const BRAIN = `http://127.0.0.1:${process.env.CALLA_BRAIN_PORT ?? 3001}`;
const PLATFORM = `http://127.0.0.1:${process.env.CALLA_PLATFORM_PORT ?? 3010}`;
const DATA_PORT = process.env.CALLA_DATA_PORT;
const DATA = DATA_PORT ? `http://127.0.0.1:${DATA_PORT}` : null;

type ReqWithBody = { __engineBody?: Buffer };

/**
 * Calla's useDataApi posts lead patches FLAT (`{key, status:"approved"}`);
 * bi-edge's POST /cmd/data/row expects `{key, patch:{...}}` (same for
 * /cmd/data/batch with `keys`). When proxying to the real engine, buffer the
 * request body and wrap flat patches so the actual UI inbox approval works
 * unmodified. Dev-only; nested bodies pass through untouched.
 */
function engineBodyShim(): Plugin {
  return {
    name: "calla-engine-body-shim",
    apply: "serve",
    configureServer(server) {
      if (!DATA) return;
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "";
        const isDataPatch =
          req.method === "POST" && /^\/d\/[^/]+\/cmd\/data\/(row|batch)(\?|$)/.test(url);
        if (!isDataPatch) {
          next();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const raw = Buffer.concat(chunks);
          let out = raw;
          try {
            const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
            const flat =
              parsed &&
              typeof parsed === "object" &&
              parsed.patch === undefined &&
              (parsed.key !== undefined || parsed.keys !== undefined);
            if (flat) {
              const { key, keys, ...rest } = parsed;
              out = Buffer.from(
                JSON.stringify(keys !== undefined ? { keys, patch: rest } : { key, patch: rest }),
              );
            }
          } catch {
            /* not JSON — forward as-is */
          }
          (req as ReqWithBody).__engineBody = out;
          next();
        });
      });
    },
  };
}

export default defineConfig({
  // @vitejs/plugin-react types resolve against the hoisted vite copy, not this
  // app's local vite — narrow through the local PluginOption to keep tsc green.
  plugins: [react() as unknown as PluginOption, engineBodyShim() as unknown as PluginOption],
  resolve: {
    alias: {
      "@": resolve(__dirname, "src"),
    },
  },
  server: {
    port: 5174,
    open: true,
    proxy: {
      // Edge agent WS + HTTP (cf_agent_* protocol) and Calla /events feed
      "/agents": { target: EDGE, ws: true },
      "/events": { target: EDGE, ws: true },
      "/health": { target: EDGE },
      // Edge REST (steps, approvals, fleet, state, voice)
      "/steps": { target: EDGE },
      "/approvals": { target: EDGE },
      "/fleet": { target: EDGE },
      "/state": { target: EDGE },
      "/voice": { target: EDGE },
      // Per-deployment console proxy (data-plane /cmd/*).
      // CALLA_DATA_PORT set → real engine (strip /d/<deploymentId> prefix);
      // otherwise → calla-edge, which serves honest empty dev stubs.
      "/d": DATA
        ? {
            target: DATA,
            ws: true,
            rewrite: (p) => p.replace(/^\/d\/[^/]+/, ""),
            configure: (proxy) => {
              proxy.on("proxyReq", (proxyReq, req) => {
                const body = (req as ReqWithBody).__engineBody;
                if (!body) return;
                proxyReq.setHeader("Content-Type", "application/json");
                proxyReq.setHeader("Content-Length", String(body.length));
                proxyReq.write(body);
              });
            },
          }
        : { target: EDGE, ws: true },
      // Brain (Mastra) API
      "/brain": {
        target: BRAIN,
        rewrite: (p) => p.replace(/^\/brain/, ""),
      },
      // Platform API (deployments, core VMs, uploads, voice)
      "/v1": { target: PLATFORM },
      "/api/edge": { target: PLATFORM },
    },
  },
  build: {
    outDir: "dist",
    sourcemap: true,
  },
});
