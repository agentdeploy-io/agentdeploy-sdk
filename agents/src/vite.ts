/**
 * @agentdeploy-io/agents/vite — Vite plugin for AgentDeploy projects
 *
 * Wraps the upstream Cloudflare Agents Vite plugin, which handles:
 *   - TC39 decorator transforms (for @callable())
 *   - `agents:skills` import resolution
 *   - Stubbing `turndown` for Workers compatibility
 *
 * Additionally provides:
 *   - `uiAssets()` plugin for serving UI shells during development
 *   - Automatic HTML entry point detection
 */

import type { Plugin, PluginOption } from "vite";

// Re-export the upstream plugin
export { default as agents } from "agents/vite";

// ── UI Assets Plugin (Phase 2 foundation) ─────────────────────────────────────

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface UIAssetsOptions {
  /**
   * Path to the UI directory (default: "./ui")
   * This directory should contain:
   *   - index.html (entry point)
   *   - Any CSS, JS, image assets
   */
  uiDir?: string;

  /**
   * Base path for serving UI assets (default: "/ui")
   * When deployed, the UI will be available at this path.
   */
  basePath?: string;

  /**
   * Whether to enable the UI dev server.
   * In production builds, assets are served from static files.
   */
  dev?: boolean;
}

/**
 * Vite plugin for serving bundled UI assets alongside Agents.
 *
 * During development, this serves files from your `ui/` directory.
 * In production, assets are bundled and served via the Worker's
 * static assets binding.
 *
 * @example
 * ```ts
 * // vite.config.ts
 * import { defineConfig } from "vite";
 * import { agents, uiAssets } from "@agentdeploy-io/agents/vite";
 *
 * export default defineConfig({
 *   plugins: [
 *     agents(),
 *     uiAssets({ uiDir: "./ui", dev: true }),
 *   ],
 * });
 * ```
 */
export function uiAssets(options: UIAssetsOptions = {}): Plugin {
  const uiDir = options.uiDir ?? "./ui";
  const basePath = options.basePath ?? "/ui";
  const enabled = options.dev ?? true;

  return {
    name: "agentdeploy-ui-assets",
    configureServer(server) {
      if (!enabled) return;

      // Serve UI HTML at /ui and /ui/*
      server.middlewares.use(basePath, (req, res, next) => {
        const url = req.url ?? "/";
        const filePath = resolve(uiDir, url === "/" ? "index.html" : url.slice(1));

        if (existsSync(filePath)) {
          try {
            const content = readFileSync(filePath);
            const ext = filePath.split(".").pop()?.toLowerCase();
            const mimeTypes: Record<string, string> = {
              html: "text/html",
              css: "text/css",
              js: "text/javascript",
              mjs: "text/javascript",
              json: "application/json",
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              svg: "image/svg+xml",
              ico: "image/x-icon",
              woff2: "font/woff2",
              woff: "font/woff",
            };
            res.setHeader("Content-Type", mimeTypes[ext ?? ""] ?? "application/octet-stream");
            res.end(content);
            return;
          } catch {
            // Fall through to next middleware
          }
        }
        next();
      });
    },

    config() {
      return {
        build: {
          rollupOptions: {
            input: existsSync(resolve(uiDir, "index.html"))
              ? resolve(uiDir, "index.html")
              : undefined,
          },
        },
      };
    },
  };
}

/**
 * Combined Vite plugin that includes both the upstream agents plugin
 * and the UI assets plugin. Use this as a single import.
 *
 * @example
 * ```ts
 * import { defineConfig } from "vite";
 * import { agentDeploy } from "@agentdeploy-io/agents/vite";
 *
 * export default defineConfig({
 *   plugins: [agentDeploy({ ui: { uiDir: "./ui" } })],
 * });
 * ```
 */
export async function agentDeploy(options: {
  stubTurndown?: boolean;
  ui?: UIAssetsOptions;
} = {}): Promise<PluginOption[]> {
  const plugins: PluginOption[] = [];

  // Add upstream agents plugin via dynamic import
  try {
    const upstreamModule = await import("agents/vite");
    const upstreamPlugin = upstreamModule.default ?? upstreamModule;
    if (typeof upstreamPlugin === "function") {
      const result = upstreamPlugin({ stubTurndown: options.stubTurndown });
      if (Array.isArray(result)) plugins.push(...result);
      else plugins.push(result);
    }
  } catch {
    // Fallback: just include our UI plugin if upstream isn't available
  }

  // Add UI assets plugin
  if (options.ui) {
    plugins.push(uiAssets(options.ui));
  }

  return plugins;
}
