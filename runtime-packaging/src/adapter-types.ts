/**
 * RuntimeAdapter — the contract between AgentDeploy's generic supervisor shim
 * and any agent framework.
 *
 * Design goal: adding a framework is a CONFIG object plus at most two small
 * functions, never an integration project. Everything common (contract HTTP
 * endpoints, heartbeats, telemetry, budget counting, checkpoint tar/restore,
 * secret-broker fetch) lives in the shim and is framework-agnostic.
 *
 * Invocation styles:
 *  - "server": the framework runs as a long-lived process exposing its own
 *    HTTP interface (n8n, Mastra, OpenHands). start() boots it once; tasks
 *    are delegated via optional delegateTask (e.g. webhook/API call).
 *  - "cli": each task spawns a fresh framework process (Hermes headless,
 *    OpenClaw CLI). stateFor maps exit codes / output to task states.
 */

export type InvocationStyle = "server" | "cli";

export type TaskState =
  | "queued"
  | "running"
  | "awaiting_input"
  | "checkpointed"
  | "resumed"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "expired";

export interface AdapterTaskPayload {
  taskId: string;
  taskType: string;
  /** Opaque buyer payload — passed to the framework verbatim. */
  input: Record<string, unknown>;
  /** Decrypted secrets from the broker, memory-only. */
  secrets: Record<string, string>;
}

export interface TaskOutcome {
  state: TaskState;
  tokensUsed?: number;
  error?: string;
}

export interface RuntimeAdapter {
  /** Registry key — matches core_runtimes.key. */
  readonly name: string;

  readonly invocation: InvocationStyle;

  /**
   * Command line to boot the framework.
   * For "server": started once at container boot; must listen on `port`.
   * For "cli": template executed per task. Supports {prompt} placeholder
   * replaced with the serialized payload.input.prompt ?? JSON body.
   */
  readonly command: string[];

  /** Port the framework listens on (server style). Fly routes this too. */
  readonly port: number;

  /** Path that answers 200 when the framework is up. */
  readonly healthPath: string;

  /**
   * Directories checkpointed to /data/checkpoints before stop/expiry and on
   * POST /checkpoint. Restore copies them back before resume/boot.
   */
  readonly checkpointPaths: string[];

  /**
   * Map broker secret keys → env vars the framework expects.
   * e.g. n8n wants N8N_* config; Hermes wants provider API keys by name.
   */
  readonly secretEnvMapping: Record<string, string>;

  /**
   * CLI only: map a finished process to a task outcome.
   * exitCode + captured stdout/stderr tail → state (+ token estimate if the
   * framework reports usage).
   */
  interpretExit?(exitCode: number, outputTail: string): TaskOutcome;

  /**
   * Server style only (optional): hand a task to the running framework
   * (webhook/API) and resolve with an outcome. If absent, server runtimes
   * accept tasks but report them as running until their own tooling acts —
   * buyers interact through the framework's native UI proxied by the console.
   */
  delegateTask?(payload: AdapterTaskPayload): Promise<TaskOutcome>;

  /**
   * Optional extra env for the framework process beyond secrets (config
   * flags, port wiring, generic settings).
   */
  readonly extraEnv?: Record<string, string>;
}

/** Registry of built-in adapters. Adding a runtime = adding one entry. */
export const ADAPTERS: Record<string, () => RuntimeAdapter> = {};

export function registerAdapter(name: string, factory: () => RuntimeAdapter): void {
  ADAPTERS[name] = factory;
}

export function getAdapter(name: string): RuntimeAdapter {
  const factory = ADAPTERS[name];
  if (!factory) {
    throw new Error(
      `Unknown runtime adapter "${name}". Available: ${Object.keys(ADAPTERS).join(", ") || "none"}`
    );
  }
  return factory();
}
