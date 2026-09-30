import type {
  CoreAgentConfig,
  CoreAgent,
  CoreContext,
  TaskContext,
  TaskResult,
  PlatformConfig,
} from "./types.js";
import { createSqlExecutor } from "./sql.js";
import { createGatewayClient } from "./gateway.js";
import { createSecretStore, fetchBrokerSecrets } from "./secrets.js";
import { createBudgetFence } from "./budget-fence.js";
import { createTelemetryClient } from "./telemetry.js";
import { requestHumanInput, resolveHumanInput } from "./human-input.js";
import { saveCheckpoint, loadCheckpoint } from "./checkpoint.js";

function loadPlatformConfig(): PlatformConfig {
  return {
    deploymentId: process.env["DEPLOYMENT_ID"] || "local-dev",
    userId: process.env["USER_ID"] || "local-dev",
    templateId: parseInt(process.env["TEMPLATE_ID"] || "0", 10),
    model: process.env["MODEL"] || process.env["LLM_PROVIDER"] || "openai/gpt-4o-mini",
    region: process.env["REGION"] || "local",
    controlPlaneUrl: (process.env["CONTROL_PLANE_URL"] || "").replace(/\/$/, ""),
    gatewayBaseUrl: (process.env["GATEWAY_BASE_URL"] || process.env["AD_GATEWAY_BASE_URL"] || "").replace(/\/$/, ""),
    gatewayApiKey: process.env["AD_GATEWAY_API_KEY"] || process.env["GATEWAY_API_KEY"] || "",
    brokerToken: process.env["AD_BROKER_TOKEN"] || "",
    dataDir: process.env["DATA_DIR"] || "/data",
    maxTokensPerDay: parseInt(process.env["MAX_TOKENS_PER_DAY"] || "500000", 10),
    maxVmHoursPerDay: parseInt(process.env["MAX_VM_HOURS_PER_DAY"] || "4", 10),
  };
}

const activeAgents = new Map<string, CoreAgent>();
const taskStates = new Map<string, { state: string; cancelled: boolean }>();

export function createCoreAgent(config: CoreAgentConfig): CoreAgent {
  const agent: CoreAgent = {
    name: config.name,
    description: config.description,
    taskHandlers: config.taskHandlers,
    onStart: config.onStart,
    onStop: config.onStop,
    _registered: true,
  };

  activeAgents.set(config.name, agent);
  return agent;
}

export async function executeTask(
  taskId: string,
  taskType: string,
  input: Record<string, unknown>,
): Promise<TaskResult> {
  const config = loadPlatformConfig();

  const secrets = await fetchBrokerSecrets();
  const secretStore = createSecretStore(secrets);
  const sql = createSqlExecutor(config.dataDir);
  const gateway = createGatewayClient(config.gatewayBaseUrl, config.deploymentId, config.model, config.gatewayApiKey);
  const budget = createBudgetFence(config.maxTokensPerDay, config.maxVmHoursPerDay);
  const telemetry = createTelemetryClient(config.controlPlaneUrl, config.deploymentId, config.brokerToken);

  taskStates.set(taskId, { state: "running", cancelled: false });

  const coreCtx: CoreContext = {
    deploymentId: config.deploymentId,
    userId: config.userId,
    templateId: config.templateId,
    model: config.model,
    region: config.region,
    sql,
    secrets: secretStore,
    gateway,
  };

  let agent: CoreAgent | undefined;
  for (const a of activeAgents.values()) {
    if (a.taskHandlers[taskType]) {
      agent = a;
      break;
    }
  }

  if (!agent) {
    const first = activeAgents.values().next().value;
    agent = first;
  }

  if (!agent) {
    return { state: "failed", error: `No agent registered for task type: ${taskType}` };
  }

  if (agent.onStart) {
    try {
      await agent.onStart(coreCtx);
    } catch (error) {
      console.error(`[core-sdk] onStart failed for ${agent.name}:`, error);
    }
  }

  const handler = agent.taskHandlers[taskType] || Object.values(agent.taskHandlers)[0];
  if (!handler) {
    return { state: "failed", error: `No handler for task type: ${taskType}` };
  }

  const taskCtx: TaskContext = {
    taskId,
    deploymentId: config.deploymentId,
    userId: config.userId,
    templateId: config.templateId,
    model: config.model,
    sql,
    secrets: secretStore,
    gateway,
    telemetry,
    budget,
    reportProgress(phase: string, data?: Record<string, unknown>) {
      telemetry.event("progress", { taskId, phase, ...data });
    },
    async requestHumanInput(prompt) {
      taskStates.set(taskId, { state: "awaiting_input", cancelled: false });
      const response = await requestHumanInput(
        taskId,
        prompt,
        config.controlPlaneUrl,
        config.deploymentId,
        config.brokerToken,
      );
      if (!response.timedOut) {
        taskStates.set(taskId, { state: "resumed", cancelled: false });
      }
      return response;
    },
    async checkpoint(data: unknown) {
      saveCheckpoint(taskId, { schemaVersion: 1, taskId, data });
      telemetry.event("checkpoint", { taskId });
    },
  };

  const parsed = handler.inputSchema.safeParse(input);
  if (!parsed.success) {
    return { state: "failed", error: `Input validation failed: ${parsed.error.message}` };
  }

  const existing = loadCheckpoint(taskId);
  if (existing && handler.onRestore) {
    try {
      await handler.onRestore(existing, taskCtx);
    } catch (error) {
      console.error(`[core-sdk] checkpoint restore failed for ${taskId}:`, error);
    }
  }

  budget.onExhausted(async () => {
    console.warn(`[core-sdk] Budget exhausted for task ${taskId} — checkpointing`);
    if (handler.onCheckpoint) {
      try {
        const blob = await handler.onCheckpoint(taskCtx);
        saveCheckpoint(taskId, blob);
      } catch (error) {
        console.error(`[core-sdk] budget-exhaust checkpoint failed:`, error);
      }
    }
    taskStates.set(taskId, { state: "expired", cancelled: false });
  });

  try {
    const result = await handler.execute(parsed.data, taskCtx);
    const state = taskStates.get(taskId);
    if (state?.cancelled) {
      return { state: "failed", error: "Task was cancelled" };
    }
    if (state?.state === "expired") {
      return { state: "failed", error: "Budget exhausted" };
    }
    telemetry.flush();
    return result;
  } catch (error) {
    telemetry.flush();
    return {
      state: "failed",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function cancelTask(taskId: string): boolean {
  const state = taskStates.get(taskId);
  if (!state) return false;
  state.cancelled = true;
  state.state = "cancelled";
  return true;
}

export function resumeTask(taskId: string, humanResponse: { action: string; input?: string }): boolean {
  return resolveHumanInput(taskId, {
    action: humanResponse.action,
    input: humanResponse.input,
    respondedAt: new Date().toISOString(),
    timedOut: false,
  });
}

export function getRegisteredAgents(): Map<string, CoreAgent> {
  return activeAgents;
}
