/**
 * Control-plane client — talks the AgentDeploy supervisor protocol to the
 * platform (deployment-service). Disabled (all no-ops) when
 * AD_CONTROL_PLANE_URL is unset, which is the local-dev default.
 *
 * Injected by the platform at deploy time (see flyio-deployments.ts):
 *   DEPLOYMENT_ID, AD_BROKER_TOKEN, PORT, USER_ID, TEMPLATE_ID, REGION,
 *   AD_GATEWAY_API_KEY (platform LLM routing).
 *
 * Endpoints (platform side):
 *   GET  /v1/broker/secrets  — plaintext secrets for THIS deployment
 *                              (headers X-Deployment-Id + X-Broker-Token)
 *   POST /v1/telemetry       — batched events: heartbeat / task_transition /
 *                              checkpoint / warning / tool_call
 *
 * Hard rules honored here:
 *   - buyer secrets stay in memory only; values are NEVER logged
 *   - telemetry is batched, at-least-once, idempotency-keyed
 *   - heartbeats every 30s (3 missed = degraded, 10 = unresponsive)
 */

import os from "node:os";

export interface TelemetryEvent {
  deploymentId: string;
  taskId?: string;
  eventType: "heartbeat" | "task_transition" | "checkpoint" | "warning" | "tool_call";
  idempotencyKey?: string;
  payload: Record<string, unknown>;
  ts?: string;
}

export interface HeartbeatSample {
  phase: string;
  cpuPct: number;
  memMb: number;
  tokensInPeriod: number;
  lastError: string | null;
}

interface ControlPlaneConfig {
  baseUrl: string;
  deploymentId: string;
  brokerToken: string;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
}

const FLUSH_INTERVAL_MS = 5_000;
const FLUSH_BATCH_SIZE = 20;
const QUEUE_CAP = 500;
const HEARTBEAT_INTERVAL_MS = 30_000;

export class ControlPlane {
  readonly enabled: boolean;
  private readonly cfg: ControlPlaneConfig;
  private readonly secrets = new Map<string, string>();
  private queue: TelemetryEvent[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private hbTimer: NodeJS.Timeout | null = null;
  private lastCpu = process.cpuUsage();
  private lastCpuAt = Date.now();
  private lastHeartbeatTokens = 0;
  private lastError: string | null = null;
  private fetching = false;

  constructor(cfg: ControlPlaneConfig) {
    this.cfg = cfg;
    this.enabled = Boolean(cfg.baseUrl && cfg.deploymentId && cfg.brokerToken);
  }

  // ── secrets ──────────────────────────────────────────────────────────────
  getSecret(name: string): string | undefined {
    return this.secrets.get(name);
  }

  get secretNames(): string[] {
    return [...this.secrets.keys()];
  }

  /** Fetch this deployment's secrets from the broker. Values never logged. */
  async fetchSecrets(): Promise<{ ok: boolean; count: number; error?: string }> {
    if (!this.enabled) return { ok: false, count: 0, error: "control plane disabled" };
    const fetchImpl = this.cfg.fetchImpl ?? fetch;
    try {
      const res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/v1/broker/secrets`, {
        method: "GET",
        headers: {
          "X-Deployment-Id": this.cfg.deploymentId,
          "X-Broker-Token": this.cfg.brokerToken,
        },
      });
      if (!res.ok) {
        const error = `broker returned ${res.status}`;
        this.cfg.log?.(`secret fetch failed: ${error} (values never logged)`);
        return { ok: false, count: 0, error };
      }
      const body = (await res.json()) as Record<string, unknown>;
      const bag = (body.secrets && typeof body.secrets === "object" ? body.secrets : body) as Record<string, unknown>;
      for (const [k, v] of Object.entries(bag)) {
        if (typeof v === "string" && v) this.secrets.set(k, v);
      }
      this.cfg.log?.(`secrets loaded: ${this.secrets.size} key(s) [${this.secrets.size ? "in memory only" : ""}]`);
      return { ok: true, count: this.secrets.size };
    } catch (e: any) {
      const error = e?.message ?? String(e);
      this.cfg.log?.(`secret fetch failed: ${error}`);
      return { ok: false, count: 0, error };
    }
  }

  // ── telemetry ────────────────────────────────────────────────────────────
  emit(event: TelemetryEvent): void {
    if (!this.enabled) return;
    this.queue.push({ ...event, ts: event.ts ?? new Date().toISOString() });
    if (this.queue.length > QUEUE_CAP) this.queue.splice(0, this.queue.length - QUEUE_CAP);
    if (this.queue.length >= FLUSH_BATCH_SIZE) void this.flush();
  }

  async flush(): Promise<void> {
    if (!this.enabled || this.queue.length === 0 || this.fetching) return;
    this.fetching = true;
    try {
      const batch = this.queue.splice(0, FLUSH_BATCH_SIZE);
      const fetchImpl = this.cfg.fetchImpl ?? fetch;
      const res = await fetchImpl(`${this.cfg.baseUrl.replace(/\/$/, "")}/v1/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Deployment-Id": this.cfg.deploymentId,
          "X-Broker-Token": this.cfg.brokerToken,
        },
        body: JSON.stringify({ events: batch }),
      });
      if (!res.ok) {
        // At-least-once: put the batch back (idempotency keys make retries safe).
        this.queue = [...batch, ...this.queue].slice(-QUEUE_CAP);
      }
    } catch (e: any) {
      this.cfg.log?.(`telemetry flush failed: ${e?.message ?? e}`);
    } finally {
      this.fetching = false;
    }
  }

  // ── heartbeats ───────────────────────────────────────────────────────────
  cpuPct(): number {
    const now = Date.now();
    const usage = process.cpuUsage();
    const elapsedUs = (now - this.lastCpuAt) * 1_000;
    const busyUs = usage.user - this.lastCpu.user + usage.system - this.lastCpu.system;
    this.lastCpu = usage;
    this.lastCpuAt = now;
    if (elapsedUs <= 0) return 0;
    return Math.min(100, Math.max(0, (busyUs / elapsedUs) * 100));
  }

  heartbeat(sample: Omit<HeartbeatSample, "cpuPct" | "memMb"> & { cpuPct?: number; memMb?: number }): void {
    if (!this.enabled) return;
    const periodTokens = Math.max(0, sample.tokensInPeriod - this.lastHeartbeatTokens);
    this.lastHeartbeatTokens = sample.tokensInPeriod;
    if (sample.lastError) this.lastError = sample.lastError;
    this.emit({
      deploymentId: this.cfg.deploymentId,
      eventType: "heartbeat",
      payload: {
        phase: sample.phase,
        cpuPct: sample.cpuPct ?? this.cpuPct(),
        memMb: sample.memMb ?? Math.round(process.memoryUsage().rss / (1024 * 1024)),
        tokensInPeriod: periodTokens,
        lastError: this.lastError,
      },
    });
  }

  /** Start periodic flush + heartbeat timers (unref'd — never hold the process). */
  start(getSample: () => Parameters<ControlPlane["heartbeat"]>[0]): void {
    if (!this.enabled) return;
    void this.flush();
    this.flushTimer = setInterval(() => void this.flush(), FLUSH_INTERVAL_MS);
    this.hbTimer = setInterval(() => this.heartbeat(getSample()), HEARTBEAT_INTERVAL_MS);
    this.flushTimer.unref?.();
    this.hbTimer.unref?.();
  }

  stop(): void {
    if (this.flushTimer) clearInterval(this.flushTimer);
    if (this.hbTimer) clearInterval(this.hbTimer);
    void this.flush();
  }
}

export function controlPlaneFromEnv(
  env: NodeJS.ProcessEnv,
  log?: (msg: string) => void,
): ControlPlane {
  return new ControlPlane({
    baseUrl: (env.AD_CONTROL_PLANE_URL ?? "").trim(),
    deploymentId: (env.DEPLOYMENT_ID ?? "").trim(),
    brokerToken: (env.AD_BROKER_TOKEN ?? "").trim(),
    log,
  });
}

/** Hostname — included in some telemetry payloads for support triage. */
export function machineHostname(): string {
  return os.hostname();
}
