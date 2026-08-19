// ── AgentDeploy CLI — Platform API Client ────────────────────────────────────

import { getApiUrl, requireAuth, loadCredentials, saveCredentials } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeVersionInput {
  templateId: number;
  sellerId: string;
  version: string;
  entrypoint?: string;
  format?: "esm" | "service_worker";
  source?: "cli" | "github" | "dashboard" | "api";
  script?: string;
  compatibilityDate?: string;
  compatibilityFlags?: string[];
  bindings?: EdgeBindingInput[];
  changelog?: string;
}

export interface EdgeBindingInput {
  type:
    | "kv_namespace"
    | "r2_bucket"
    | "durable_object"
    | "durable_object_namespace"
    | "queue"
    | "d1_database"
    | "plain_text"
    | "json"
    | "secret_text"
    | "ai";
  name: string;
  namespace_id?: string;
  bucket_name?: string;
  class_name?: string;
  script_name?: string;
  queue_name?: string;
  database_name?: string;
  database_id?: string;
  value?: string;
}

export interface EdgeVersionResponse {
  id: string;
  templateId: number;
  version: string;
  status: string;
  source?: string;
  scriptSha256: string;
  scriptSizeBytes: number;
  capabilityInfo?: {
    usesAgentsSdk: boolean;
    usesAgentdeploySdk: boolean;
    durableObjectClasses: string[];
    usesAgentRouting: boolean;
    needsNodejsCompat: boolean;
    needsAiBinding: boolean;
    usesMcp: boolean;
    usesScheduling: boolean;
    agentCount: number;
  } | null;
  createdAt: string;
}

export interface EdgeDeployInput {
  templateId: number;
  buyerUserId: string;
  llmProvider: string;
  model: string;
  region?: string;
  packageSubscriptionId?: string;
  packageId?: string;
  packageItemId?: string;
}

export interface EdgeDeployResponse {
  id: string;
  status: string;
  cloudflareWorkerUrl?: string;
  cloudflareWorkerName?: string;
  llmProvider: string;
  model: string;
}

export interface DeploymentSecretsResponse {
  secrets: Array<{ key: string; set: boolean }>;
}

export interface LoginResponse {
  userId: string;
  valid: boolean;
}

// ── HTTP helper ──────────────────────────────────────────────────────────────

interface ApiResponse<T> {
  ok: boolean;
  status: number;
  data: T | { error: string; code?: string; message?: string; details?: unknown };
}

async function apiRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: { skipAuth?: boolean }
): Promise<ApiResponse<T>> {
  const baseUrl = getApiUrl();
  const url = `${baseUrl}${path}`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (!options?.skipAuth) {
    const auth = requireAuth();
    headers["X-Internal-Token"] = auth.apiKey;
    headers["X-Internal-Origin"] = "cli.agentdeploy.io";
  }

  const init: RequestInit = {
    method,
    headers,
  };

  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    throw new Error(`Network error connecting to ${baseUrl}: ${(err as Error).message}`);
  }

  const data = await res.json().catch(() => ({ error: "Invalid JSON response" }));

  return {
    ok: res.ok,
    status: res.status,
    data: data as T | { error: string; code?: string; message?: string },
  };
}

// ── Auth ─────────────────────────────────────────────────────────────────────

export async function verifyAndSaveCredentials(
  apiKey: string,
  apiUrl?: string
): Promise<LoginResponse> {
  const baseUrl = apiUrl || getApiUrl();

  // Verify the key by hitting a simple endpoint
  const res = await fetch(`${baseUrl}/health`, {
    headers: {
      "X-Internal-Token": apiKey,
      "X-Internal-Origin": "cli.agentdeploy.io",
    },
  });

  if (!res.ok) {
    throw new Error(`Authentication failed (${res.status}). Check your API key.`);
  }

  // Save credentials
  saveCredentials({
    apiKey,
    apiUrl: baseUrl,
  });

  return { userId: "", valid: true };
}

// ── Edge Version Management ──────────────────────────────────────────────────

export async function createEdgeVersion(
  input: EdgeVersionInput
): Promise<EdgeVersionResponse> {
  const res = await apiRequest<{ data: EdgeVersionResponse } | EdgeVersionResponse>(
    "POST",
    "/internal/edge/versions",
    input
  );

  if (!res.ok) {
    const err = res.data as { message?: string; error?: string };
    throw new Error(err.message || err.error || `Failed to create edge version (${res.status})`);
  }

  const data = res.data as { data?: EdgeVersionResponse } | EdgeVersionResponse;
  return "data" in data && data.data ? data.data : (data as EdgeVersionResponse);
}

export async function validateEdgeVersion(versionId: string): Promise<unknown> {
  const res = await apiRequest<unknown>(
    "POST",
    `/internal/edge/versions/${versionId}/validate`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Validation failed (${res.status})`);
  }

  return res.data;
}

export async function publishEdgeVersion(
  versionId: string,
  changelog?: string
): Promise<EdgeVersionResponse> {
  const res = await apiRequest<{ data: EdgeVersionResponse } | EdgeVersionResponse>(
    "POST",
    `/internal/edge/versions/${versionId}/publish`,
    { changelog }
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Publish failed (${res.status})`);
  }

  const data = res.data as { data?: EdgeVersionResponse } | EdgeVersionResponse;
  return "data" in data && data.data ? data.data : (data as EdgeVersionResponse);
}

// ── Edge Deployment Management ───────────────────────────────────────────────

export async function provisionEdgeDeployment(
  input: EdgeDeployInput
): Promise<EdgeDeployResponse> {
  const res = await apiRequest<{ data: EdgeDeployResponse } | EdgeDeployResponse>(
    "POST",
    "/internal/edge/deploy",
    input
  );

  if (!res.ok) {
    const err = res.data as { message?: string; code?: string };
    throw new Error(err.message || err.code || `Deployment failed (${res.status})`);
  }

  const data = res.data as { data?: EdgeDeployResponse } | EdgeDeployResponse;
  return "data" in data && data.data ? data.data : (data as EdgeDeployResponse);
}

export async function reprovisionDeployment(
  deploymentId: string,
  userId: string
): Promise<EdgeDeployResponse> {
  const res = await apiRequest<{ data: EdgeDeployResponse } | EdgeDeployResponse>(
    "POST",
    `/internal/edge/deployments/${deploymentId}/reprovision?userId=${userId}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Reprovision failed (${res.status})`);
  }

  const data = res.data as { data?: EdgeDeployResponse } | EdgeDeployResponse;
  return "data" in data && data.data ? data.data : (data as EdgeDeployResponse);
}

export async function getDeployment(
  deploymentId: string,
  userId: string
): Promise<unknown> {
  const res = await apiRequest<unknown>(
    "GET",
    `/internal/edge/deployments/${deploymentId}?userId=${userId}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to get deployment (${res.status})`);
  }

  return res.data;
}

// ── Secrets ──────────────────────────────────────────────────────────────────

export async function setSecret(
  deploymentId: string,
  userId: string,
  secretKey: string,
  secretValue: string
): Promise<void> {
  const res = await apiRequest<unknown>(
    "POST",
    `/internal/deployments/${deploymentId}/secrets`,
    { userId, secretKey, secretValue }
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to set secret (${res.status})`);
  }
}

export async function getSecrets(
  deploymentId: string,
  userId: string
): Promise<DeploymentSecretsResponse> {
  const res = await apiRequest<{ data: DeploymentSecretsResponse } | DeploymentSecretsResponse>(
    "GET",
    `/internal/deployments/${deploymentId}/secrets?userId=${userId}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to get secrets (${res.status})`);
  }

  const data = res.data as { data?: DeploymentSecretsResponse } | DeploymentSecretsResponse;
  return "data" in data && data.data ? data.data : (data as DeploymentSecretsResponse);
}

export async function getRequiredSecrets(
  deploymentId: string,
  userId: string
): Promise<{ secrets: Array<{ key: string; required: boolean; description?: string }> }> {
  const res = await apiRequest<{ data: { secrets: Array<{ key: string; required: boolean; description?: string }> } }>(
    "GET",
    `/internal/deployments/${deploymentId}/secrets/required?userId=${userId}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to get required secrets (${res.status})`);
  }

  const data = res.data as { data?: { secrets: Array<{ key: string; required: boolean; description?: string }> } };
  return data.data || (res.data as { secrets: Array<{ key: string; required: boolean; description?: string }> });
}

// ── Agent Registry ───────────────────────────────────────────────────────────

export interface AgentDeclarationInput {
  class_name: string;
  display_name: string;
  description?: string | null;
  capacity_weight?: number;
  can_route?: boolean;
  routes_to?: string[] | null;
  uses_mcp?: boolean;
  uses_scheduling?: boolean;
  is_entrypoint?: boolean;
}

/**
 * Registers agent declarations for a template version.
 * Called after version creation but before publish.
 *
 * If the version already has declarations, this is a no-op
 * (the server returns 409 for duplicates).
 */
export async function registerAgents(
  versionId: string,
  agents: AgentDeclarationInput[]
): Promise<{ registered: number; skipped: boolean }> {
  if (agents.length === 0) return { registered: 0, skipped: false };

  const res = await apiRequest<{ data: unknown } | { error: string; code?: string }>(
    "POST",
    `/internal/edge/versions/${versionId}/agents`,
    { agents }
  );

  if (!res.ok) {
    // If agents are already declared, that's fine — skip
    const err = res.data as { code?: string; message?: string };
    if (err?.code === "AGENT_ALREADY_DECLARED" || err?.code === "VERSION_LOCKED") {
      return { registered: 0, skipped: true };
    }
    throw new Error(err?.message || err?.code || `Agent registration failed (${res.status})`);
  }

  return { registered: agents.length, skipped: false };
}

/**
 * Validates the agent registry against the script.
 * Returns the validation result.
 */
export async function validateAgentRegistry(
  versionId: string
): Promise<{
  valid: boolean;
  undeclared: string[];
  unregistered: string[];
  totalWeight: number;
  errors: string[];
}> {
  const res = await apiRequest<{ data: Awaited<ReturnType<typeof validateAgentRegistry>> }>(
    "POST",
    `/internal/edge/versions/${versionId}/agents/validate`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Agent registry validation failed (${res.status})`);
  }

  const data = res.data as { data?: Awaited<ReturnType<typeof validateAgentRegistry>> };
  return data.data ?? (data as Awaited<ReturnType<typeof validateAgentRegistry>>);
}
