/**
 * Calla skills & agent-configuration records.
 *
 * Multi-tenant behavior layer: every agent's persona (instructions) and its
 * skill files (markdown + YAML-frontmatter style, like bi-edge/skills/*.md)
 * live in the brain's store, are editable at runtime (UI Skills tab / REST),
 * and resolve into Mastra agents dynamically (createSkill + addAgent).
 */

export type SkillSource = "builtin" | "uploaded";

export interface SkillRecord {
  id: string;
  agentId: string;
  /** Slug: lowercase letters/numbers/hyphens, 1-64 chars (Mastra skill name rule). */
  name: string;
  /** What the skill does / when to use it (shown to the LLM for selection). */
  description: string;
  /** Markdown body (the SKILL.md content). */
  instructions: string;
  /** Optional bundled reference files, keyed by relative path. */
  references?: Record<string, string>;
  source: SkillSource;
  version: number;
  updatedAt: string;
}

export interface AgentConfigRecord {
  /** Mastra agent key/id (e.g. "orchestrator", "miles"). */
  agentId: string;
  name: string;
  description?: string | null;
  /** System instructions (the per-tenant "instructions.md"). */
  instructions: string;
  /** Optional model override; null → brain default (LLM_MODEL / anthropic). */
  model?: string | null;
  source: SkillSource;
  enabled: boolean;
  version: number;
  updatedAt: string;
}

/** REST contract between UI and brain (all under the brain base URL). */
export const SKILLS_ROUTES = {
  listSkills: (agentId?: string) =>
    agentId ? `/skills?agentId=${encodeURIComponent(agentId)}` : "/skills",
  createSkill: (agentId: string) => `/skills/${encodeURIComponent(agentId)}`,
  upsertSkill: (agentId: string, name: string) =>
    `/skills/${encodeURIComponent(agentId)}/${encodeURIComponent(name)}`,
  listConfigs: "/agents/configs",
  createConfig: "/agents/configs",
  updateConfig: (agentId: string) => `/agents/configs/${encodeURIComponent(agentId)}`,
  resolvedSkills: (agentId: string) => `/agents/${encodeURIComponent(agentId)}/skills`,
} as const;

export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
