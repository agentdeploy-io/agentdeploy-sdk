/**
 * @agentdeploy-io/agents/client — WebSocket client for connecting to Agents
 *
 * Re-exports the upstream AgentClient and related utilities.
 * In Phase 2, this will be extended with UI-aware connection helpers.
 */

export {
  AgentClient,
  AgentConnectionError,
  agentFetch,
  createStubProxy,
  isTerminalCloseEvent,
  DEFAULT_CALL_TIMEOUT_MS,
} from "agents/client";

export type {
  AgentClientOptions,
} from "agents/client";
