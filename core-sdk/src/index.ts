// ── @agentdeploy-io/core-sdk ──────────────────────────────────────────────────
// Build long-running AI agents on Fly.io VMs with AgentDeploy billing,
// telemetry, and supervisor integration.
//
// This package provides the developer-facing API for building core agents
// that run inside the AgentDeploy runtime-packaging shim. The shim handles
// the Supervisor Protocol (HTTP endpoints, heartbeats, checkpoints); this
// SDK provides the high-level task execution framework.
//
//   - createCoreAgent()      → Agent factory with task handler registration
//   - defineTaskHandler()    → Typed task handler with lifecycle hooks
//   - createSqlExecutor()    → SQLite access on /data volume
//   - createGatewayClient()  → LLM gateway integration
//   - createSecretStore()    → Memory-only secret access
//   - createBudgetFence()    → Token/VM-hour budget monitoring
//   - createTelemetryClient()→ Platform telemetry
//   - saveCheckpoint()       → Checkpoint/restore for task durability

// Agent factory
export { createCoreAgent, executeTask, cancelTask, resumeTask, getRegisteredAgents } from "./core-agent.js";

// Task handler factory
export { defineTaskHandler } from "./task-handler.js";

// Infrastructure clients
export { createSqlExecutor } from "./sql.js";
export { createGatewayClient } from "./gateway.js";
export { createSecretStore, fetchBrokerSecrets } from "./secrets.js";
export { createBudgetFence } from "./budget-fence.js";
export { createTelemetryClient } from "./telemetry.js";
export { saveCheckpoint, loadCheckpoint, listCheckpoints, deleteCheckpoint } from "./checkpoint.js";
export { requestHumanInput, resolveHumanInput, getPendingInputs } from "./human-input.js";

// Types
export type {
  CoreAgentConfig,
  CoreAgent,
  CoreContext,
  TaskContext,
  TaskResult,
  TaskHandler,
  TaskState,
  SqlExecutor,
  SecretStore,
  GatewayClient,
  ChatMessage,
  ChatOptions,
  TelemetryClient,
  BudgetFence,
  HumanPrompt,
  HumanResponse,
  CheckpointBlob,
  PlatformConfig,
} from "./types.js";
