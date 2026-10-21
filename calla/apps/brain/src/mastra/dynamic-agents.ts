/**
 * Dynamic agent factory — store-driven Mastra agents (multi-tenant behavior).
 *
 * resolveDynamicAgent(agentId) rebuilds an Agent from its calla_agent_configs
 * row (persona/instructions/model) + calla_skills rows (inline skills via
 * createSkill), cached by a version fingerprint so edits hot-swap WITHOUT a
 * restart:
 *
 *   cache key = `${agentId}@${configVersion}:${skillsVersionHash}`
 *
 * Registration strategy (Mastra 1.74): mastra.addAgent() silently SKIPS
 * duplicate keys, and mastra.listAgents() returns the live internal record,
 * so rebuilt agents are wired with the internal __registerMastra /
 * __registerPrimitives hooks and swapped into the record in place
 * (rebuild+replace). We ALSO keep our own registry Map (source of truth for
 * server.ts resolveAgent, which consults it FIRST); invalidate() evicts both
 * the Map entry and any mastra record we own, restoring static behavior.
 *
 * Resolution never throws: store/LLM-config problems return null and callers
 * fall back to the static mastra registry.
 */
import { createHash } from "node:crypto";
import { Agent } from "@mastra/core/agent";
import type { ToolsInput } from "@mastra/core/agent";
import { createSkill } from "@mastra/core/skills";
import type { SkillRecord } from "@calla/shared";
import { getCallaStore } from "../store/index.js";
import { mastra } from "./index.js";
import { resolveModel } from "./agents/orchestrator.js";
import { dispatchEdgeTask } from "./tools/dispatch-edge-task.js";
import { sendExternalEmail } from "./tools/send-email.js";
import { listFleet } from "./tools/list-fleet.js";

interface CachedAgent {
  /** `${agentId}@${configVersion}:${skillsVersionHash}` */
  cacheKey: string;
  agent: Agent;
}

/** Own registry of dynamically-built agents (source of truth for resolveAgent). */
const registry = new Map<string, CachedAgent>();

/** Mastra registry keys this module inserted/replaced (safe to evict). */
const ownedMastraKeys = new Set<string>();

function skillsVersionHash(skills: SkillRecord[]): string {
  const fingerprint = [...skills]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((s) => `${s.name}:${s.version}`)
    .join("|");
  return createHash("sha1").update(fingerprint).digest("hex").slice(0, 12);
}

function toolsForAgent(agentId: string): ToolsInput {
  // The orchestrator keeps its fleet tools; other personas start tool-less.
  if (agentId !== "orchestrator") return {};
  return { dispatchEdgeTask, sendExternalEmail, listFleet };
}

function buildAgent(config: {
  agentId: string;
  name: string;
  description?: string | null;
  instructions: string;
  model?: string | null;
  skills: SkillRecord[];
}): Agent {
  return new Agent({
    id: config.agentId,
    name: config.name,
    description: config.description ?? undefined,
    instructions: config.instructions,
    // Lazy: provider is constructed on first LLM call (same as the static path).
    model: () => resolveModel(config.model ?? undefined),
    tools: toolsForAgent(config.agentId),
    skills: config.skills.map((s) =>
      createSkill({
        name: s.name,
        // Mastra requires a non-empty description (1-1024 chars).
        description: (s.description || s.name).slice(0, 1024),
        instructions: s.instructions,
        ...(s.references && Object.keys(s.references).length > 0
          ? { references: s.references }
          : {}),
      }),
    ),
  });
}

/**
 * Register (or rebuild+replace) the agent in the live mastra registry so
 * Studio, channels, and mastra.getAgent see the store-driven build too.
 * addAgent() handles brand-new keys; duplicates are replaced in place after
 * wiring the mastra instance (storage/logger) into the fresh agent.
 */
function attachToMastra(agent: Agent, key: string): void {
  try {
    const agents = mastra.listAgents() as Record<string, Agent>;
    if (agents[key] === agent) return;
    if (!agents[key]) {
      mastra.addAgent(agent, key);
      ownedMastraKeys.add(key);
      return;
    }
    // Rebuild+replace: mirror what addAgent wires internally, then swap the
    // live record (listAgents() returns the internal #agents object).
    agent.__registerMastra(mastra);
    agent.__registerPrimitives({
      logger: mastra.getLogger(),
      storage: mastra.getStorage(),
      agents: mastra.listAgents(),
    });
    agents[key] = agent;
    ownedMastraKeys.add(key);
  } catch (err) {
    // Non-fatal: server.ts resolveAgent consults our own registry FIRST.
    console.warn(
      `[calla-brain] dynamic agent "${key}" not attached to the mastra registry ` +
        `(still resolvable via the dynamic factory):`,
      err,
    );
  }
}

function evict(agentId: string): void {
  registry.delete(agentId);
  try {
    const agents = mastra.listAgents() as Record<string, Agent>;
    if (ownedMastraKeys.has(agentId) && agents[agentId]) {
      delete agents[agentId];
      ownedMastraKeys.delete(agentId);
    }
  } catch {
    // best-effort
  }
}

/**
 * Resolve the store-driven agent for agentId, or null when no enabled
 * calla_agent_configs row exists (caller falls back to the static registry).
 * Never throws — store/build failures are logged and resolve to null.
 */
export async function resolveDynamicAgent(agentId: string): Promise<Agent | null> {
  if (!agentId) return null;
  try {
    const store = getCallaStore();
    const config = await store.getAgentConfig(agentId);
    if (!config || !config.enabled) {
      // Parked/deleted config: drop any stale dynamic build so the static
      // registry fallback (or 404) wins.
      if (registry.has(agentId)) evict(agentId);
      return null;
    }
    const skills = await store.listSkills(agentId);
    const cacheKey = `${agentId}@${config.version}:${skillsVersionHash(skills)}`;
    const hit = registry.get(agentId);
    if (hit && hit.cacheKey === cacheKey) return hit.agent;

    const agent = buildAgent({
      agentId: config.agentId,
      name: config.name,
      description: config.description,
      instructions: config.instructions,
      model: config.model,
      skills,
    });
    registry.set(agentId, { cacheKey, agent });
    attachToMastra(agent, config.agentId);
    return agent;
  } catch (err) {
    console.error(`[calla-brain] resolveDynamicAgent(${agentId}) failed:`, err);
    return null;
  }
}

/**
 * Drop the cached build for agentId (called by the skills/configs CRUD
 * routes); the next resolve rebuilds from the store with the new versions.
 */
export function invalidate(agentId: string): void {
  evict(agentId);
}

/** Agent ids with a cached dynamic build (surfaced by GET /). */
export function listDynamicAgentIds(): string[] {
  return [...registry.keys()];
}
