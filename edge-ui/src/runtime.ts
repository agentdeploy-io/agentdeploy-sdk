/**
 * @agentdeploy/edge-ui/runtime — Server-side UI asset handling
 *
 * Provides a fetch handler that serves static UI assets from within
 * a Cloudflare Worker. When deployed, UI files are bundled as
 * static assets via the Workers `assets` binding.
 *
 * In development (wrangler dev), assets are served via the Vite
 * plugin's dev middleware.
 *
 * @example
 * ```ts
 * // src/server.ts
 * import { createUIHandler } from "@agentdeploy/edge-ui/runtime";
 *
 * export default {
 *   async fetch(request, env) {
 *     // Serve UI at /ui/*
 *     const uiResponse = await createUIHandler(request, env);
 *     if (uiResponse) return uiResponse;
 *
 *     // Fall through to agent routing
 *     // ...
 *   },
 * };
 * ```
 */

/**
 * Check if a request path is targeting the UI.
 */
export function isUIPath(pathname: string, basePath = "/ui"): boolean {
  return pathname === basePath || pathname.startsWith(`${basePath}/`);
}

/**
 * Handle UI asset requests.
 *
 * In production with Workers static assets, this delegates to the
 * `env.ASSETS` binding. In development, it returns null so the
 * request falls through to the Vite dev server.
 *
 * @returns Response if the request was handled, null otherwise
 */
export async function createUIHandler(
  request: Request,
  env: Record<string, unknown>,
  basePath = "/ui",
): Promise<Response | null> {
  const url = new URL(request.url);

  if (!isUIPath(url.pathname, basePath)) {
    return null;
  }

  // In production, use the Workers static assets binding
  const assetsBinding = env["ASSETS"] as { fetch?: (req: Request) => Promise<Response> } | undefined;

  if (assetsBinding?.fetch) {
    // Rewrite the path to strip the base path
    const subPath = url.pathname.slice(basePath.length) || "/";
    const assetUrl = new URL(subPath, url.origin);
    const assetReq = new Request(assetUrl, request);
    return assetsBinding.fetch(assetReq);
  }

  // In development, return null — Vite dev server handles this
  return null;
}

/**
 * SPA fallback handler for client-side routing.
 * Returns index.html for non-asset routes.
 */
export async function spaFallback(
  request: Request,
  env: Record<string, unknown>,
  basePath = "/ui",
): Promise<Response | null> {
  const url = new URL(request.url);

  // If not a UI path, skip
  if (!isUIPath(url.pathname, basePath)) return null;

  // If requesting a file with extension, let 404 handle it
  const lastSegment = url.pathname.split("/").pop();
  if (lastSegment?.includes(".")) return null;

  // For SPA routes, serve index.html
  const assetsBinding = env["ASSETS"] as { fetch?: (req: Request) => Promise<Response> } | undefined;

  if (assetsBinding?.fetch) {
    const indexReq = new Request(new URL("/index.html", url.origin), request);
    return assetsBinding.fetch(indexReq);
  }

  return null;
}
