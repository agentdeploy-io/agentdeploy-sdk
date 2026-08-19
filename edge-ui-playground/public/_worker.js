/**
 * Edge Console — Cloudflare Pages Worker
 * ──────────────────────────────────────────
 * Handles production routing for the SPA + agent backends.
 *
 * Routes:
 *   /agents/*      → Proxy to the agent Worker backend (Durable Objects)
 *   /health/*      → Proxy health checks to the agent backend
 *   /api/*         → Proxy to marketplace API (session, deployments)
 *   /*             → Serve static SPA assets from Pages
 *
 * This Worker runs on Cloudflare Pages (Pages Functions) and sits in
 * front of both the static SPA and the agent backends, providing:
 *   1. Same-origin routing (no CORS issues)
 *   2. SPA fallback (all non-file routes → index.html)
 *   3. Agent proxying (the agent Worker URL is configured via env)
 *
 * The agent backend URL is set via the AGENT_BACKEND_URL environment
 * variable in the Cloudflare dashboard or wrangler.toml.
 */

// ─── Config ──────────────────────────────────────────────────────

const STATIC_ASSETS = [
  ".html",
  ".js",
  ".css",
  ".ico",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".map",
  ".webmanifest",
  ".txt",
];

// ─── Main Handler ────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // ── Agent WebSocket + HTTP proxy ────────────────────────────
    // Routes: /agents/* → agent backend
    if (pathname.startsWith("/agents/")) {
      return proxyToBackend(request, env);
    }

    // ── Health check proxy ──────────────────────────────────────
    // Routes: /health, /health/{port} → agent backend /health
    if (pathname === "/health" || pathname.startsWith("/health/")) {
      return proxyToBackend(request, env, "/health");
    }

    // ── Marketplace API proxy (optional) ────────────────────────
    // Routes: /api/edge/* → marketplace API
    // This avoids CORS for session checks on subdomains.
    if (pathname.startsWith("/api/edge/")) {
      return proxyToMarketplace(request, env);
    }

    // ── Static assets ───────────────────────────────────────────
    // Let Cloudflare Pages handle static file serving.
    // The [assetFallback] in the Pages config handles SPA routing.
    return env.ASSETS.fetch(request);
  },
};

// ─── Proxy Helpers ───────────────────────────────────────────────

/**
 * Proxy a request to the agent backend.
 *
 * The agent backend URL is configured via AGENT_BACKEND_URL env var.
 * In production, this is the URL of the buyer's deployed agent Worker
 * (e.g., https://acme-agents.workers.dev).
 *
 * WebSocket upgrade requests are handled transparently.
 */
async function proxyToBackend(request, env, rewritePath) {
  const backendUrl = env.AGENT_BACKEND_URL;
  if (!backendUrl) {
    return jsonError(
      "AGENT_BACKEND_URL is not configured. Set it in the Cloudflare dashboard.",
      500,
    );
  }

  const url = new URL(request.url);

  // Build the target URL
  const targetUrl = new URL(rewritePath || url.pathname, backendUrl);
  if (!rewritePath) {
    // Preserve query string for agent requests (e.g., ?token=xxx)
    targetUrl.search = url.search;
  }

  // Clone the request with the new URL
  const proxyRequest = new Request(targetUrl, request);
  proxyRequest.headers.set("Host", targetUrl.host);

  return fetch(proxyRequest);
}

/**
 * Proxy a request to the marketplace API.
 * Used for session validation on subdomains to avoid CORS.
 */
async function proxyToMarketplace(request, env) {
  const marketplaceUrl = env.MARKETPLACE_URL || "https://agentdeploy.io";
  const url = new URL(request.url);

  // Strip /api/edge/ prefix and reconstruct
  const apiPath = url.pathname.replace(/^\/api\/edge/, "/api/edge");
  const targetUrl = new URL(apiPath, marketplaceUrl);
  targetUrl.search = url.search;

  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: request.headers,
    body: request.body,
    redirect: "manual",
  });
  proxyRequest.headers.set("Host", targetUrl.host);

  return fetch(proxyRequest);
}

// ─── Utilities ───────────────────────────────────────────────────

function jsonError(message, status = 500) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
