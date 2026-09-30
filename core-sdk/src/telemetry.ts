import type { TelemetryClient } from "./types.js";

class TelemetryClientImpl implements TelemetryClient {
  private controlPlaneUrl: string;
  private deploymentId: string;
  private brokerToken: string;
  private buffer: Array<Record<string, unknown>> = [];
  private flushTimer: ReturnType<typeof setInterval>;

  constructor(controlPlaneUrl: string, deploymentId: string, brokerToken: string) {
    this.controlPlaneUrl = controlPlaneUrl.replace(/\/$/, "");
    this.deploymentId = deploymentId;
    this.brokerToken = brokerToken;

    this.flushTimer = setInterval(() => {
      this.flush();
    }, 5_000);
    this.flushTimer.unref();
  }

  event(type: string, data?: Record<string, unknown>): void {
    this.buffer.push({
      deploymentId: this.deploymentId,
      eventType: type,
      payload: data,
      ts: new Date().toISOString(),
    });
    if (this.buffer.length >= 50) {
      this.flush();
    }
  }

  toolCall(name: string, input: unknown, output: unknown, durationMs: number): void {
    this.event("tool_call", {
      toolName: name,
      input: typeof input === "object" ? JSON.stringify(input).slice(0, 1000) : String(input).slice(0, 200),
      output: typeof output === "object" ? JSON.stringify(output).slice(0, 1000) : String(output).slice(0, 200),
      durationMs,
    });
  }

  flush(): void {
    if (this.buffer.length === 0) return;
    if (!this.controlPlaneUrl || !this.brokerToken || !this.deploymentId) {
      this.buffer = [];
      return;
    }

    const events = this.buffer.splice(0);
    void fetch(`${this.controlPlaneUrl}/v1/telemetry`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Deployment-Id": this.deploymentId,
        "X-Broker-Token": this.brokerToken,
      },
      body: JSON.stringify({ events }),
      signal: AbortSignal.timeout(10_000),
    }).catch((error) => {
      console.error("[core-sdk] Telemetry flush failed:", error);
      this.buffer.unshift(...events.slice(0, 100));
    });
  }

  destroy(): void {
    clearInterval(this.flushTimer);
    this.flush();
  }
}

export function createTelemetryClient(
  controlPlaneUrl: string,
  deploymentId: string,
  brokerToken: string,
): TelemetryClientImpl {
  return new TelemetryClientImpl(controlPlaneUrl, deploymentId, brokerToken);
}
