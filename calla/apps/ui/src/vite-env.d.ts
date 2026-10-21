/// <reference types="vite/client" />

interface CallaRuntimeConfig {
  MARKETPLACE_URL?: string;
  DEPLOYMENT_API_URL?: string;
  BRAIN_URL?: string;
  /**
   * Explicit auth strategy override: "disabled" | "standalone" | "marketplace".
   * When omitted the UI infers it (localhost → disabled; MARKETPLACE_URL
   * empty/"none"/"self" → standalone; otherwise → marketplace).
   */
  AUTH_MODE?: string;
  /** Whitelabel console name (default "Calla"). */
  BRAND_NAME?: string;
  /** Whitelabel tagline (default "HITL Orchestration"). */
  BRAND_TAGLINE?: string;
  /** Whitelabel accent hex (e.g. "#0f766e") — overrides --primary at boot. */
  BRAND_ACCENT?: string;
  /**
   * Per-deployment enabled modules (array of module ids, or a
   * comma-separated string). Empty/absent = all modules enabled.
   * Build-time fallback only — the brain's /config/modules row wins.
   */
  ENABLED_MODULES?: string[] | string;
}

interface Window {
  __CALLA_CONFIG__?: CallaRuntimeConfig;
}
