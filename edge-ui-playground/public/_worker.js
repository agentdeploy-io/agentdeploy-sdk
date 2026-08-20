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

    // ── Per-deployment proxy ────────────────────────────────────
    // Routes: /d/{deploymentId}/* → that deployment's agent Worker.
    // The deploymentId → worker URL map is provided via the
    // DEPLOYMENT_MAP binding (JSON), set at console deploy time.
    // e.g. /d/9/agents/chatagent/default → <worker-9>/agents/chatagent/default
    const perDeployment = pathname.match(/^\/d\/([^/]+)(?:\/(.*))?$/);
    if (perDeployment) {
      return proxyToDeployment(request, env, perDeployment[1], perDeployment[2] ?? "");
    }

    // ── Agent WebSocket + HTTP proxy (legacy single-backend mode) ─
    // Routes: /agents/* → AGENT_BACKEND_URL. Only used when NO
    // DEPLOYMENT_MAP is configured (legacy single-backend consoles).
    // In production, /agents/{id}/{tab} is an SPA page route and agent
    // traffic goes through /d/{deploymentId}/agents/... instead — so
    // this proxy must NOT run when DEPLOYMENT_MAP is present.
    const hasDeploymentMap = !!(
      env.DEPLOYMENT_MAP && String(env.DEPLOYMENT_MAP).trim() !== "{}"
    );
    const isUpgrade =
      (request.headers.get("upgrade") || "").toLowerCase() === "websocket";
    const isNavigation = (request.headers.get("accept") || "").includes(
      "text/html",
    );
    if (
      pathname.startsWith("/agents/") &&
      !hasDeploymentMap &&
      (isUpgrade || !isNavigation)
    ) {
      return proxyToBackend(request, env);
    }

    // ── Health check proxy (legacy single-backend mode) ──────────
    // Routes: /health, /health/{port} → agent backend /health
    if (
      (pathname === "/health" || pathname.startsWith("/health/")) &&
      !hasDeploymentMap
    ) {
      return proxyToBackend(request, env, "/health");
    }

    // ── Marketplace API proxy (optional) ────────────────────────
    // Routes: /api/edge/* → marketplace API
    //         /v1/*      → marketplace BFF (deployment-service proxy)
    // This avoids CORS for session checks and deployments listing.
    if (pathname.startsWith("/api/edge/") || pathname.startsWith("/v1/")) {
      return proxyToMarketplace(request, env);
    }

    // ── Static assets ───────────────────────────────────────────
    // Let Cloudflare Pages handle static file serving.
    // The [assetFallback] in the Pages config handles SPA routing.
    if (env.ASSETS && typeof env.ASSETS.fetch === "function") {
      return env.ASSETS.fetch(request);
    }
    // Workers API deploys without an ASSETS binding: assets are served by
    // the platform for non-run_worker_first routes. For SPA navigations
    // (Accept: text/html) that fell through the proxies above, serve the
    // shell by subrequesting "/" — the platform serves index.html there
    // while the browser URL keeps the deep-linked SPA route.
    if ((request.headers.get("accept") || "").includes("text/html")) {
      try {
        const shell = await fetch(new URL("/", url), {
          method: "GET",
          headers: { Accept: "text/html" },
        });
        if (shell.ok && (shell.headers.get("content-type") || "").includes("text/html")) {
          return shell;
        }
      } catch {
        // fall through to 404
      }
    }
    return jsonError("Not found", 404);
  },
};

// ─── Proxy Helpers ───────────────────────────────────────────────

/**
 * Proxy a request to a specific deployment's agent Worker.
 * Looks up the worker URL in env.DEPLOYMENT_MAP (JSON: id → base URL).
 */
async function proxyToDeployment(request, env, deploymentId, restPath) {
  let map = {};
  try {
    map = JSON.parse(env.DEPLOYMENT_MAP || "{}");
  } catch {
    return jsonError("DEPLOYMENT_MAP is malformed JSON.", 500);
  }
  const target = map[deploymentId];
  if (!target) {
    return jsonError(`Unknown deployment: ${deploymentId}`, 404);
  }

  const url = new URL(request.url);
  const targetUrl = new URL("/" + restPath, target);
  targetUrl.search = url.search;

  // Same-account worker→workers.dev fetches do NOT route through the target
  // worker's run_worker_first rules (they land on its static assets → 404).
  // The deployer adds a service binding per deployment (D_{id}) — prefer it.
  const binding = env["D_" + deploymentId];
  if (binding && typeof binding.fetch === "function") {
    const init = {
      method: request.method,
      headers: new Headers(request.headers),
      body: request.body,
      redirect: "manual",
    };
    try {
      return await binding.fetch(targetUrl.href, init);
    } catch (err) {
      // Service bindings always run the target worker's code (no assets
      // fallback) — an unmatched route can throw inside the backend.
      // Surface a clean error instead of a 1101.
      return jsonError(
        `Deployment ${deploymentId} request failed: ${err && err.message ? err.message : String(err)}`,
        502,
      );
    }
  }

  // Fallback: plain fetch (cross-account / service binding missing).
  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: new Headers(request.headers),
    body: request.body,
    redirect: "manual",
  });

  const res = await fetch(proxyRequest);
  return res;
}

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
