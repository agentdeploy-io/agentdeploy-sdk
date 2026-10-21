/**
 * LibSqlStore — embedded LibSQL/SQLite CallaStore via @libsql/client raw SQL.
 *
 * The dev/smoke path: zero infrastructure, same CallaStore contract as
 * DrizzlePgStore. No drizzle migrations here — bootstrap runs equivalent
 * hand-written CREATE TABLE IF NOT EXISTS DDL (timestamptz/jsonb → TEXT
 * holding ISO-8601 strings / JSON text). Presence-driven adapter selection
 * pattern adapted from @elizaos/plugin-sql
 * (MIT, (c) 2025 Shaw Walters and elizaOS Contributors).
 */
import { randomUUID } from "node:crypto";
import { createClient, type Client, type InValue, type Row } from "@libsql/client";
import type { AgentConfigRecord, CallaUserRole, DeploymentConfigPayload, SkillRecord, SkillSource } from "@calla/shared";
import {
  appendAudit,
  verifyAudit,
  type AppendAuditInput,
  type AuditRecord,
  type GetAuditOptions,
  type VerifyAuditResult,
} from "./hashchain.js";
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

/** Idempotent SQLite DDL — call-for-call equivalent of PG_DDL in pg-store.ts. */
const SQLITE_DDL = [
  `CREATE TABLE IF NOT EXISTS calla_agents (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL,
    runtime TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'idle',
    capabilities TEXT NOT NULL DEFAULT '[]',
    meta TEXT NOT NULL DEFAULT '{}',
    deployment_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calla_approvals (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    tool_name TEXT NOT NULL,
    args TEXT NOT NULL DEFAULT '{}',
    risk TEXT NOT NULL DEFAULT 'medium',
    summary TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    requested_at TEXT NOT NULL,
    decided_at TEXT,
    decided_by TEXT NOT NULL DEFAULT 'human',
    run_id TEXT,
    tool_call_id TEXT,
    deployment_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS calla_approvals_agent_id_idx ON calla_approvals (agent_id)`,
  `CREATE INDEX IF NOT EXISTS calla_approvals_status_idx ON calla_approvals (status)`,
  `CREATE INDEX IF NOT EXISTS calla_approvals_requested_at_idx ON calla_approvals (requested_at)`,
  `CREATE TABLE IF NOT EXISTS calla_audit (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL,
    agent_id TEXT,
    kind TEXT NOT NULL,
    entry TEXT NOT NULL,
    prev_hash TEXT NOT NULL,
    entry_hash TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calla_cache (
    key TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at TEXT NOT NULL,
    expires_at TEXT,
    PRIMARY KEY (key, agent_id)
  )`,
  `CREATE TABLE IF NOT EXISTS calla_users (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin',
    created_at TEXT NOT NULL,
    last_login_at TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS calla_users_email_idx ON calla_users (email)`,
  `CREATE TABLE IF NOT EXISTS calla_skills (
    id TEXT PRIMARY KEY,
    agent_id TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    instructions TEXT NOT NULL,
    ref_json TEXT NOT NULL DEFAULT '{}',
    source TEXT NOT NULL DEFAULT 'uploaded',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (agent_id, name)
  )`,
  `CREATE INDEX IF NOT EXISTS calla_skills_agent_id_idx ON calla_skills (agent_id)`,
  `CREATE TABLE IF NOT EXISTS calla_agent_configs (
    agent_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT,
    instructions TEXT NOT NULL,
    model TEXT,
    source TEXT NOT NULL DEFAULT 'custom',
    enabled INTEGER NOT NULL DEFAULT 1,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS calla_deployment_config (
    id TEXT PRIMARY KEY DEFAULT 'default',
    payload TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT NOT NULL
  )`,
];

// ─── Value coercion (libsql rows carry string|number|bigint|null) ─

function asStr(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (v instanceof ArrayBuffer) return new TextDecoder().decode(v);
  return String(v);
}

function asNum(v: unknown): number {
  return typeof v === "number" ? v : Number(asStr(v) ?? 0);
}

function asJson<T>(v: unknown, fallback: T): T {
  const raw = asStr(v);
  if (raw === null || raw === "") return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function clampLimit(limit: number | undefined, fallback: number): number {
  const n = Math.trunc(limit ?? fallback);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, 500);
}

export class LibSqlStore implements CallaStore {
  readonly kind = "libsql" as const;
  readonly target: string;

  private readonly client: Client;
  private readonly ready: Promise<void>;

  constructor(url: string) {
    this.target = url;
    this.client = createClient({ url });
    this.ready = this.bootstrap();
    this.ready.catch(() => {});
  }

  private async ensureReady(): Promise<void> {
    await this.ready;
  }

  async bootstrap(): Promise<void> {
    await this.client.batch(SQLITE_DDL);
  }

  // ─── Approvals ────────────────────────────────────────────────

  async recordApproval(input: RecordApprovalInput): Promise<ApprovalRow> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const status = input.status ?? "pending";
    const row: ApprovalRow = {
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
    await this.client.execute({
      sql: `INSERT INTO calla_approvals
        (id, source, agent_id, tool_name, args, risk, summary, status, requested_at, decided_at, decided_by, run_id, tool_call_id, deployment_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [
        row.id,
        row.source,
        row.agentId,
        row.toolName,
        JSON.stringify(row.args),
        row.risk,
        row.summary,
        row.status,
        row.requestedAt,
        row.decidedAt,
        row.decidedBy,
        row.runId,
        row.toolCallId,
        row.deploymentId,
      ] as InValue[],
    });
    return row;
  }

  async listApprovals(options: ListApprovalsOptions = {}): Promise<ApprovalRow[]> {
    await this.ensureReady();
    const where: string[] = [];
    const args: InValue[] = [];
    if (options.status) {
      where.push("status = ?");
      args.push(options.status);
    }
    if (options.agentId) {
      where.push("agent_id = ?");
      args.push(options.agentId);
    }
    if (options.runId) {
      where.push("run_id = ?");
      args.push(options.runId);
    }
    args.push(clampLimit(options.limit, 100));
    const rs = await this.client.execute({
      sql: `SELECT * FROM calla_approvals
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY requested_at DESC, id DESC
        LIMIT ?`,
      args,
    });
    return rs.rows.map((r) => ({
      id: asStr(r.id) ?? "",
      source: (asStr(r.source) ?? "mastra") as ApprovalRow["source"],
      agentId: asStr(r.agent_id) ?? "",
      toolName: asStr(r.tool_name) ?? "",
      args: asJson<Record<string, unknown>>(r.args, {}),
      risk: (asStr(r.risk) ?? "medium") as ApprovalRow["risk"],
      summary: asStr(r.summary),
      status: (asStr(r.status) ?? "pending") as ApprovalRow["status"],
      requestedAt: asStr(r.requested_at) ?? "",
      decidedAt: asStr(r.decided_at),
      decidedBy: asStr(r.decided_by) ?? "human",
      runId: asStr(r.run_id),
      toolCallId: asStr(r.tool_call_id),
      deploymentId: asStr(r.deployment_id),
    }));
  }

  // ─── Audit (hash chain) ───────────────────────────────────────

  async getAuditTail(): Promise<{ seq: number; entryHash: string } | null> {
    await this.ensureReady();
    const rs = await this.client.execute(
      "SELECT seq, entry_hash FROM calla_audit ORDER BY seq DESC LIMIT 1",
    );
    const row = rs.rows[0];
    return row ? { seq: asNum(row.seq), entryHash: asStr(row.entry_hash) ?? "" } : null;
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
    await this.client.execute({
      sql: `INSERT INTO calla_audit (seq, ts, agent_id, kind, entry, prev_hash, entry_hash)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [row.seq, row.ts, row.agentId, row.kind, JSON.stringify(row.entry), row.prevHash, row.entryHash] as InValue[],
    });
    return { ...row };
  }

  async getAudit(options: GetAuditOptions = {}): Promise<AuditRecord[]> {
    await this.ensureReady();
    const where: string[] = [];
    const args: InValue[] = [];
    if (options.agentId) {
      where.push("agent_id = ?");
      args.push(options.agentId);
    }
    if (options.kind) {
      where.push("kind = ?");
      args.push(options.kind);
    }
    // verifyAudit walks the full chain: "asc" without an explicit limit is unbounded.
    const limit =
      options.limit !== undefined
        ? clampLimit(options.limit, 100)
        : options.order === "asc"
          ? undefined
          : 100;
    if (limit !== undefined) args.push(limit);
    const rs = await this.client.execute({
      sql: `SELECT * FROM calla_audit
        ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
        ORDER BY seq ${options.order === "asc" ? "ASC" : "DESC"}
        ${limit !== undefined ? "LIMIT ?" : ""}`,
      args,
    });
    return rs.rows.map((r) => ({
      seq: asNum(r.seq),
      ts: asStr(r.ts) ?? "",
      agentId: asStr(r.agent_id),
      kind: asStr(r.kind) ?? "",
      entry: asJson<Record<string, unknown>>(r.entry, {}),
      prevHash: asStr(r.prev_hash) ?? "",
      entryHash: asStr(r.entry_hash) ?? "",
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
    const rs = await this.client.execute({
      sql: "SELECT value, expires_at FROM calla_cache WHERE key = ? AND agent_id = ?",
      args: [key, agentId],
    });
    const row = rs.rows[0];
    if (!row) return null;
    const expiresAt = asStr(row.expires_at);
    if (expiresAt && new Date(expiresAt).getTime() <= Date.now()) {
      await this.client
        .execute({
          sql: "DELETE FROM calla_cache WHERE key = ? AND agent_id = ?",
          args: [key, agentId],
        })
        .catch(() => {});
      return null;
    }
    return asJson<T | null>(row.value, null);
  }

  async cacheSet(key: string, agentId: string, value: unknown, ttlMs?: number | null): Promise<void> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const expiresAt = ttlMs && ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null;
    await this.client.execute({
      sql: `INSERT INTO calla_cache (key, agent_id, value, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT (key, agent_id) DO UPDATE SET
              value = excluded.value,
              created_at = excluded.created_at,
              expires_at = excluded.expires_at`,
      args: [key, agentId, JSON.stringify(value ?? null), now, expiresAt] as InValue[],
    });
  }

  // ─── Agent registry ───────────────────────────────────────────

  async upsertAgent(agent: UpsertAgentInput): Promise<AgentRegistryRow> {
    await this.ensureReady();
    const now = new Date().toISOString();
    let id = agent.id;
    if (!id) {
      const rs = await this.client.execute({
        sql: "SELECT id FROM calla_agents WHERE name = ? AND type = ? AND runtime = ? LIMIT 1",
        args: [agent.name, agent.type, agent.runtime],
      });
      id = asStr(rs.rows[0]?.id) ?? randomUUID();
    }
    const row: AgentRegistryRow = {
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
    };
    await this.client.execute({
      sql: `INSERT INTO calla_agents
        (id, name, type, runtime, status, capabilities, meta, deployment_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          name = excluded.name,
          type = excluded.type,
          runtime = excluded.runtime,
          status = excluded.status,
          capabilities = excluded.capabilities,
          meta = excluded.meta,
          deployment_id = excluded.deployment_id,
          updated_at = excluded.updated_at`,
      args: [
        row.id,
        row.name,
        row.type,
        row.runtime,
        row.status,
        JSON.stringify(row.capabilities),
        JSON.stringify(row.meta),
        row.deploymentId,
        row.createdAt,
        row.updatedAt,
      ] as InValue[],
    });
    // Preserve the original createdAt on updates.
    const rs = await this.client.execute({
      sql: "SELECT created_at FROM calla_agents WHERE id = ?",
      args: [row.id],
    });
    const createdAt = asStr(rs.rows[0]?.created_at);
    return createdAt ? { ...row, createdAt } : row;
  }

  async listAgents(): Promise<AgentRegistryRow[]> {
    await this.ensureReady();
    const rs = await this.client.execute("SELECT * FROM calla_agents ORDER BY name");
    return rs.rows.map((r) => ({
      id: asStr(r.id) ?? "",
      name: asStr(r.name) ?? "",
      type: (asStr(r.type) ?? "brain") as AgentRegistryRow["type"],
      runtime: (asStr(r.runtime) ?? "fly") as AgentRegistryRow["runtime"],
      status: asStr(r.status) ?? "idle",
      capabilities: asJson<string[]>(r.capabilities, []),
      meta: asJson<Record<string, unknown>>(r.meta, {}),
      deploymentId: asStr(r.deployment_id),
      createdAt: asStr(r.created_at) ?? "",
      updatedAt: asStr(r.updated_at) ?? "",
    }));
  }

  // ─── Self-hosted (standalone) auth users ──────────────────────

  async createUser(input: CreateUserInput): Promise<CallaUserRow> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const row: CallaUserRow = {
      id: randomUUID(),
      email: input.email.toLowerCase(),
      passwordHash: input.passwordHash,
      role: input.role ?? "admin",
      createdAt: now,
      lastLoginAt: null,
    };
    await this.client.execute({
      sql: `INSERT INTO calla_users (id, email, password_hash, role, created_at, last_login_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [row.id, row.email, row.passwordHash, row.role, row.createdAt, row.lastLoginAt] as InValue[],
    });
    return row;
  }

  async findUserByEmail(email: string): Promise<CallaUserRow | null> {
    await this.ensureReady();
    const rs = await this.client.execute({
      sql: "SELECT * FROM calla_users WHERE email = ? LIMIT 1",
      args: [email.toLowerCase()],
    });
    const r = rs.rows[0];
    if (!r) return null;
    return {
      id: asStr(r.id) ?? "",
      email: asStr(r.email) ?? "",
      passwordHash: asStr(r.password_hash) ?? "",
      role: (asStr(r.role) ?? "admin") as CallaUserRole,
      createdAt: asStr(r.created_at) ?? "",
      lastLoginAt: asStr(r.last_login_at),
    };
  }

  async countUsers(): Promise<number> {
    await this.ensureReady();
    const rs = await this.client.execute("SELECT count(*) AS n FROM calla_users");
    return asNum(rs.rows[0]?.n);
  }

  async touchUserLogin(id: string): Promise<void> {
    await this.ensureReady();
    await this.client.execute({
      sql: "UPDATE calla_users SET last_login_at = ? WHERE id = ?",
      args: [new Date().toISOString(), id],
    });
  }

  // ─── Skills (per-agent, hot-swappable behavior) ─────────────────

  async listSkills(agentId?: string): Promise<SkillRecord[]> {
    await this.ensureReady();
    const rs = agentId
      ? await this.client.execute({
          sql: "SELECT * FROM calla_skills WHERE agent_id = ? ORDER BY agent_id, name",
          args: [agentId],
        })
      : await this.client.execute("SELECT * FROM calla_skills ORDER BY agent_id, name");
    return rs.rows.map((r) => this.mapSkill(r));
  }

  async getSkill(agentId: string, name: string): Promise<SkillRecord | null> {
    await this.ensureReady();
    const rs = await this.client.execute({
      sql: "SELECT * FROM calla_skills WHERE agent_id = ? AND name = ? LIMIT 1",
      args: [agentId, name],
    });
    return rs.rows[0] ? this.mapSkill(rs.rows[0]) : null;
  }

  async upsertSkill(input: UpsertSkillInput): Promise<SkillRecord> {
    await this.ensureReady();
    const now = new Date().toISOString();
    const references = input.references ?? {};
    await this.client.execute({
      sql: `INSERT INTO calla_skills
        (id, agent_id, name, description, instructions, ref_json, source, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (agent_id, name) DO UPDATE SET
          description = excluded.description,
          instructions = excluded.instructions,
          ref_json = excluded.ref_json,
          version = calla_skills.version + 1,
          updated_at = excluded.updated_at`,
      args: [
        randomUUID(),
        input.agentId,
        input.name,
        input.description ?? "",
        input.instructions,
        JSON.stringify(references),
        input.source ?? "uploaded",
        now,
        now,
      ] as InValue[],
    });
    const skill = await this.getSkill(input.agentId, input.name);
    if (!skill) throw new Error(`upsertSkill: row vanished for ${input.agentId}/${input.name}`);
    return skill;
  }

  async deleteSkill(agentId: string, name: string): Promise<DeleteSkillResult> {
    await this.ensureReady();
    const existing = await this.getSkill(agentId, name);
    if (!existing) return { deleted: false, reason: "not-found" };
    if (existing.source === "builtin") return { deleted: false, reason: "builtin" };
    await this.client.execute({
      sql: "DELETE FROM calla_skills WHERE agent_id = ? AND name = ?",
      args: [agentId, name],
    });
    return { deleted: true, skill: existing };
  }

  private mapSkill(r: Row): SkillRecord {
    const references = asJson<Record<string, string>>(r.ref_json, {});
    return {
      id: asStr(r.id) ?? "",
      agentId: asStr(r.agent_id) ?? "",
      name: asStr(r.name) ?? "",
      description: asStr(r.description) ?? "",
      instructions: asStr(r.instructions) ?? "",
      ...(Object.keys(references).length > 0 ? { references } : {}),
      source: (asStr(r.source) === "builtin" ? "builtin" : "uploaded") as SkillSource,
      version: asNum(r.version) || 1,
      updatedAt: asStr(r.updated_at) ?? "",
    };
  }

  // ─── Agent configs (per-agent persona/instructions/model) ───────

  async listAgentConfigs(): Promise<AgentConfigRecord[]> {
    await this.ensureReady();
    const rs = await this.client.execute("SELECT * FROM calla_agent_configs ORDER BY agent_id");
    return rs.rows.map((r) => this.mapAgentConfig(r));
  }

  async getAgentConfig(agentId: string): Promise<AgentConfigRecord | null> {
    await this.ensureReady();
    const rs = await this.client.execute({
      sql: "SELECT * FROM calla_agent_configs WHERE agent_id = ? LIMIT 1",
      args: [agentId],
    });
    return rs.rows[0] ? this.mapAgentConfig(rs.rows[0]) : null;
  }

  async upsertAgentConfig(input: UpsertAgentConfigInput): Promise<AgentConfigRecord> {
    await this.ensureReady();
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `INSERT INTO calla_agent_configs
        (agent_id, name, description, instructions, model, source, enabled, version, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (agent_id) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          instructions = excluded.instructions,
          model = excluded.model,
          enabled = excluded.enabled,
          version = calla_agent_configs.version + 1,
          updated_at = excluded.updated_at`,
      args: [
        input.agentId,
        input.name,
        input.description ?? null,
        input.instructions,
        input.model ?? null,
        input.source ?? "uploaded",
        (input.enabled ?? true) ? 1 : 0,
        now,
        now,
      ] as InValue[],
    });
    const config = await this.getAgentConfig(input.agentId);
    if (!config) throw new Error(`upsertAgentConfig: row vanished for ${input.agentId}`);
    return config;
  }

  private mapAgentConfig(r: Row): AgentConfigRecord {
    return {
      agentId: asStr(r.agent_id) ?? "",
      name: asStr(r.name) ?? "",
      description: asStr(r.description),
      instructions: asStr(r.instructions) ?? "",
      model: asStr(r.model),
      source: (asStr(r.source) === "builtin" ? "builtin" : "uploaded") as SkillSource,
      enabled: asNum(r.enabled) !== 0,
      version: asNum(r.version) || 1,
      updatedAt: asStr(r.updated_at) ?? "",
    };
  }

  // ─── Deployment config (per-deployment feature flags) ───────────

  async getDeploymentConfig(): Promise<DeploymentConfigRow | null> {
    await this.ensureReady();
    const rs = await this.client.execute({
      sql: "SELECT * FROM calla_deployment_config WHERE id = ? LIMIT 1",
      args: ["default"],
    });
    if (!rs.rows[0]) return null;
    const r = rs.rows[0];
    let payload: DeploymentConfigPayload = {};
    const raw = asStr(r.payload);
    if (raw) {
      try {
        payload = JSON.parse(raw) as DeploymentConfigPayload;
      } catch {
        payload = {};
      }
    }
    return {
      id: asStr(r.id) ?? "default",
      payload,
      updatedAt: asStr(r.updated_at) ?? "",
    };
  }

  async setDeploymentConfig(payload: DeploymentConfigPayload): Promise<DeploymentConfigRow> {
    await this.ensureReady();
    const now = new Date().toISOString();
    await this.client.execute({
      sql: `INSERT INTO calla_deployment_config (id, payload, updated_at)
        VALUES ('default', ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          payload = excluded.payload,
          updated_at = excluded.updated_at`,
      args: [JSON.stringify(payload), now] as InValue[],
    });
    const row = await this.getDeploymentConfig();
    if (!row) throw new Error("setDeploymentConfig: row vanished after upsert");
    return row;
  }

  async close(): Promise<void> {
    try {
      this.client.close();
    } catch {
      // best-effort
    }
  }
}
