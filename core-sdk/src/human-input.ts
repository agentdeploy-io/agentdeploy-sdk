import type { HumanPrompt, HumanResponse } from "./types.js";

const pendingInputs = new Map<string, {
  resolve: (response: HumanResponse) => void;
  prompt: HumanPrompt;
  timeout: ReturnType<typeof setTimeout>;
}>();

export async function requestHumanInput(
  taskId: string,
  prompt: HumanPrompt,
  controlPlaneUrl: string,
  deploymentId: string,
  brokerToken: string,
): Promise<HumanResponse> {
  const timeoutMs = (prompt.timeout || 3600) * 1000;

  const responsePromise = new Promise<HumanResponse>((resolve) => {
    const timeout = setTimeout(() => {
      pendingInputs.delete(taskId);
      resolve({
        action: prompt.defaultAction || "timeout",
        respondedAt: new Date().toISOString(),
        timedOut: true,
      });
    }, timeoutMs);

    pendingInputs.set(taskId, { resolve, prompt, timeout });
  });

  if (controlPlaneUrl && brokerToken && deploymentId) {
    try {
      await fetch(`${controlPlaneUrl}/v1/telemetry`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Deployment-Id": deploymentId,
          "X-Broker-Token": brokerToken,
        },
        body: JSON.stringify({
          events: [{
            deploymentId,
            eventType: "task_transition",
            taskId,
            payload: {
              to: "awaiting_input",
              prompt: {
                type: prompt.type,
                message: prompt.message,
                options: prompt.options,
                timeout: prompt.timeout,
              },
            },
            ts: new Date().toISOString(),
          }],
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      console.error("[core-sdk] Failed to notify platform of awaiting_input:", error);
    }
  }

  return responsePromise;
}

export function resolveHumanInput(taskId: string, response: HumanResponse): boolean {
  const pending = pendingInputs.get(taskId);
  if (!pending) return false;

  clearTimeout(pending.timeout);
  pendingInputs.delete(taskId);
  pending.resolve(response);
  return true;
}

export function getPendingInputs(): Map<string, HumanPrompt> {
  const result = new Map<string, HumanPrompt>();
  for (const [taskId, entry] of pendingInputs) {
    result.set(taskId, entry.prompt);
  }
  return result;
}
