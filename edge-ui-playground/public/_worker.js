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

    // ── Runtime config — served DYNAMICALLY (Reliability Plan R3.1/R3.2) ──
    // Fetches config from the deployment-service at request time (edge-cached
    // 60s) instead of relying on a baked static asset. Config changes
    // propagate within 60s with zero console redeploys. On upstream failure,
    // serves the last-good copy with staleConfig: true so the UI can warn.
    if (pathname === "/runtime-config.js") {
      return serveRuntimeConfig(request, env, ctx);
    }

    // ── Console version endpoint (R3.3) ─────────────────────────────────
    // Reports bundle + config hashes for operator staleness dashboards.
    if (pathname === "/_console/version") {
      const config = await getCachedConfig(request, env, ctx);
      return new Response(
        JSON.stringify({
          bundleHash: env.CONSOLE_BUNDLE_HASH || "unknown",
          configHash: config?.configHash ?? "unknown",
          configStale: !!config?.staleConfig,
          generatedAt: config?.generatedAt ?? null,
        }),
        { status: 200, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } },
      );
    }

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

// ─── Dynamic Runtime Config (R3.1/R3.2) ──────────────────────────

const CONFIG_CACHE_TTL_S = 60;
const CONFIG_STALE_FALLBACK_TTL_S = 7 * 24 * 60 * 60; // last-good kept 7 days

/**
 * Identify the buyer for config-fetch purposes. The console Worker is
 * per-buyer; the deployment-service keys config by userId passed at deploy
 * time via the CONSOLE_USER_ID binding.
 */
function consoleUserId(env) {
  return env.CONSOLE_USER_ID || "";
}

/**
 * Fetch + edge-cache the runtime config from the deployment-service.
 * Cache layout:
 *   fresh:  caches.default + KV-less lastGood copy in the same cache with a
 *           long TTL so upstream outages degrade to stale-with-flag, not down.
 */
async function getCachedConfig(request, env, ctx) {
  const userId = consoleUserId(env);
  if (!userId) {
    // No user bound (manual wrangler deploys): fall back to baked asset if
    // present, else empty config — same behavior as pre-R3 consoles.
    return null;
  }

  const upstream = env.DEPLOYMENT_SERVICE_URL; // set by deployer
  if (!upstream) return null;

  const cache = caches.default;
  const configUrl = new URL(
    `/v1/console/config?userId=${encodeURIComponent(userId)}`,
    upstream,
  );

  // 1. Fresh edge cache
  let res = await cache.match(configUrl.href);
  if (res && !isExpired(res)) {
    return { ...(await res.json()), staleConfig: false };
  }

  // 2. Upstream fetch (internal-token authed)
  try {
    const upstreamRes = await fetch(configUrl.href, {
      headers: { "X-Internal-Token": env.DEPLOYMENT_SERVICE_TOKEN || "" },
      signal: AbortSignal.timeout(5000),
    });
    if (upstreamRes.ok) {
      const body = await upstreamRes.json();
      const cachedHeaders = new Headers({ "Content-Type": "application/json" });
      cachedHeaders.set(
        "x-config-fetched-at",
        String(Date.now()),
      );
      cachedHeaders.set(
        "cache-control",
        `public, max-age=${CONFIG_CACHE_TTL_S}, stale-while-revalidate=${CONFIG_STALE_FALLBACK_TTL_S}`,
      );
      const cachedRes = new Response(JSON.stringify(body), { headers: cachedHeaders });
      ctx.waitUntil(cache.put(configUrl.href, cachedRes.clone()));
      return { ...body, staleConfig: false };
    }
    throw new Error(`upstream ${upstreamRes.status}`);
  } catch (err) {
    // 3. Last-good fallback (R3.2) — serve stale with flag rather than fail
    if (res) {
      return { ...(await res.json()), staleConfig: true };
    }
    console.error("Console config fetch failed and no last-good copy:", err?.message || err);
    return null;
  }
}

function isExpired(res) {
  const fetchedAt = Number(res.headers.get("x-config-fetched-at") || 0);
  if (!fetchedAt) return false; // no timestamp → treat as valid
  return Date.now() - fetchedAt > CONFIG_CACHE_TTL_S * 1000;
}

/** Serve /runtime-config.js dynamically with last-good fallback. */
async function serveRuntimeConfig(request, env, ctx) {
  const config = await getCachedConfig(request, env, ctx);

  let cfg = {};
  let staleConfig = false;
  if (config && config.config) {
    cfg = config.config;
    staleConfig = !!config.staleConfig;
  } else {
    // No dynamic source configured (local dev / legacy manual deploys):
    // fall back to the static baked asset served by the platform.
    try {
      const assets = env.ASSETS;
      if (assets && typeof assets.fetch === "function") {
        const assetRes = await assets.fetch(new URL("/runtime-config.js", request.url));
        if (assetRes.ok) return assetRes;
      }
    } catch {}
  }

  cfg = { ...cfg, ...(staleConfig ? { STALE_CONFIG: true } : {}) };
  return new Response(
    `window.__EDGE_CONSOLE_CONFIG__ = ` + JSON.stringify(cfg) + `;`,
    {
      status: 200,
      headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-store", // the Worker caches upstream, not the browser
      },
    },
  );
}

// ─── Proxy Helpers ───────────────────────────────────────────────

// ── Per-deployment edge-JWT minting (gated agent workers) ─────────
// Blueprint workers verify short-lived edge JWTs (AUTH.md Path 2). The
// console worker mints one per deployment via the deployment-service
// internal API (X-Internal-Token + allowlisted origin) and pins it on
// every proxied request. In-memory cache — the token TTL is 5 min.
const jwtCache = new Map(); // deploymentId → { token, expiresAt }

async function mintDeploymentJwt(env, deploymentId) {
  const cached = jwtCache.get(deploymentId);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  if (!env.DEPLOYMENT_SERVICE_URL || !env.DEPLOYMENT_SERVICE_TOKEN || !env.CONSOLE_USER_ID) {
    return null;
  }
  try {
    const svc = new URL(env.DEPLOYMENT_SERVICE_URL);
    const res = await fetch(
      `${svc.origin}/api/deployment-service/internal/edge/jwt?deploymentId=${encodeURIComponent(deploymentId)}&userId=${encodeURIComponent(env.CONSOLE_USER_ID)}`,
      {
        headers: {
          "X-Internal-Token": env.DEPLOYMENT_SERVICE_TOKEN,
          "X-Internal-Origin": svc.origin,
        },
        signal: AbortSignal.timeout(5000),
      },
    );
    if (!res.ok) return null;
    const body = await res.json();
    const payload = body && body.data ? body.data : body;
    const token = payload && payload.token;
    if (!token) return null;
    const ttlSeconds = payload.expiresIn || 300;
    jwtCache.set(deploymentId, { token, expiresAt: Date.now() + Math.max(ttlSeconds - 30, 60) * 1000 });
    return token;
  } catch {
    return null;
  }
}

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

  // Pin an agent-scoped edge JWT on the target request: Bearer header for
  // HTTP, ?token= for WebSocket handshakes (browsers can't set WS headers).
  // This OVERRIDES any client-supplied token — the client's console JWT is
  // audience-pinned to the console host, not the agent host.
  const agentJwt = await mintDeploymentJwt(env, deploymentId);
  if (agentJwt) {
    targetUrl.searchParams.set("token", agentJwt);
  }

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
    // The agent's JWT gate audience-checks the Host header — pin the
    // target's own host (service bindings forward the original Host).
    init.headers.set("Host", new URL(target).host);
    if (agentJwt) init.headers.set("Authorization", "Bearer " + agentJwt);
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
  const fallbackHeaders = new Headers(request.headers);
  fallbackHeaders.set("Host", new URL(target).host);
  if (agentJwt) fallbackHeaders.set("Authorization", "Bearer " + agentJwt);
  const proxyRequest = new Request(targetUrl, {
    method: request.method,
    headers: fallbackHeaders,
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
