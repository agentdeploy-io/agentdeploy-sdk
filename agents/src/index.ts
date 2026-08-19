/**
 * @agentdeploy-io/agents — Fork of Cloudflare Agents SDK
 *
 * This package wraps the upstream `agents` npm package, providing:
 *   - Full backward compatibility with all upstream exports
 *   - Decoupled version control (we control when to bump)
 *   - Additional UI shell integration points (Phase 2)
 *   - Custom React hooks with enhanced state management
 *   - Extended Vite plugin with UI asset handling
 *
 * Everything exported from the upstream `agents` package is re-exported
 * here, so `import { Agent } from "@agentdeploy-io/agents"` is equivalent
 * to `import { Agent } from "agents"`.
 *
 * If Cloudflare sunsets or breaks the upstream package, we swap the
 * implementation behind this facade without breaking consumers.
 */

// ── Re-export everything from upstream ────────────────────────────────────────
export {
  Agent,
  routeAgentRequest,
  routeAgentEmail,
  callable,
  unstable_callable,
  getCurrentAgent,
  getAgentByName,
  parseSubAgentPath,
  getSubAgentByName,
  routeSubAgentRequest,
  SUB_PREFIX,
  isPlatformTransientError,
  isDurableObjectStorageReset,
  isDurableObjectCodeUpdateReset,
  isDurableObjectMemoryLimitReset,
} from "agents";

// ── Re-export types ───────────────────────────────────────────────────────────
export type {
  Agent as AgentClass,
  AgentOptions,
  AgentStaticOptions,
  AgentGetOptions,
  AgentContext,
  AgentNamespace,
  Connection,
  ConnectionContext,
  Schedule,
  ScheduleCriteria,
  MessageType,
  RPCRequest,
  RPCResponse,
  RetryOptions,
  SqlError,
  SubAgentClass,
  SubAgentStub,
  SubAgentPathMatch,
} from "agents";

// ── Fork metadata ────────────────────────────────────────────────────────────

export const FORK_VERSION = "0.1.0";
export const UPSTREAM_VERSION = "0.18.0";
export const FORK_NAME = "@agentdeploy-io/agents";

/**
 * Returns fork metadata for diagnostics.
 */
export function getForkInfo() {
  return {
    fork: FORK_NAME,
    forkVersion: FORK_VERSION,
    upstream: "agents",
    upstreamVersion: UPSTREAM_VERSION,
  };
}
