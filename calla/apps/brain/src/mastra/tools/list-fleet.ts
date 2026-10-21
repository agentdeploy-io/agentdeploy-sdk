import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { edgeBaseUrl } from "./dispatch-edge-task.js";

/**
 * Read-only view of the edge fleet: GET ${CALLA_EDGE_URL}/fleet.
 * Lets the orchestrator see which edge agents exist and their statuses
 * before dispatching steps. No approval gate — it is a pure read.
 */
export const listFleet = createTool({
  id: "list-fleet",
  description:
    "List the Calla edge fleet (Cloudflare edge agents) with their statuses and capabilities. Call this before dispatch-edge-task to discover valid edgeAgentId values.",
  inputSchema: z.object({}),
  requireApproval: false,
  execute: async () => {
    const url = `${edgeBaseUrl()}/fleet`;
    let res: Response;
    try {
      res = await fetch(url, { headers: { accept: "application/json" } });
    } catch (err) {
      return {
        ok: false,
        agents: [],
        error: `edge runtime unreachable at ${url}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    const raw = await res.text();
    if (!res.ok) {
      return {
        ok: false,
        agents: [],
        error: `edge responded ${res.status} ${res.statusText}: ${raw.slice(0, 500)}`,
      };
    }

    try {
      const parsed: unknown = JSON.parse(raw);
      const agents = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as { agents?: unknown })?.agents)
          ? (parsed as { agents: unknown[] }).agents
          : [];
      return { ok: true, agents };
    } catch (err) {
      return {
        ok: false,
        agents: [],
        error: `edge returned malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
});
