/**
 * Builtin skill files + loader — the gradient3.io default stack.
 *
 * Origin: markdown files copied VERBATIM from packages/bi-edge/skills/
 * {identity,outreach-style,icp,objection-handling,compliance}.md — the
 * canonical lead-gen skill-file style (YAML frontmatter + markdown body).
 * They are seeded into calla_skills for builtin agents (see ./seed.ts) and
 * become ordinary store rows a tenant can then edit in place.
 *
 * Parsing decisions (documented per task):
 *  - `instructions` = the markdown body WITHOUT the frontmatter block;
 *  - frontmatter fields are preserved as references["frontmatter.json"]
 *    (a JSON map), so nothing is lost when the row round-trips through
 *    createSkill() → Mastra inline skills;
 *  - `description` = frontmatter `description` when present, else the first
 *    `#` heading text, else the first non-empty body line, else the name
 *    (Mastra requires a non-empty description ≤ 1024 chars).
 *
 * The frontmatter parser is a tiny YAML subset: `key: value` lines between
 * `---` fences. Scalars resolve as booleans, numbers, JSON values (quoted
 * strings / arrays), `[a, b]` bare comma lists, or plain strings.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Max description length enforced by Mastra's skill metadata validation. */
const MAX_DESCRIPTION_LENGTH = 1024;

/** Builtin files that are NOT skills (agent-config instructions etc.). */
const NON_SKILL_FILES = new Set(["orchestrator-instructions.md"]);

export interface ParsedSkillFile {
  /** Slug from the file name (e.g. "outreach-style"). */
  name: string;
  description: string;
  /** Markdown body without the frontmatter block. */
  instructions: string;
  /** { "frontmatter.json": <json> } when the file has frontmatter. */
  references: Record<string, string>;
  /** Raw parsed frontmatter fields. */
  frontmatter: Record<string, unknown>;
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === "") return "";
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null") return null;
  if (v.startsWith("[")) {
    try {
      return JSON.parse(v);
    } catch {
      const inner = v.slice(1, v.endsWith("]") ? -1 : undefined) ?? "";
      return inner
        .split(",")
        .map((part) => parseScalar(part))
        .filter((part) => part !== "");
    }
  }
  if (v.startsWith("{")) {
    try {
      return JSON.parse(v);
    } catch {
      return v;
    }
  }
  try {
    const json = JSON.parse(v) as unknown;
    if (typeof json !== "object") return json; // "quoted string" | number
  } catch {
    // plain scalar
  }
  return v.replace(/^["']|["']$/g, "");
}

/** Tiny YAML-subset frontmatter parser: `key: value` lines between --- fences. */
export function parseFrontmatter(content: string): {
  frontmatter: Record<string, unknown>;
  body: string;
} {
  const lines = content.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return { frontmatter: {}, body: content.trim() };
  }
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i]?.trim() === "---") {
      close = i;
      break;
    }
  }
  if (close === -1) {
    return { frontmatter: {}, body: content.trim() };
  }
  const frontmatter: Record<string, unknown> = {};
  for (const line of lines.slice(1, close)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx <= 0) continue;
    const key = line.slice(0, idx).trim();
    if (key) frontmatter[key] = parseScalar(line.slice(idx + 1));
  }
  return { frontmatter, body: lines.slice(close + 1).join("\n").trim() };
}

function deriveDescription(frontmatter: Record<string, unknown>, body: string, name: string): string {
  const fm = frontmatter.description;
  if (typeof fm === "string" && fm.trim()) return fm.trim();
  for (const line of body.split(/\r?\n/)) {
    const heading = /^#\s+(.+)$/.exec(line.trim());
    if (heading?.[1]) return heading[1].trim();
  }
  const firstText = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !l.startsWith("#"));
  if (firstText) return firstText;
  return name;
}

/** Parse one skill file (file name stem + raw content) into store-ready parts. */
export function parseSkillFile(fileName: string, content: string): ParsedSkillFile {
  const name = fileName.replace(/\.md$/i, "");
  const { frontmatter, body } = parseFrontmatter(content);
  const description = deriveDescription(frontmatter, body, name).slice(0, MAX_DESCRIPTION_LENGTH);
  const references: Record<string, string> =
    Object.keys(frontmatter).length > 0
      ? { "frontmatter.json": JSON.stringify(frontmatter, null, 2) }
      : {};
  return { name, description, instructions: body, references, frontmatter };
}

/**
 * Locate builtin/ next to this module — works from src/ (tsx dev) and from
 * dist/ (tsc build; Docker images keep the src tree alongside dist, so the
 * src fallback resolves there too).
 */
function builtinDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "builtin"),
    path.resolve(here, "..", "..", "..", "src", "mastra", "skills", "builtin"),
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(`[calla-brain] builtin skills dir not found (tried: ${candidates.join(", ")})`);
}

/** Read one builtin file verbatim (e.g. orchestrator-instructions.md). */
export function readBuiltinFile(fileName: string): string {
  return readFileSync(path.join(builtinDir(), fileName), "utf8");
}

/**
 * Builtin skill files for an agent, name-sorted. When `builtin/<agentId>/`
 * exists it is used exclusively (per-agent skill stack, e.g.
 * dental-receptionist); otherwise the shared top-level stack (gradient3.io
 * default) is served. NON_SKILL_FILES is filtered in both cases.
 */
export function loadBuiltinSkills(agentId?: string): ParsedSkillFile[] {
  const base = builtinDir();
  let dir = base;
  if (agentId) {
    const agentDir = path.join(base, agentId);
    if (existsSync(agentDir) && readdirSync(agentDir).some((f) => f.endsWith(".md"))) {
      dir = agentDir;
    }
  }
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && !NON_SKILL_FILES.has(f))
    .sort()
    .map((f) => parseSkillFile(f, readFileSync(path.join(dir, f), "utf8")));
}

/** The builtin orchestrator system instructions (agents/orchestrator.ts + seed). */
export function loadBuiltinOrchestratorInstructions(): string {
  return readBuiltinFile("orchestrator-instructions.md").trim();
}
