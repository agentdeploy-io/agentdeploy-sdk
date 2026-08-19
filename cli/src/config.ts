// ── AgentDeploy CLI — Config & Auth ─────────────────────────────────────────

import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

// ── Project config (.agentdeploy/config.json) ────────────────────────────────

export interface ProjectConfig {
  /** Project identifier */
  projectId: string;
  /** Display name for this agent */
  name: string;
  /** Template type: chat-agent | scheduled-agent | custom */
  template: string;
  /** Entrypoint relative to project root */
  entrypoint: string;
  /** Model hint (platform may override) */
  model?: string;
  /** Platform API URL */
  apiUrl?: string;
  /** Secret manifest for deployment */
  secrets?: SecretManifestEntry[];
  /** Deployment ID (set after first deploy) */
  deploymentId?: string;
  /** Template ID in marketplace (set after publish) */
  templateId?: number;
}

export interface SecretManifestEntry {
  key: string;
  required: boolean;
  description?: string;
}

const PROJECT_CONFIG_DIR = ".agentdeploy";
const PROJECT_CONFIG_FILE = "config.json";

/**
 * Find the project root by searching upwards for .agentdeploy/config.json.
 */
export function findProjectRoot(startDir: string = process.cwd()): string | null {
  let dir = startDir;
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Load the project config from .agentdeploy/config.json.
 */
export function loadProjectConfig(projectRoot?: string): ProjectConfig {
  const root = projectRoot ?? findProjectRoot();
  if (!root) {
    throw new Error(
      "No AgentDeploy project found. Run 'ad init' to create a new project, " +
        "or run this command from within an AgentDeploy project directory."
    );
  }
  const configPath = join(root, PROJECT_CONFIG_DIR, PROJECT_CONFIG_FILE);
  const raw = readFileSync(configPath, "utf-8");
  return JSON.parse(raw) as ProjectConfig;
}

/**
 * Save the project config.
 */
export function saveProjectConfig(config: ProjectConfig, projectRoot?: string): void {
  const root = projectRoot ?? process.cwd();
  const configDir = join(root, PROJECT_CONFIG_DIR);
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true });
  }
  const configPath = join(configDir, PROJECT_CONFIG_FILE);
  writeFileSync(configPath, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

// ── Global auth (~/.agentdeploy/credentials) ─────────────────────────────────

export interface AuthCredentials {
  /** API key for platform authentication */
  apiKey: string;
  /** Platform API URL */
  apiUrl: string;
  /** User ID (from platform) */
  userId?: string;
}

const GLOBAL_CONFIG_DIR = join(homedir(), ".agentdeploy");
const CREDENTIALS_FILE = "credentials";

/**
 * Load saved auth credentials from ~/.agentdeploy/credentials.
 */
export function loadCredentials(): AuthCredentials | null {
  const credPath = join(GLOBAL_CONFIG_DIR, CREDENTIALS_FILE);
  if (!existsSync(credPath)) return null;
  try {
    const raw = readFileSync(credPath, "utf-8");
    return JSON.parse(raw) as AuthCredentials;
  } catch {
    return null;
  }
}

/**
 * Save auth credentials to ~/.agentdeploy/credentials.
 */
export function saveCredentials(creds: AuthCredentials): void {
  if (!existsSync(GLOBAL_CONFIG_DIR)) {
    mkdirSync(GLOBAL_CONFIG_DIR, { recursive: true });
  }
  const credPath = join(GLOBAL_CONFIG_DIR, CREDENTIALS_FILE);
  writeFileSync(credPath, JSON.stringify(creds, null, 2) + "\n", "utf-8");
  // Restrict permissions on credentials file (Unix only)
  try {
    chmodSync(credPath, 0o600);
  } catch {
    // Best effort — Windows doesn't support chmod
  }
}

/**
 * Get the API URL from credentials or environment.
 */
export function getApiUrl(): string {
  const creds = loadCredentials();
  if (creds?.apiUrl) return creds.apiUrl;
  if (process.env.AGENTDEPLOY_API_URL) return process.env.AGENTDEPLOY_API_URL;
  return "https://api.agentdeploy.io";
}

/**
 * Get the API key from credentials or environment.
 */
export function getApiKey(): string | null {
  const creds = loadCredentials();
  if (creds?.apiKey) return creds.apiKey;
  if (process.env.AGENTDEPLOY_API_KEY) return process.env.AGENTDEPLOY_API_KEY;
  return null;
}

/**
 * Require authentication — throws if not logged in.
 */
export function requireAuth(): AuthCredentials {
  const creds = loadCredentials();
  if (!creds?.apiKey) {
    throw new Error(
      "Not authenticated. Run 'ad login' to set your API key, " +
        "or set AGENTDEPLOY_API_KEY environment variable."
    );
  }
  return creds;
}
