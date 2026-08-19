/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Disable auth entirely (local dev) */
  readonly VITE_AUTH_DISABLED?: string;
  /** Marketplace URL (agentdeploy.io) */
  readonly VITE_MARKETPLACE_URL?: string;
  /** Deployment-service API base URL */
  readonly VITE_DEPLOYMENT_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
