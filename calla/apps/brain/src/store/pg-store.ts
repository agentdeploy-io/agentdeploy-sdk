/**
 * DrizzlePgStore — Postgres CallaStore via drizzle-orm/node-postgres + pg.
 *
 * Query building uses the drizzle pg-core schema in ./schema.ts; bootstrap
 * runs idempotent CREATE TABLE IF NOT EXISTS DDL (no drizzle migrator —
 * Mastra owns its own tables/migrations, Calla owns only calla_* tables).
 * Adapter-selection pattern adapted from @elizaos/plugin-sql
 * (MIT, (c) 2025 Shaw Walters and elizaOS Contributors).
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import { and, desc, eq, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  appendAudit,
  verifyAudit,
  type AppendAuditInput,
  type AuditRecord,
  type GetAuditOptions,
  type VerifyAuditResult,
} from "./hashchain.js";
import {
  callaAgents,
  callaAgentConfigs,
  callaApprovals,
  callaAudit,
  callaCache,
  callaDeploymentConfig,
  callaSkills,
  callaUsers,
} from "./schema.js";
import type { AgentConfigRecord, CallaUserRole, DeploymentConfigPayload, SkillRecord, SkillSource } from "@calla/shared";
import type {
  AgentRegistryRow,
  ApprovalRow,
  CallaStore,
  CallaUserRow,
  CreateUserInput,
  DeploymentConfigRow,
  DeleteSkillResult,
  ListApprovalsOptions,
  RecordApprovalInput,
  UpsertAgentConfigInput,
  UpsertAgentInput,
  UpsertSkillInput,
} from "./types.js";

/** Idempotent DDL — mirrors ./schema.ts exactly. */
const PG_DDL = `
CREATE TABLE IF NOT EXISTS calla_agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  type text NOT NULL,
  runtime text NOT NULL,
  status text NOT NULL DEFAULT 'idle',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  deployment_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calla_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  agent_id text NOT NULL,
  tool_name text NOT NULL,
  args jsonb NOT NULL DEFAULT '{}'::jsonb,
  risk text NOT NULL DEFAULT 'medium',
  summary text,
  status text NOT NULL DEFAULT 'pending',
  requested_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz,
  decided_by text NOT NULL DEFAULT 'human',
  run_id text,
  tool_call_id text,
  deployment_id text
);
CREATE INDEX IF NOT EXISTS calla_approvals_agent_id_idx ON calla_approvals (agent_id);
CREATE INDEX IF NOT EXISTS calla_approvals_status_idx ON calla_approvals (status);
CREATE INDEX IF NOT EXISTS calla_approvals_requested_at_idx ON calla_approvals (requested_at);
CREATE TABLE IF NOT EXISTS calla_audit (
  seq serial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  agent_id text,
  kind text NOT NULL,
  entry jsonb NOT NULL,
  prev_hash text NOT NULL,
  entry_hash text NOT NULL
);
CREATE TABLE IF NOT EXISTS calla_cache (
  key text NOT NULL,
  agent_id text NOT NULL,
  value jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  PRIMARY KEY (key, agent_id)
);
CREATE TABLE IF NOT EXISTS calla_users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text UNIQUE NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'admin',
  created_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);
CREATE INDEX IF NOT EXISTS calla_users_email_idx ON calla_users (email);
CREATE TABLE IF NOT EXISTS calla_skills (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  instructions text NOT NULL,
  ref_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  source text NOT NULL DEFAULT 'uploaded',
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT calla_skills_agent_id_name_key UNIQUE (agent_id, name)
);
CREATE INDEX IF NOT EXISTS calla_skills_agent_id_idx ON calla_skills (agent_id);
CREATE TABLE IF NOT EXISTS calla_agent_configs (
  agent_id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  instructions text NOT NULL,
  model text,
  source text NOT NULL DEFAULT 'custom',
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS calla_deployment_config (
  id text PRIMARY KEY DEFAULT 'default',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
`;

function toIso(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Math.trunc(limit ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 500);
}

function redactDsn(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = "***";
    if (u.username) u.username = `${u.username}:***`;
    return u.toString().replace(/:\*\*\*@/, "***@");
  } catch {
    return "postgres://***";
  }
}

export class DrizzlePgStore implements CallaStore {
  readonly kind = "pg" as const;
  readonly target: string;

  private readonly pool: pg.Pool;
  private readonly db: NodePgDatabase<Record<string, never>>;
  private readonly ready: Promise<void>;

  constructor(connectionString: string) {
    this.target = redactDsn(connectionString);
    this.pool = new pg.Pool({ connectionString, max: 5 });
    this.db = drizzle(this.pool);
    this.ready = this.bootstrap();
    // Avoid unhandled rejections; method calls surface the error to callers.
    this.ready.catch(() => {});
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  async bootstrap(): Promise<void> {
    await this.db.execute(sql.raw(PG_DDL));
  }

  // ─── Approvals ────────────────────────────────────────────────

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRow> {
    await this.ensureReady();
    const now = new Date();
    const status = input.status ?? "pending";
    const row = {
      id: randomUUID(),
      source: input.source ?? "mastra",
      agentId: input.agentId,
      toolName: input.toolName,
      args: input.args ?? {},
      risk: input.risk ?? "medium",
      summary: input.summary ?? null,
      status,
      requestedAt: now,
      decidedAt: status === "pending" ? null : now,
      decidedBy: input.decidedBy ?? "human",
      runId: input.runId ?? null,
      toolCallId: input.toolCallId ?? null,
      deploymentId: input.deploymentId ?? null,
    };
    const [inserted] = await this.db
      .insert(callaApprovals)
      .values(row)
      .returning();
    return this.mapApproval(inserted ?? row);
  }

  async listApprovals(options: ListApprovalsOptions = {}): Promise<ApprovalRow[]> {
    await this.ensureReady();
    const filters = [];
    if (options.status) filters.push(eq(callaApprovals.status, options.status));
    if (options.agentId) filters.push(eq(callaApprovals.agentId, options.agentId));
    if (options.runId) filters.push(eq(callaApprovals.runId, options.runId));
    const rows = await this.db
      .select()
      .from(callaApprovals)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(desc(callaApprovals.requestedAt), desc(callaApprovals.id))
      .limit(clampLimit(options.limit, 100));
    return rows.map((r) => this.mapApproval(r));
  }

  private mapApproval(r: typeof callaApprovals.$inferSelect): ApprovalRow {
    return {
      id: r.id,
      source: r.source as ApprovalRow["source"],
      agentId: r.agentId,
      toolName: r.toolName,
      args: (r.args ?? {}) as Record<string, unknown>,
      risk: (r.risk ?? "medium") as ApprovalRow["risk"],
      summary: r.summary,
      status: r.status as ApprovalRow["status"],
      requestedAt: toIso(r.requestedAt) ?? "",
      decidedAt: toIso(r.decidedAt),
      decidedBy: r.decidedBy ?? "human",
      runId: r.runId,
      toolCallId: r.toolCallId,
      deploymentId: r.deploymentId,
    };
  }

  // ─── Audit (hash chain) ───────────────────────────────────────

  async getAuditTail(): Promise<{ seq: number; entryHash: string } | null> {
    await this.ensureReady();
    const rows = await this.db
      .select({ seq: callaAudit.seq, entryHash: callaAudit.entryHash })
      .from(callaAudit)
      .orderBy(desc(callaAudit.seq))
      .limit(1);
    return rows[0] ? { seq: Number(rows[0].seq), entryHash: rows[0].entryHash } : null;
  }

  async insertAuditRow(row: {
    seq: number;
    ts: string;
    agentId: string | null;
    kind: string;
    entry: Record<string, unknown>;
    prevHash: string;
    entryHash: string;
  }): Promise<AuditRecord> {
    await this.ensureReady();
    await this.db.insert(callaAudit).values({
      seq: row.seq,
      ts: new Date(row.ts),
      agentId: row.agentId,
      kind: row.kind,
      entry: row.entry,
      prevHash: row.prevHash,
      entryHash: row.entryHash,
    });
    return { ...row };
  }

  async getAudit(options: GetAuditOptions = {}): Promise<AuditRecord[]> {
    await this.ensureReady();
    const filters = [];
    if (options.agentId) filters.push(eq(callaAudit.agentId, options.agentId));
    if (options.kind) filters.push(eq(callaAudit.kind, options.kind));
    // verifyAudit walks the full chain: "asc" without an explicit limit is unbounded.
    const limit =
      options.limit !== undefined
        ? clampLimit(options.limit, 100)
        : options.order === "asc"
          ? undefined
          : 100;
    const query = this.db
      .select()
      .from(callaAudit)
      .where(filters.length ? and(...filters) : undefined)
      .orderBy(options.order === "asc" ? callaAudit.seq : desc(callaAudit.seq));
    const rows = limit === undefined ? await query : await query.limit(limit);
    return rows.map((r) => ({
      seq: Number(r.seq),
      ts: toIso(r.ts) ?? "",
      agentId: r.agentId,
      kind: r.kind,
      entry: (r.entry ?? {}) as Record<string, unknown>,
      prevHash: r.prevHash,
      entryHash: r.entryHash,
    }));
  }

  appendAudit(input: AppendAuditInput): Promise<AuditRecord> {
    return appendAudit(this, input);
  }

  verifyAudit(): Promise<VerifyAuditResult> {
    return verifyAudit(this);
  }

  // ─── Cache (ElizaOS cache-table shape) ────────────────────────

  async cacheGet<T = unknown>(key: string, agentId: string): Promise<T | null> {
    await this.ensureReady();
    const rows = await this.db
      .select({ value: callaCache.value, expiresAt: callaCache.expiresAt })
      .from(callaCache)
      .where(and(eq(callaCache.key, key), eq(callaCache.agentId, agentId)))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
      await this.db
        .delete(callaCache)
        .where(and(eq(callaCache.key, key), eq(callaCache.agentId, agentId)))
        .catch(() => {});
      return null;
    }
    return row.value as T;
  }

  async cacheSet(key: string, agentId: string, value: unknown, ttlMs?: number | null): Promise<void> {
    await this.ensureReady();
    const expiresAt = ttlMs && ttlMs > 0 ? new Date(Date.now() + ttlMs) : null;
    await this.db
      .insert(callaCache)
      .values({ key, agentId, value: value ?? null, expiresAt })
      .onConflictDoUpdate({
        target: [callaCache.key, callaCache.agentId],
        set: { value: value ?? null, createdAt: new Date(), expiresAt },
      });
  }

  // ─── Agent registry ───────────────────────────────────────────

  async upsertAgent(agent: UpsertAgentInput): Promise<AgentRegistryRow> {
    await this.ensureReady();
    const now = new Date();
    let id = agent.id;
    if (!id) {
      const existing = await this.db
        .select({ id: callaAgents.id })
        .from(callaAgents)
        .where(
          and(
            eq(callaAgents.name, agent.name),
            eq(callaAgents.type, agent.type),
            eq(callaAgents.runtime, agent.runtime),
          ),
        )
        .limit(1);
      id = existing[0]?.id ?? randomUUID();
    }
    const [row] = await this.db
      .insert(callaAgents)
      .values({
        id,
        name: agent.name,
        type: agent.type,
        runtime: agent.runtime,
        status: agent.status ?? "idle",
        capabilities: agent.capabilities ?? [],
        meta: agent.meta ?? {},
        deploymentId: agent.deploymentId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: callaAgents.id,
        set: {
          name: agent.name,
          type: agent.type,
          runtime: agent.runtime,
          status: agent.status ?? "idle",
          capabilities: agent.capabilities ?? [],
          meta: agent.meta ?? {},
          deploymentId: agent.deploymentId ?? null,
          updatedAt: now,
        },
      })
      .returning();
    return this.mapAgent(row);
  }

  async listAgents(): Promise<AgentRegistryRow[]> {
    await this.ensureReady();
    const rows = await this.db.select().from(callaAgents).orderBy(callaAgents.name);
    return rows.map((r) => this.mapAgent(r));
  }

  private mapAgent(r: typeof callaAgents.$inferSelect): AgentRegistryRow {
    return {
      id: r.id,
      name: r.name,
      type: r.type as AgentRegistryRow["type"],
      runtime: r.runtime as AgentRegistryRow["runtime"],
      status: r.status ?? "idle",
      capabilities: Array.isArray(r.capabilities) ? (r.capabilities as string[]) : [],
      meta: (r.meta ?? {}) as Record<string, unknown>,
      deploymentId: r.deploymentId,
      createdAt: toIso(r.createdAt) ?? "",
      updatedAt: toIso(r.updatedAt) ?? "",
    };
  }

  // ─── Self-hosted (standalone) auth users ──────────────────────

  async createUser(input: CreateUserInput): Promise<CallaUserRow> {
    await this.ensureReady();
    const now = new Date();
    const email = input.email.toLowerCase();
    const [row] = await this.db
      .insert(callaUsers)
      .values({
        id: randomUUID(),
        email,
        passwordHash: input.passwordHash,
        role: input.role ?? "admin",
        createdAt: now,
        lastLoginAt: null,
      })
      .returning();
    return this.mapUser(row);
  }

  async findUserByEmail(email: string): Promise<CallaUserRow | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(callaUsers)
      .where(eq(callaUsers.email, email.toLowerCase()))
      .limit(1);
    return rows[0] ? this.mapUser(rows[0]) : null;
  }

  async countUsers(): Promise<number> {
    await this.ensureReady();
    const rows = await this.db.select({ n: sql<number>`count(*)::int` }).from(callaUsers);
    return Number(rows[0]?.n ?? 0);
  }

  async touchUserLogin(id: string): Promise<void> {
    await this.ensureReady();
    await this.db
      .update(callaUsers)
      .set({ lastLoginAt: new Date() })
      .where(eq(callaUsers.id, id));
  }

  private mapUser(r: typeof callaUsers.$inferSelect): CallaUserRow {
    return {
      id: r.id,
      email: r.email,
      passwordHash: r.passwordHash,
      role: (r.role ?? "admin") as CallaUserRole,
      createdAt: toIso(r.createdAt) ?? "",
      lastLoginAt: toIso(r.lastLoginAt),
    };
  }

  // ─── Skills (per-agent, hot-swappable behavior) ─────────────────

  async listSkills(agentId?: string): Promise<SkillRecord[]> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(callaSkills)
      .where(agentId ? eq(callaSkills.agentId, agentId) : undefined)
      .orderBy(callaSkills.agentId, callaSkills.name);
    return rows.map((r) => this.mapSkill(r));
  }

  async getSkill(agentId: string, name: string): Promise<SkillRecord | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(callaSkills)
      .where(and(eq(callaSkills.agentId, agentId), eq(callaSkills.name, name)))
      .limit(1);
    return rows[0] ? this.mapSkill(rows[0]) : null;
  }

  async upsertSkill(input: UpsertSkillInput): Promise<SkillRecord> {
    await this.ensureReady();
    const now = new Date();
    const references = input.references ?? {};
    const [row] = await this.db
      .insert(callaSkills)
      .values({
        id: randomUUID(),
        agentId: input.agentId,
        name: input.name,
        description: input.description ?? "",
        instructions: input.instructions,
        refJson: references,
        source: input.source ?? "uploaded",
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [callaSkills.agentId, callaSkills.name],
        set: {
          description: input.description ?? "",
          instructions: input.instructions,
          refJson: references,
          version: sql`${callaSkills.version} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    return this.mapSkill(row);
  }

  async deleteSkill(agentId: string, name: string): Promise<DeleteSkillResult> {
    await this.ensureReady();
    const existing = await this.getSkill(agentId, name);
    if (!existing) return { deleted: false, reason: "not-found" };
    if (existing.source === "builtin") return { deleted: false, reason: "builtin" };
    await this.db
      .delete(callaSkills)
      .where(and(eq(callaSkills.agentId, agentId), eq(callaSkills.name, name)));
    return { deleted: true, skill: existing };
  }

  private mapSkill(r: typeof callaSkills.$inferSelect): SkillRecord {
    const references = (r.refJson ?? {}) as Record<string, string>;
    return {
      id: r.id,
      agentId: r.agentId,
      name: r.name,
      description: r.description ?? "",
      instructions: r.instructions,
      ...(Object.keys(references).length > 0 ? { references } : {}),
      source: (r.source === "builtin" ? "builtin" : "uploaded") as SkillSource,
      version: Number(r.version ?? 1),
      updatedAt: toIso(r.updatedAt) ?? "",
    };
  }

  // ─── Agent configs (per-agent persona/instructions/model) ───────

  async listAgentConfigs(): Promise<AgentConfigRecord[]> {
    await this.ensureReady();
    const rows = await this.db.select().from(callaAgentConfigs).orderBy(callaAgentConfigs.agentId);
    return rows.map((r) => this.mapAgentConfig(r));
  }

  async getAgentConfig(agentId: string): Promise<AgentConfigRecord | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(callaAgentConfigs)
      .where(eq(callaAgentConfigs.agentId, agentId))
      .limit(1);
    return rows[0] ? this.mapAgentConfig(rows[0]) : null;
  }

  async upsertAgentConfig(input: UpsertAgentConfigInput): Promise<AgentConfigRecord> {
    await this.ensureReady();
    const now = new Date();
    const [row] = await this.db
      .insert(callaAgentConfigs)
      .values({
        agentId: input.agentId,
        name: input.name,
        description: input.description ?? null,
        instructions: input.instructions,
        model: input.model ?? null,
        source: input.source ?? "uploaded",
        enabled: input.enabled ?? true,
        version: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: callaAgentConfigs.agentId,
        set: {
          name: input.name,
          description: input.description ?? null,
          instructions: input.instructions,
          model: input.model ?? null,
          enabled: input.enabled ?? true,
          version: sql`${callaAgentConfigs.version} + 1`,
          updatedAt: now,
        },
      })
      .returning();
    return this.mapAgentConfig(row);
  }

  private mapAgentConfig(r: typeof callaAgentConfigs.$inferSelect): AgentConfigRecord {
    return {
      agentId: r.agentId,
      name: r.name,
      description: r.description,
      instructions: r.instructions,
      model: r.model,
      source: (r.source === "builtin" ? "builtin" : "uploaded") as SkillSource,
      enabled: r.enabled ?? true,
      version: Number(r.version ?? 1),
      updatedAt: toIso(r.updatedAt) ?? "",
    };
  }

  // ─── Deployment config (per-deployment feature flags) ───────────

  async getDeploymentConfig(): Promise<DeploymentConfigRow | null> {
    await this.ensureReady();
    const rows = await this.db
      .select()
      .from(callaDeploymentConfig)
      .where(eq(callaDeploymentConfig.id, "default"))
      .limit(1);
    if (!rows[0]) return null;
    const r = rows[0];
    return {
      id: r.id,
      payload: (r.payload ?? {}) as DeploymentConfigPayload,
      updatedAt: toIso(r.updatedAt) ?? "",
    };
  }

  async setDeploymentConfig(payload: DeploymentConfigPayload): Promise<DeploymentConfigRow> {
    await this.ensureReady();
    const now = new Date();
    const [row] = await this.db
      .insert(callaDeploymentConfig)
      .values({ id: "default", payload, updatedAt: now })
      .onConflictDoUpdate({
        target: callaDeploymentConfig.id,
        set: { payload, updatedAt: now },
      })
      .returning();
    return {
      id: row.id,
      payload: (row.payload ?? {}) as DeploymentConfigPayload,
      updatedAt: toIso(row.updatedAt) ?? now.toISOString(),
    };
  }

  async close(): Promise<void> {
    await this.pool.end().catch(() => {});
  }
}
