// ── AgentDeploy CLI — Platform API Client ────────────────────────────────────

import { getApiUrl, requireAuth, loadCredentials, saveCredentials } from "./config.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgeVersionInput {
  templateId: number;
  /** First-deploy support: server auto-creates a draft template when templateId is 0. */
  templateName?: string;
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
  /** Server returns snake_case `template_id` on the raw record. */
  templateId: number;
  template_id?: number;
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
    // Per-user Bearer auth: the CLI never holds the shared
    // INTERNAL_SERVICE_TOKEN. Identity/sellerId/userId are derived from the
    // key server-side — this client no longer sends them.
    const auth = requireAuth();
    headers["Authorization"] = `Bearer ${auth.apiKey}`;
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

export interface WhoamiResponse {
  user_id: string;
  key_id?: string;
  key_name?: string;
  scopes?: string[];
}

export async function whoami(): Promise<WhoamiResponse> {
  const res = await apiRequest<{ data: WhoamiResponse } | WhoamiResponse>(
    "GET",
    "/cli/whoami"
  );
  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `whoami failed (${res.status})`);
  }
  const data = res.data as { data?: WhoamiResponse } | WhoamiResponse;
  return "data" in data && data.data ? data.data : (data as WhoamiResponse);
}

// ── Templates & deployments listings ────────────────────────────────────────

export interface SellerTemplate {
  id: number;
  name: string;
  slug: string;
  status: string;
  deploy_runtime?: string;
  is_flow?: boolean;
  created_at?: string;
}

export async function listTemplates(): Promise<SellerTemplate[]> {
  const res = await apiRequest<{ data: { templates: SellerTemplate[] } } | { templates: SellerTemplate[] }>(
    "GET",
    "/cli/templates"
  );
  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to list templates (${res.status})`);
  }
  const data = res.data as { data?: { templates: SellerTemplate[] }; templates?: SellerTemplate[] };
  return data.data?.templates ?? data.templates ?? [];
}

export interface DeploymentSummary {
  id: string;
  template_id: number;
  status: string;
  url: string | null;
  model: string | null;
  created_at?: string;
}

export async function listMyDeployments(): Promise<DeploymentSummary[]> {
  const res = await apiRequest<{ data?: { deployments: DeploymentSummary[] }; deployments?: DeploymentSummary[] }>(
    "GET",
    "/cli/deployments"
  );
  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to list deployments (${res.status})`);
  }
  const data = res.data as { data?: { deployments: DeploymentSummary[] }; deployments?: DeploymentSummary[] };
  return data.data?.deployments ?? data.deployments ?? [];
}

// ── Version yank (rollback/unpublish) ────────────────────────────────────────

export async function yankEdgeVersion(versionId: string): Promise<EdgeVersionResponse> {
  const res = await apiRequest<{ data: EdgeVersionResponse } | EdgeVersionResponse>(
    "POST",
    `/cli/edge/versions/${versionId}/yank`
  );
  if (!res.ok) {
    const err = res.data as { message?: string; error?: { code?: string; message?: string } };
    const code = err.error?.code;
    const message = err.error?.message || err.message;
    throw new Error(
      message ? (code ? `[${code}] ${message}` : message) : `Yank failed (${res.status})`
    );
  }
  const data = res.data as { data?: EdgeVersionResponse } | EdgeVersionResponse;
  return "data" in data && data.data ? data.data : (data as EdgeVersionResponse);
}

export async function verifyAndSaveCredentials(
  apiKey: string,
  apiUrl?: string
): Promise<LoginResponse> {
  const baseUrl = apiUrl || getApiUrl();

  // Verify the key against the real per-user auth surface — /cli/whoami
  // resolves the key to its user. (The old /health check accepted ANY
  // string: login "succeeded" with garbage and deploy failed later.)
  const res = await fetch(`${baseUrl}/cli/whoami`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: { message?: string; hint?: string };
    };
    const hint = body.error?.hint ? ` (${body.error.hint})` : "";
    throw new Error(
      body.error?.message
        ? `${body.error.message}${hint}`
        : `Authentication failed (${res.status}). Check your API key.`
    );
  }

  const payload = (await res.json().catch(() => ({}))) as {
    data?: { user_id?: string; key_name?: string };
  };
  const userId = payload.data?.user_id || "";

  saveCredentials({
    apiKey,
    apiUrl: baseUrl,
    userId,
  });

  return { userId, valid: true };
}

// ── Logs ─────────────────────────────────────────────────────────────────────

export interface WorkerLogEntry {
  timestamp: string;
  level: string;
  message: string;
  eventId?: string;
}

export interface DeploymentLogsResponse {
  logs: WorkerLogEntry[];
  note?: string;
}

export async function getDeploymentLogs(
  deploymentId: string,
  options: { limit?: number; since?: number } = {}
): Promise<DeploymentLogsResponse> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.since !== undefined) params.set("since", String(options.since));
  const qs = params.toString();
  const res = await apiRequest<{ data: DeploymentLogsResponse } | DeploymentLogsResponse>(
    "GET",
    `/cli/deployments/${deploymentId}/logs${qs ? `?${qs}` : ""}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to fetch logs (${res.status})`);
  }

  const data = res.data as { data?: DeploymentLogsResponse } | DeploymentLogsResponse;
  return "data" in data && data.data ? data.data : (data as DeploymentLogsResponse);
}

// ── Edge Version Management ──────────────────────────────────────────────────

export async function createEdgeVersion(
  input: EdgeVersionInput
): Promise<EdgeVersionResponse> {
  const res = await apiRequest<{ data: EdgeVersionResponse } | EdgeVersionResponse>(
    "POST",
    "/cli/edge/versions",
    input
  );

  if (!res.ok) {
    const err = res.data as {
      message?: string;
      error?: string | { code?: string; message?: string };
    };
    const code = typeof err.error === "object" ? err.error?.code : undefined;
    if (code === "SELLER_VERIFICATION_REQUIRED") {
      throw new Error(
        "CLI deploys are limited to verified sellers.\n" +
          "Complete seller verification (Stripe Identity) and operator approval in the dashboard first:\n" +
          "  Dashboard → Seller → CLI keys"
      );
    }
    const message = typeof err.error === "object" ? err.error?.message : undefined;
    throw new Error(message || err.message || `Failed to create edge version (${res.status})`);
  }

  const data = res.data as { data?: EdgeVersionResponse } | EdgeVersionResponse;
  const version = "data" in data && data.data ? data.data : (data as EdgeVersionResponse);
  // Normalize snake_case template_id from the raw record.
  if (version.templateId === undefined && version.template_id !== undefined) {
    version.templateId = version.template_id;
  }
  return version;
}

export async function validateEdgeVersion(versionId: string): Promise<unknown> {
  const res = await apiRequest<unknown>(
    "POST",
    `/cli/edge/versions/${versionId}/validate`
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
    `/cli/edge/versions/${versionId}/publish`,
    { changelog }
  );

  if (!res.ok) {
    const err = res.data as { message?: string; error?: { code?: string; message?: string } };
    const code = err.error?.code;
    const message = err.error?.message || err.message;
    // Scan gate failures carry the findings list inside the message — surface
    // the code + full message, never collapse to a generic status string.
    if (code === "SCAN_FAILED" || code === "SCAN_REQUIRED") {
      throw new Error(`Security scan blocked publish [${code}]\n${message ?? ""}`);
    }
    if (code === "SELLER_VERIFICATION_REQUIRED") {
      throw new Error(
        "Your seller verification status changed — CLI publishing is limited to verified sellers.\n" +
          "Check Dashboard → Seller for your current verification status."
      );
    }
    throw new Error(
      message ? (code ? `[${code}] ${message}` : message) : `Publish failed (${res.status})`
    );
  }

  const data = res.data as { data?: EdgeVersionResponse } | EdgeVersionResponse;
  return "data" in data && data.data ? data.data : (data as EdgeVersionResponse);
}

// ── Edge Deployment Management ───────────────────────────────────────────────

/**
 * NOT wired to a /cli route: provisioning a NEW deployment runs the buyer
 * purchase-gate + hosting-entitlement flow, which the dashboard/BFF owns
 * (POST /internal/edge/deploy with the service token). `ad deploy` prints
 * the dashboard link for first deploys instead.
 */
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
  deploymentId: string
): Promise<EdgeDeployResponse> {
  // Ownership is enforced server-side from the Bearer key — no userId param.
  const res = await apiRequest<{ data: EdgeDeployResponse } | EdgeDeployResponse>(
    "POST",
    `/cli/edge/deployments/${deploymentId}/reprovision`
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
  _userId: string
): Promise<unknown> {
  // _userId kept for call-site compatibility; identity is key-derived.
  const res = await apiRequest<unknown>(
    "GET",
    `/cli/deployments/${deploymentId}`
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
  _userId: string,
  secretKey: string,
  secretValue: string
): Promise<void> {
  // _userId kept for call-site compatibility; identity is key-derived.
  const res = await apiRequest<unknown>(
    "POST",
    `/cli/deployments/${deploymentId}/secrets`,
    { secretKey, secretValue }
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to set secret (${res.status})`);
  }
}

export async function deleteSecret(
  deploymentId: string,
  _userId: string,
  secretKey: string
): Promise<void> {
  // _userId kept for call-site compatibility; identity is key-derived.
  const res = await apiRequest<unknown>(
    "DELETE",
    `/cli/deployments/${deploymentId}/secrets/${encodeURIComponent(secretKey)}`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to delete secret (${res.status})`);
  }
}

export async function getSecrets(
  deploymentId: string,
  userId: string
): Promise<DeploymentSecretsResponse> {
  const res = await apiRequest<{ data: DeploymentSecretsResponse } | DeploymentSecretsResponse>(
    "GET",
    `/cli/deployments/${deploymentId}/secrets`
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
    `/cli/deployments/${deploymentId}/secrets/required`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Failed to get required secrets (${res.status})`);
  }

  const data = res.data as { data?: { secrets: Array<{ key: string; required: boolean; description?: string }> } };
  return data.data || (res.data as unknown as { secrets: Array<{ key: string; required: boolean; description?: string }> });
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
    `/cli/edge/versions/${versionId}/agents`,
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
    `/cli/edge/versions/${versionId}/agents/validate`
  );

  if (!res.ok) {
    const err = res.data as { message?: string };
    throw new Error(err.message || `Agent registry validation failed (${res.status})`);
  }

  const data = res.data as { data?: Awaited<ReturnType<typeof validateAgentRegistry>> };
  return data.data ?? (data as Awaited<ReturnType<typeof validateAgentRegistry>>);
}
