// ── Handler Factory ─────────────────────────────────────────────────────────
// Creates the default export handler that routes to agents.

import { routeAgentRequest } from "@agentdeploy/agents";
import type { AgentHandler, AgentDeployAgent } from "./types.js";

/**
 * Maximum number of agent classes that can be registered.
 */
const MAX_AGENTS = 16;

/**
 * Internal registry of agent class names for health reporting.
 */
const registeredAgentNames: string[] = [];

/**
 * CORS headers applied to all responses so that browser-based UIs
 * (Vite dev servers, embedded widgets, etc.) can connect cross-origin.
 *
 * In production, the AgentDeploy platform proxy adds CORS headers
 * automatically. This ensures local dev and direct connections work too.
 */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-AD-Deployment",
  "Access-Control-Max-Age": "86400",
};

/**
 * Wraps a Response with CORS headers.
 *
 * For WebSocket upgrade responses (status 101) we MUST NOT create a new
 * Response — that would destroy the WebSocket pair. Instead we mutate
 * headers in-place.
 */
function withCors(response: Response): Response {
  // WebSocket upgrades (101 Switching Protocols) cannot be reconstructed
  if (response.status === 101 || response.websocket) {
    for (const [key, value] of Object.entries(CORS_HEADERS)) {
      response.headers.set(key, value);
    }
    return response;
  }
  const newResponse = new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
  for (const [key, value] of Object.entries(CORS_HEADERS)) {
    newResponse.headers.set(key, value);
  }
  return newResponse;
}

/**
 * Creates a worker fetch handler that routes requests to agents.
 *
 * This should be used as the default export of your worker entry point.
 * It handles:
 *   - CORS preflight (OPTIONS) requests
 *   - Routing to agents via the Agents SDK's routeAgentRequest()
 *   - Health check endpoints required by the platform
 *   - 404 responses for unknown routes
 *
 * All responses include CORS headers for browser compatibility.
 *
 * @example
 * ```ts
 * import { createChatAgent, createHandler } from "@agentdeploy/edge-sdk";
 *
 * export const Support = createChatAgent({ name: "support", ... });
 * export const Sales = createChatAgent({ name: "sales", ... });
 *
 * export default createHandler(Support, Sales);
 * ```
 */
export function createHandler(
  ...agentClasses: Array<{ new (...args: unknown[]): AgentDeployAgent }>
): AgentHandler {
  // Extract names for health reporting
  for (const cls of agentClasses) {
    const name = (cls as unknown as { agentName?: string }).agentName ?? cls.name;
    if (name && !registeredAgentNames.includes(name)) {
      registeredAgentNames.push(name);
    }
  }

  if (registeredAgentNames.length > MAX_AGENTS) {
    throw new Error(
      `Maximum ${MAX_AGENTS} agents per worker. Found ${registeredAgentNames.length}.`,
    );
  }

  return {
    async fetch(
      request: Request,
      env: Record<string, unknown>,
    ): Promise<Response> {
      // Handle CORS preflight immediately
      if (request.method === "OPTIONS") {
        return new Response(null, {
          status: 204,
          headers: CORS_HEADERS,
        });
      }

      // Route to agents first (this handles /agents/:name/:instance)
      // WebSocket upgrade responses MUST be returned untouched — any
      // modification (even header mutation) invalidates the WebSocket pair.
      const agentResponse = await routeAgentRequest(
        request,
        env,
      );
      if (agentResponse) {
        // Return WebSocket upgrades untouched — CORS is handled by the
        // Vite dev proxy (same-origin) in dev and the platform proxy in prod.
        if (agentResponse.status === 101 || agentResponse.websocket) {
          return agentResponse;
        }
        return withCors(agentResponse);
      }

      // Health check endpoint (required by AgentDeploy platform)
      const url = new URL(request.url);
      if (url.pathname === "/health") {
        return withCors(
          new Response(
            JSON.stringify({
              status: "ok",
              deploymentId: AD_DEPLOYMENT_ID,
              templateId: AD_TEMPLATE_ID,
              model: AD_MODEL,
              agents: registeredAgentNames,
              version: "0.1.0",
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-AD-Deployment": AD_DEPLOYMENT_ID,
              },
            },
          ),
        );
      }

      // Info endpoint
      if (url.pathname === "/info") {
        return withCors(
          new Response(
            JSON.stringify({
              deploymentId: AD_DEPLOYMENT_ID,
              templateId: AD_TEMPLATE_ID,
              model: AD_MODEL,
              region: AD_REGION,
              agents: registeredAgentNames.map((name) => ({
                name,
                url: `/agents/${name}`,
              })),
            }),
            {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "X-AD-Deployment": AD_DEPLOYMENT_ID,
              },
            },
          ),
        );
      }

      return withCors(
        new Response(
          JSON.stringify({
            error: "Not found",
            path: url.pathname,
            hint: `Try /agents/${registeredAgentNames[0] ?? "unknown"} or /health`,
          }),
          {
            status: 404,
            headers: {
              "Content-Type": "application/json",
              "X-AD-Deployment": AD_DEPLOYMENT_ID,
            },
          },
        ),
      );
    },
  };
}
