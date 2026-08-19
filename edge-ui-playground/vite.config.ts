import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [react()],
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
