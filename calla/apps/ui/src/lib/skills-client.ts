/**
 * Skills & Agent-Config REST Adapter
 * ──────────────────────────────────
 * Typed client over the brain's multi-tenant behavior layer (skills +
 * agent persona configs). Mirrors mastra-client conventions:
 *   - base URL from runtime config (getBrainUrl, default "/brain" proxy)
 *   - authFetch (cookie / Bearer edge-JWT depending on deployment)
 *   - JSON error bodies ({error: "…"}) thrown as Error(message)
 *   - disabled mode (BRAIN_URL ""/"none"): reads resolve empty, writes
 *     throw SKILLS_CLIENT_DISABLED so callers can toast a real reason.
 *
 * Endpoints (frozen contract, see @calla/shared SKILLS_ROUTES):
 *   GET    {base}/skills?agentId=                    → { skills: SkillRecord[] }
 *   POST   {base}/skills/:agentId                    → { skill }        (409 duplicate)
 *   PUT    {base}/skills/:agentId/:name              → { skill }        (version bump)
 *   DELETE {base}/skills/:agentId/:name              → { ok }           (builtin → 400)
 *   GET    {base}/agents/configs                     → { configs: AgentConfigRecord[] }
 *   POST   {base}/agents/configs                     → { config }
 *   PUT    {base}/agents/configs/:agentId            → { config }
 *   GET    {base}/agents/:agentId/skills             → { agentId, skills, instructionsVersion }
 */

import type { AgentConfigRecord, SkillRecord, SkillSource } from "@calla/shared";
import { SKILLS_ROUTES } from "@calla/shared";
import { getBrainUrl } from "@/config";
import { authFetch } from "@/hooks/useAuthFetch";

// ─── Types ───────────────────────────────────────────────────────

/** Thrown by every mutation when the brain is disabled (BRAIN_URL unset/"none"). */
export const SKILLS_CLIENT_DISABLED =
  "Brain not configured — set BRAIN_URL to manage skills and agent configs.";

export interface CreateSkillInput {
  name: string;
  description: string;
  instructions: string;
}

export interface UpdateSkillInput {
  description?: string;
  instructions?: string;
}

export interface CreateConfigInput {
  agentId: string;
  name: string;
  description?: string;
  instructions: string;
}

export interface UpdateConfigInput {
  name?: string;
  description?: string;
  instructions?: string;
  enabled?: boolean;
}

export interface ResolvedSkillEntry {
  name: string;
  description: string;
  source: SkillSource;
}

export interface ResolvedSkillsResponse {
  agentId: string;
  skills: ResolvedSkillEntry[];
  instructionsVersion: number;
}

export interface SkillsClient {
  /** False when BRAIN_URL is empty/"none" — reads no-op, writes throw. */
  enabled: boolean;
  /** Resolved brain base URL. */
  baseUrl: string;
  listSkills(agentId: string): Promise<SkillRecord[]>;
  createSkill(agentId: string, input: CreateSkillInput): Promise<SkillRecord>;
  upsertSkill(agentId: string, name: string, input: UpdateSkillInput): Promise<SkillRecord>;
  deleteSkill(agentId: string, name: string): Promise<void>;
  listConfigs(): Promise<AgentConfigRecord[]>;
  createConfig(input: CreateConfigInput): Promise<AgentConfigRecord>;
  updateConfig(agentId: string, patch: UpdateConfigInput): Promise<AgentConfigRecord>;
  resolvedSkills(agentId: string): Promise<ResolvedSkillsResponse>;
}

// ─── Helpers ─────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** Pull a human-readable message out of a non-OK JSON (or text) response. */
async function errorFromResponse(res: Response, action: string): Promise<Error> {
  let message = `${res.status} ${res.statusText}`.trim();
  try {
    const data: unknown = await res.json();
    const rec = asRecord(data);
    if (typeof rec.error === "string" && rec.error) message = rec.error;
    else if (typeof rec.message === "string" && rec.message) message = rec.message;
  } catch {
    // Non-JSON error body — keep the status line.
  }
  return new Error(`${action}: ${message}`);
}

// ─── Factory ─────────────────────────────────────────────────────

export function createSkillsClient(baseUrl: string = getBrainUrl()): SkillsClient {
  const base = (baseUrl ?? "").trim().replace(/\/+$/, "");
  const enabled = base.length > 0 && base.toLowerCase() !== "none";

  async function request<T>(
    action: string,
    path: string,
    init?: { method?: string; body?: unknown },
  ): Promise<T> {
    const res = await authFetch(`${base}${path}`, {
      method: init?.method ?? "GET",
      headers: {
        Accept: "application/json",
        ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) throw await errorFromResponse(res, action);
    return (await res.json()) as T;
  }

  function guardDisabled(): void {
    if (!enabled) throw new Error(SKILLS_CLIENT_DISABLED);
  }

  return {
    enabled,
    baseUrl: base,

    async listSkills(agentId: string): Promise<SkillRecord[]> {
      if (!enabled) return [];
      const data = await request<{ skills?: SkillRecord[] }>(
        "listSkills",
        SKILLS_ROUTES.listSkills(agentId),
      );
      return Array.isArray(data.skills) ? data.skills : [];
    },

    async createSkill(agentId: string, input: CreateSkillInput): Promise<SkillRecord> {
      guardDisabled();
      const data = await request<{ skill: SkillRecord }>(
        "createSkill",
        SKILLS_ROUTES.createSkill(agentId),
        { method: "POST", body: input },
      );
      return data.skill;
    },

    async upsertSkill(
      agentId: string,
      name: string,
      input: UpdateSkillInput,
    ): Promise<SkillRecord> {
      guardDisabled();
      const data = await request<{ skill: SkillRecord }>(
        "upsertSkill",
        SKILLS_ROUTES.upsertSkill(agentId, name),
        { method: "PUT", body: input },
      );
      return data.skill;
    },

    async deleteSkill(agentId: string, name: string): Promise<void> {
      guardDisabled();
      await request<{ ok: boolean }>(
        "deleteSkill",
        SKILLS_ROUTES.upsertSkill(agentId, name),
        { method: "DELETE" },
      );
    },

    async listConfigs(): Promise<AgentConfigRecord[]> {
      if (!enabled) return [];
      const data = await request<{ configs?: AgentConfigRecord[] }>(
        "listConfigs",
        SKILLS_ROUTES.listConfigs,
      );
      return Array.isArray(data.configs) ? data.configs : [];
    },

    async createConfig(input: CreateConfigInput): Promise<AgentConfigRecord> {
      guardDisabled();
      const data = await request<{ config: AgentConfigRecord }>(
        "createConfig",
        SKILLS_ROUTES.createConfig,
        { method: "POST", body: input },
      );
      return data.config;
    },

    async updateConfig(
      agentId: string,
      patch: UpdateConfigInput,
    ): Promise<AgentConfigRecord> {
      guardDisabled();
      const data = await request<{ config: AgentConfigRecord }>(
        "updateConfig",
        SKILLS_ROUTES.updateConfig(agentId),
        { method: "PUT", body: patch },
      );
      return data.config;
    },

    async resolvedSkills(agentId: string): Promise<ResolvedSkillsResponse> {
      if (!enabled) return { agentId, skills: [], instructionsVersion: 0 };
      return request<ResolvedSkillsResponse>(
        "resolvedSkills",
        SKILLS_ROUTES.resolvedSkills(agentId),
      );
    },
  };
}

/** Default client bound to the runtime BRAIN_URL config. */
export const skillsClient: SkillsClient = createSkillsClient();
