/**
 * Calla-owned durable store schema (Drizzle, pg dialect).
 *
 * Schema patterns adapted from @elizaos/plugin-sql
 * (MIT, (c) 2025 Shaw Walters and elizaOS Contributors):
 *  - a `cache` table with composite PK (key, agentId), jsonb value and an
 *    expiresAt TTL column (ElizaOS plugin-sql cache shape);
 *  - Calla-prefixed table names only (`calla_*`) so we NEVER collide with
 *    Mastra's own tables — Mastra owns its storage schema and migrations,
 *    Calla owns only these tables. We deliberately skip ElizaOS's 18-table
 *    conversation schema and runtime migrator.
 *
 * This module is the pg-dialect source of truth (used by DrizzlePgStore).
 * The LibSQL dev path does NOT run drizzle migrations; LibSqlStore bootstraps
 * with equivalent hand-written CREATE TABLE IF NOT EXISTS DDL (TEXT/JSON
 * instead of timestamptz/jsonb).
 */
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  unique,
  uuid,
} from "drizzle-orm/pg-core";

/**
 * Agent registry — one row per known Calla agent (brain/edge/sub/core/
 * classifier). Read-only over HTTP for now; fleet sync lands later.
 */
export const callaAgents = pgTable("calla_agents", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  /** edge | brain | sub | core | classifier (shared AgentType). */
  type: text("type").notNull(),
  /** cloudflare | fly (shared AgentRuntime). */
  runtime: text("runtime").notNull(),
  status: text("status").notNull().default("idle"),
  capabilities: jsonb("capabilities").notNull().default([]),
  meta: jsonb("meta").notNull().default({}),
  deploymentId: text("deployment_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Approval history — append-only record of every HITL gate across sources
 * (mastra brain runs today; cloudflare/core/data rows come from fleet sync
 * later). Pending gates are inserted on suspend; the decision appends a new
 * row (status approved/declined/expired) rather than mutating, so the table
 * doubles as an audit trail of the inbox.
 */
export const callaApprovals = pgTable(
  "calla_approvals",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** mastra | cloudflare | core | data (shared ApprovalSource). */
    source: text("source").notNull(),
    agentId: text("agent_id").notNull(),
    toolName: text("tool_name").notNull(),
    args: jsonb("args").notNull().default({}),
    /** low | medium | high | critical (shared RiskLevel). */
    risk: text("risk").notNull().default("medium"),
    summary: text("summary"),
    /** pending | approved | declined | expired (shared ApprovalStatus). */
    status: text("status").notNull().default("pending"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp("decided_at", { withTimezone: true }),
    decidedBy: text("decided_by").notNull().default("human"),
    runId: text("run_id"),
    toolCallId: text("tool_call_id"),
    deploymentId: text("deployment_id"),
  },
  (t) => [
    index("calla_approvals_agent_id_idx").on(t.agentId),
    index("calla_approvals_status_idx").on(t.status),
    index("calla_approvals_requested_at_idx").on(t.requestedAt),
  ],
);

/**
 * Hash-chained audit log — SQL equivalent of the @thirtieth/elizaos-plugin-
 * cloudflare audit log (MIT, (c) 2026 thirtieth): {seq, ts, kind, entry,
 * prev_hash, entry_hash} with a GENESIS root; verifyAudit() recomputes the
 * chain to detect tampering.
 */
export const callaAudit = pgTable("calla_audit", {
  seq: serial("seq").primaryKey(),
  ts: timestamp("ts", { withTimezone: true }).notNull().defaultNow(),
  agentId: text("agent_id"),
  kind: text("kind").notNull(),
  entry: jsonb("entry").notNull(),
  prevHash: text("prev_hash").notNull(),
  entryHash: text("entry_hash").notNull(),
});

/**
 * TTL cache — ElizaOS plugin-sql `cache` table shape: composite PK
 * (key, agentId), jsonb value, expiresAt for TTL eviction on read.
 */
export const callaCache = pgTable(
  "calla_cache",
  {
    key: text("key").notNull(),
    agentId: text("agent_id").notNull(),
    value: jsonb("value").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
  },
  (t) => [primaryKey({ columns: [t.key, t.agentId] })],
);

/**
 * Self-hosted (standalone) auth users — email + scrypt password hash.
 * Powers the fourth auth mode where the brain issues its own HS256 JWTs
 * (see @calla/shared signCallaToken / verifyCallaToken) instead of relying on
 * the agentdeploy.io marketplace. The first registered user is the `admin`;
 * `countUsers() === 0` gates the one-shot /auth/register bootstrap.
 */
export const callaUsers = pgTable(
  "calla_users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    email: text("email").notNull().unique(),
    /** Format "scrypt:<saltB64>:<hashB64>" (see ../auth/password.ts). */
    passwordHash: text("password_hash").notNull(),
    /** admin | operator (shared CallaUserRole). */
    role: text("role").notNull().default("admin"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
  },
  (t) => [index("calla_users_email_idx").on(t.email)],
);

/**
 * Skills — per-agent markdown skill files (bi-edge/skills/*.md style:
 * YAML frontmatter + body). Rows resolve into Mastra inline skills via
 * createSkill() at agent-build time (see ../mastra/dynamic-agents.ts), so
 * behavior is hot-swappable per tenant without code changes or restarts.
 * `source` distinguishes seeded builtins (protected from DELETE) from
 * uploaded/edited skills. UNIQUE (agent_id, name) mirrors Mastra's skill
 * name rule; `ref_json` holds the references map (relative path → content).
 */
export const callaSkills = pgTable(
  "calla_skills",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    agentId: text("agent_id").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    instructions: text("instructions").notNull(),
    refJson: jsonb("ref_json").notNull().default({}),
    /** builtin | uploaded (shared SkillSource). */
    source: text("source").notNull().default("uploaded"),
    version: integer("version").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("calla_skills_agent_id_name_key").on(t.agentId, t.name),
    index("calla_skills_agent_id_idx").on(t.agentId),
  ],
);

/**
 * Agent configs — the per-tenant persona/instructions/model for each agent
 * id (e.g. "orchestrator", "miles"). The dynamic agent factory rebuilds a
 * Mastra Agent from the row (+ its skills) whenever the version fingerprint
 * changes; `enabled=false` parks the config (resolution falls back to the
 * static registry). `model` is an optional override resolved through the
 * same openai-compatible/anthropic providers as the brain default.
 */
export const callaAgentConfigs = pgTable("calla_agent_configs", {
  agentId: text("agent_id").primaryKey(),
  name: text("name").notNull(),
  description: text("description"),
  instructions: text("instructions").notNull(),
  model: text("model"),
  /** builtin | uploaded (shared SkillSource); DDL default kept for parity. */
  source: text("source").notNull().default("custom"),
  enabled: boolean("enabled").notNull().default(true),
  version: integer("version").notNull().default(1),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Deployment config — singleton row (id "default") holding the
 * per-deployment feature flags (enabled module set). Every Calla deployment
 * is isolated (one micro-VM/edge per client), so a single row is the whole
 * multi-tenancy surface. `payload` is a DeploymentConfigPayload
 * ({ modules?: ModuleId[], preset?, updatedBy? }) — absent `modules` means
 * all enabled. See @calla/shared modules.ts.
 */
export const callaDeploymentConfig = pgTable("calla_deployment_config", {
  id: text("id").primaryKey().default("default"),
  payload: jsonb("payload").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const callaSchema = {
  callaAgents,
  callaApprovals,
  callaAudit,
  callaCache,
  callaUsers,
  callaSkills,
  callaAgentConfigs,
  callaDeploymentConfig,
};