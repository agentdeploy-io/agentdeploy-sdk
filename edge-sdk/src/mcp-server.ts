// ── Edge MCP server (MCP 2026-07-28 stateless spec) ──────────────────────────
//
// Exposes an agent's guarded tools as a stateless MCP server running directly
// in the Worker — no Durable Object, no session, no stdio. Each request builds
// a fresh server instance, so any request can land on any instance.
//
// The generated worker calls this from its onRequest:
//
//   const adMcpFetch = createEdgeMcpRoute({ serverName, version, tools });
//   ...
//   async onRequest(request) {
//     if (url.pathname.endsWith("/mcp")) return adMcpFetch(this, request);
//   }
//
// Auth: the platform's edge-JWT gate wraps the whole worker before onRequest,
// so /mcp inherits it. External MCP clients (Cursor, Claude Desktop via
// mcp-remote, the agent CLI) present the same Bearer token.

import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";

export { McpServer } from "@modelcontextprotocol/server";
export { createMcpHandler } from "agents/mcp/server";

export interface EdgeMcpToolDef {
  name: string;
  description: string;
  /**
   * Zod raw shape for the tool input (e.g. { q: z.string() }) — the format
   * `McpServer.registerTool` expects. Typed loosely because the MCP SDK's
   * zod version differs from the consumer's; validated at runtime via
   * Standard Schema.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inputSchema: Record<string, any>;
}

export interface EdgeMcpRouteOptions {
  serverName: string;
  version: string;
  /** Guarded tools to expose (names must exist in the agent's toolset). */
  tools: EdgeMcpToolDef[];
}

export interface EdgeMcpAgentLike {
  callTool(name: string, input: unknown): Promise<unknown>;
}

function toolResultFrom(value: unknown) {
  const text =
    typeof value === "string" ? value : JSON.stringify(value ?? null);
  return { content: [{ type: "text", text: text.slice(0, 100_000) }] };
}

export function createEdgeMcpRoute(opts: EdgeMcpRouteOptions) {
  return function adMcpFetch(ad: EdgeMcpAgentLike, request: Request): Promise<Response> {
    const url = new URL(request.url);
    const server = new McpServer({
      name: opts.serverName,
      version: opts.version,
    });
    for (const t of opts.tools) {
      // @ts-expect-error — MCP SDK's own zod version types its shapes
      // differently from the consumer's; the shape is validated at runtime
      // via Standard Schema.
      server.registerTool(
        t.name,
        {
          description: t.description,
          inputSchema: t.inputSchema,
        },
        async (args: Record<string, unknown>) => {
          try {
            return toolResultFrom(await ad.callTool(t.name, args ?? {}));
          } catch (e) {
            return {
              isError: true,
              content: [
                { type: "text", text: `tool ${t.name} failed: ${String((e as Error).message || e)}` },
              ],
            };
          }
        },
      );
    }
    const handler = createMcpHandler(() => server, {
      route: url.pathname,
      corsOptions: false,
      allowedOriginHostnames: "*",
    });
    return handler.fetch(request);
  };
}
