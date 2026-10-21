/**
 * CallaStore — the durable, dialect-agnostic Calla store contract.
 *
 * Two implementations share this interface:
 *  - DrizzlePgStore  (drizzle-orm/node-postgres + pg)   — real Postgres
 *  - LibSqlStore     (@libsql/client raw SQL)           — embedded dev/smoke
 *
 * Selection is CONNECTION-STRING-PRESENCE driven (pattern adapted from
 * @elizaos/plugin-sql, MIT, (c) 2025 Shaw Walters and elizaOS Contributors):
 * isRealPostgresUrl(DATABASE_URL) → PG, else LibSQL at LIBSQL_URL ?? file:local.db.
 *
 * Row types use ISO-8601 strings for timestamps and plain objects for JSON
 * columns so both dialects normalize to one wire shape.
 */
import type {
  AgentConfigRecord,
  AgentRuntime,
  AgentType,
  ApprovalSource,
  ApprovalStatus,
  CallaUserRole,
  DeploymentConfigPayload,
  RiskLevel,
  SkillRecord,
  SkillSource,
} from "@calla/shared";
import type {
  AppendAuditInput,
  AuditLogStore,
  AuditRecord,
  VerifyAuditResult,
} from "./hashchain.js";

export type CallaStoreKind = "pg" | "libsql";

// ─── Row shapes ──────────────────────────────────────────────────

export interface ApprovalRow {
  id: string;
  source: ApprovalSource;
  agentId: string;
  toolName: string;
  args: Record<string, unknown>;
  risk: RiskLevel;
  summary: string | null;
  status: ApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string;
  runId: string | null;
  toolCallId: string | null;
  deploymentId: string | null;
}

export interface RecordApprovalInput {
  /** Defaults to "mastra" (brain-side HITL). */
  source?: ApprovalSource;
  agentId: string;
  toolName: string;
  args?: Record<string, unknown>;
  /** Defaults to "medium". */
  risk?: RiskLevel;
  summary?: string | null;
  /** Defaults to "pending"; decisions append rows with approved/declined/expired. */
  status?: ApprovalStatus;
  /** Defaults to "human". */
  decidedBy?: string;
  runId?: string | null;
  toolCallId?: string | null;
  deploymentId?: string | null;
}

export interface ListApprovalsOptions {
  status?: ApprovalStatus;
  agentId?: string;
  runId?: string;
  /** Default 100, capped at 500. */
  limit?: number;
}

export interface AgentRegistryRow {
  id: string;
  name: string;
  type: AgentType;
  runtime: AgentRuntime;
  status: string;
  capabilities: string[];
  meta: Record<string, unknown>;
  deploymentId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UpsertAgentInput {
  /** Stable id — rows are upserted by (name, type, runtime) when omitted. */
  id?: string;
  name: string;
  type: AgentType;
  runtime: AgentRuntime;
  status?: string;
  capabilities?: string[];
  meta?: Record<string, unknown>;
  deploymentId?: string | null;
}

/** A self-hosted (standalone) auth user row — see schema.ts calla_users. */
export interface CallaUserRow {
  id: string;
  email: string;
  /** Format "scrypt:<saltB64>:<hashB64>" (never returned over the wire). */
  passwordHash: string;
  role: CallaUserRole;
  createdAt: string;
  lastLoginAt: string | null;
}

export interface CreateUserInput {
  email: string;
  passwordHash: string;
  /** Defaults to "admin". */
  role?: CallaUserRole;
}

// ─── Skills & agent configs (multi-tenant behavior layer) ────────

/** Insert/update input for a calla_skills row (see @calla/shared SkillRecord). */
export interface UpsertSkillInput {
  agentId: string;
  /** Slug: SKILL_NAME_RE, 1-64 chars (validated by the route layer). */
  name: string;
  description?: string;
  instructions: string;
  /** JSON map of bundled reference files (relative path → content). */
  references?: Record<string, string>;
  /** Insert-only: defaults to "uploaded"; updates keep the row's source. */
  source?: SkillSource;
}

/** Delete outcome — builtin skills are protected (edit instead of delete). */
export type DeleteSkillResult =
  | { deleted: true; skill: SkillRecord }
  | { deleted: false; reason: "builtin" | "not-found" };

/** Singleton deployment-config row (see schema.ts calla_deployment_config). */
export interface DeploymentConfigRow {
  id: string;
  payload: DeploymentConfigPayload;
  updatedAt: string;
}

/** Insert/update input for a calla_agent_configs row. */
export interface UpsertAgentConfigInput {
  agentId: string;
  name: string;
  description?: string | null;
  instructions: string;
  /** Optional model override; null → brain default (resolveModel()). */
  model?: string | null;
  /** Insert-only: defaults to "uploaded"; updates keep the row's source. */
  source?: SkillSource;
  enabled?: boolean;
}

// ─── Store contract ──────────────────────────────────────────────

export interface CallaStore extends AuditLogStore {
  readonly kind: CallaStoreKind;
  /** Human-readable target (redacted DSN / libsql url) for logs + /health. */
  readonly target: string;

  /** Idempotent CREATE TABLE IF NOT EXISTS bootstrap for the calla_* tables. */
  bootstrap(): Promise<void>;

  recordApproval(input: RecordApprovalInput): Promise<ApprovalRow>;
  listApprovals(options?: ListApprovalsOptions): Promise<ApprovalRow[]>;

  /** Hash-chained audit append (see ./hashchain.ts). */
  appendAudit(input: AppendAuditInput): Promise<AuditRecord>;
  verifyAudit(): Promise<VerifyAuditResult>;

  /** ElizaOS-shaped TTL cache; returns null for missing/expired keys. */
  cacheGet<T = unknown>(key: string, agentId: string): Promise<T | null>;
  cacheSet(key: string, agentId: string, value: unknown, ttlMs?: number | null): Promise<void>;

  upsertAgent(agent: UpsertAgentInput): Promise<AgentRegistryRow>;
  listAgents(): Promise<AgentRegistryRow[]>;

  // ─── Self-hosted (standalone) auth users ──────────────────────
  /** Insert a new user; rejects on duplicate email (UNIQUE constraint). */
  createUser(input: CreateUserInput): Promise<CallaUserRow>;
  /** Look up a user by email (case-insensitive); null when absent. */
  findUserByEmail(email: string): Promise<CallaUserRow | null>;
  /** Number of registered users — 0 gates the /auth/register bootstrap. */
  countUsers(): Promise<number>;
  /** Stamp last_login_at = now for a successful login. */
  touchUserLogin(id: string): Promise<void>;

  // ─── Skills (per-agent, hot-swappable behavior) ─────────────────
  /** All skills, or one agent's skills when agentId is given (name ASC). */
  listSkills(agentId?: string): Promise<SkillRecord[]>;
  getSkill(agentId: string, name: string): Promise<SkillRecord | null>;
  /**
   * INSERT .. ON CONFLICT (agent_id, name) upsert; updates bump version + 1
   * and keep the row's source (builtin edits stay builtin).
   */
  upsertSkill(input: UpsertSkillInput): Promise<SkillRecord>;
  /** uploaded → delete; builtin → { deleted:false, reason:"builtin" }. */
  deleteSkill(agentId: string, name: string): Promise<DeleteSkillResult>;

  // ─── Agent configs (per-agent persona/instructions/model) ───────
  listAgentConfigs(): Promise<AgentConfigRecord[]>;
  getAgentConfig(agentId: string): Promise<AgentConfigRecord | null>;
  /** Upsert by agent_id; updates bump version + 1 and keep source. */
  upsertAgentConfig(input: UpsertAgentConfigInput): Promise<AgentConfigRecord>;

  // ─── Deployment config (per-deployment feature flags) ───────────
  /** Singleton row (id "default"); null when never written. */
  getDeploymentConfig(): Promise<DeploymentConfigRow | null>;
  /** Upsert the singleton row with a fresh payload + updated_at. */
  setDeploymentConfig(payload: DeploymentConfigPayload): Promise<DeploymentConfigRow>;

  /** Best-effort teardown (pg pool end); safe to ignore in dev. */
  close(): Promise<void>;
}
