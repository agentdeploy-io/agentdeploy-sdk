import type { SecretStore } from "./types.js";

class SecretStoreImpl implements SecretStore {
  private secrets: Record<string, string>;

  constructor(secrets: Record<string, string>) {
    this.secrets = { ...secrets };
  }

  get(key: string): string {
    const val = this.secrets[key];
    if (val === undefined || val === null) {
      throw new Error(
        `Secret "${key}" is not available. Configure it in the AgentDeploy dashboard ` +
        `under Deployment > Secrets. Secrets are fetched at boot via the broker token ` +
        `and kept in memory only.`
      );
    }
    return val;
  }

  has(key: string): boolean {
    return key in this.secrets && this.secrets[key] !== undefined && this.secrets[key] !== "";
  }

  getAll(): Record<string, string> {
    return { ...this.secrets };
  }
}

export function createSecretStore(secrets: Record<string, string>): SecretStore {
  return new SecretStoreImpl(secrets);
}

export async function fetchBrokerSecrets(): Promise<Record<string, string>> {
  const controlPlane = (process.env["CONTROL_PLANE_URL"] || "").replace(/\/$/, "");
  const brokerToken = process.env["AD_BROKER_TOKEN"] || "";
  const deploymentId = process.env["DEPLOYMENT_ID"] || "";

  if (!controlPlane || !brokerToken || !deploymentId) {
    console.warn("[core-sdk] Platform not configured — running without broker secrets (local dev)");
    return {};
  }

  try {
    const res = await fetch(`${controlPlane}/v1/broker/secrets`, {
      headers: {
        "X-Deployment-Id": deploymentId,
        "X-Broker-Token": brokerToken,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      console.error(`[core-sdk] Broker secrets fetch failed: ${res.status}`);
      return {};
    }

    const body = await res.json() as { secrets?: Record<string, string> };
    return body.secrets ?? {};
  } catch (error) {
    console.error("[core-sdk] Broker secrets fetch error:", error);
    return {};
  }
}
