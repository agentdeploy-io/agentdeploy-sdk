/**
 * Central Runtime Configuration
 * ──────────────────────────────
 * Single accessor for the Calla UI runtime config.
 *
 * Resolution order (first defined value wins per key):
 *   1. window.__CALLA_CONFIG__        (public/runtime-config.js — preferred)
 *   2. window.__EDGE_CONSOLE_CONFIG__ (legacy Edge Console config — back-compat)
 *   3. import.meta.env.VITE_*         (build-time fallback for local dev)
 *   4. Hardcoded defaults             (same-origin / marketplace production)
 *
 * 12factor.net: URLs are config, never hardcoded in views.
 */

import { hexToHslTriplet } from "@/lib/utils";

// window.__CALLA_CONFIG__ is declared globally in src/vite-env.d.ts.
// Here we only add the legacy back-compat global.
declare global {
  interface Window {
    /** Legacy Edge Console runtime config (back-compat). */
    __EDGE_CONSOLE_CONFIG__?: {
      MARKETPLACE_URL?: string;
      DEPLOYMENT_API_URL?: string;
      BRAIN_URL?: string;
      AUTH_MODE?: string;
    };
  }
}

/** Fully-resolved config (every key has a concrete value). */
export interface ResolvedCallaConfig {
  /** Marketplace where users log in / purchase templates. */
  MARKETPLACE_URL: string;
  /** Deployment-service (platform) API base. "" = same-origin proxy. */
  DEPLOYMENT_API_URL: string;
  /** Mastra brain base URL. "" or "none" disables brain features. */
  BRAIN_URL: string;
  /** Whitelabel console name (sidebar, login, document.title). */
  BRAND_NAME: string;
  /** Whitelabel tagline shown under the brand name. */
  BRAND_TAGLINE: string;
  /** Optional brand accent as a hex color — overrides --primary at boot. */
  BRAND_ACCENT: string;
  /**
   * Per-deployment enabled modules (module ids, see @calla/shared
   * CALLA_MODULES). Empty/absent = all modules enabled (dev default).
   * This is the BUILD-TIME fallback; the brain's /config/modules row wins
   * when reachable (see lib/modules.ts).
   */
  ENABLED_MODULES: string[];
}

const DEFAULTS: ResolvedCallaConfig = {
  MARKETPLACE_URL: "https://agentdeploy.io",
  DEPLOYMENT_API_URL: "",
  BRAIN_URL: "/brain",
  BRAND_NAME: "Calla",
  BRAND_TAGLINE: "HITL Orchestration",
  BRAND_ACCENT: "",
  ENABLED_MODULES: [],
};

/** Accept an array or a comma-separated string (runtime-config flexibility). */
function pickModules(value: string[] | string | undefined): string[] {
  if (Array.isArray(value)) return value.map((v) => v.trim()).filter(Boolean);
  if (typeof value === "string") return value.split(",").map((v) => v.trim()).filter(Boolean);
  return [];
}

function pick(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    if (typeof v === "string" && v.length > 0) return v;
  }
  return undefined;
}

/**
 * Merge runtime config sources into a fully-resolved config object.
 * Safe to call during SSR/tests (window may be undefined).
 */
export function getCallaConfig(): ResolvedCallaConfig {
  const hasWindow = typeof window !== "undefined";
  const calla = hasWindow ? window.__CALLA_CONFIG__ : undefined;
  const legacy = hasWindow ? window.__EDGE_CONSOLE_CONFIG__ : undefined;
  const env = import.meta.env;

  return {
    MARKETPLACE_URL:
      pick(
        calla?.MARKETPLACE_URL,
        legacy?.MARKETPLACE_URL,
        env.VITE_MARKETPLACE_URL as string | undefined,
      ) ?? DEFAULTS.MARKETPLACE_URL,
    DEPLOYMENT_API_URL:
      pick(
        calla?.DEPLOYMENT_API_URL,
        legacy?.DEPLOYMENT_API_URL,
        env.VITE_DEPLOYMENT_API_URL as string | undefined,
      ) ?? DEFAULTS.DEPLOYMENT_API_URL,
    BRAIN_URL:
      pick(
        calla?.BRAIN_URL,
        legacy?.BRAIN_URL,
        env.VITE_BRAIN_URL as string | undefined,
      ) ?? DEFAULTS.BRAIN_URL,
    BRAND_NAME:
      pick(
        calla?.BRAND_NAME,
        env.VITE_BRAND_NAME as string | undefined,
      ) ?? DEFAULTS.BRAND_NAME,
    BRAND_TAGLINE:
      pick(
        calla?.BRAND_TAGLINE,
        env.VITE_BRAND_TAGLINE as string | undefined,
      ) ?? DEFAULTS.BRAND_TAGLINE,
    BRAND_ACCENT:
      pick(
        calla?.BRAND_ACCENT,
        env.VITE_BRAND_ACCENT as string | undefined,
      ) ?? DEFAULTS.BRAND_ACCENT,
    ENABLED_MODULES:
      pickModules(
        calla?.ENABLED_MODULES ??
          (env.VITE_ENABLED_MODULES as string | undefined),
      ),
  };
}

// ─── Getters ─────────────────────────────────────────────────────
// Functions (not module-level consts) so late-injected runtime config
// and tests that mutate window.__CALLA_CONFIG__ are always respected.

/** The marketplace URL (login, token exchange, template purchase). */
export function getMarketplaceUrl(): string {
  return getCallaConfig().MARKETPLACE_URL;
}

/** The deployment-service API base ("" = same-origin). */
export function getDeploymentApiUrl(): string {
  return getCallaConfig().DEPLOYMENT_API_URL;
}

/** The Mastra brain base URL ("" or "none" = brain disabled). */
export function getBrainUrl(): string {
  return getCallaConfig().BRAIN_URL;
}

// ─── Whitelabel ──────────────────────────────────────────────────

/** The branded console name ("Calla" unless whitelabeled). */
export function getBrandName(): string {
  return getCallaConfig().BRAND_NAME;
}

/** The branded tagline shown under the console name. */
export function getBrandTagline(): string {
  return getCallaConfig().BRAND_TAGLINE;
}

/**
 * Build-time enabled modules from runtime-config (empty = all enabled).
 * The runtime brain value wins — see lib/modules.ts useModuleConfig().
 */
export function getConfigEnabledModules(): string[] {
  return getCallaConfig().ENABLED_MODULES;
}

/**
 * Apply the brand accent (BRAND_ACCENT hex) to the document root by
 * overriding the --primary / --ring design tokens. Called once at boot;
 * an invalid or missing hex is a silent no-op — the stock theme stays.
 */
export function applyBrandAccent(): void {
  if (typeof document === "undefined") return;
  const accent = getCallaConfig().BRAND_ACCENT.trim();
  if (!accent) return;
  const triplet = hexToHslTriplet(accent);
  if (!triplet) return;
  const root = document.documentElement;
  root.style.setProperty("--primary", triplet);
  root.style.setProperty("--ring", triplet);
}

// ─── Auth mode ───────────────────────────────────────────────────

/**
 * The four-way auth strategy the UI resolves at runtime:
 *   - "disabled"    → localhost / LAN dev (synthetic local user, no network auth)
 *   - "standalone"  → self-hosted: the brain issues its own JWTs, the UI shows
 *                     a real Login page (no agentdeploy.io dependency)
 *   - "marketplace" → agentdeploy.io subdomain cookie OR custom-domain token
 *                     exchange (the existing hosted flows)
 */
export type AuthMode = "disabled" | "standalone" | "marketplace";

function isLocalhostHostname(): boolean {
  const hostname = typeof window !== "undefined" ? window.location.hostname : "";
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "0.0.0.0" ||
    hostname.startsWith("192.168.") ||
    hostname.startsWith("10.")
  );
}

/**
 * Resolve the active auth mode.
 *
 * Precedence:
 *   1. Explicit `window.__CALLA_CONFIG__.AUTH_MODE` / `VITE_AUTH_MODE`
 *      ("disabled" | "standalone" | "marketplace") — always wins.
 *   2. `VITE_AUTH_DISABLED=true` → "disabled"; `=false` forces auth on.
 *   3. localhost / LAN → "disabled".
 *   4. MARKETPLACE_URL empty / "none" / "self" → "standalone".
 *   5. otherwise → "marketplace".
 */
export function getAuthMode(): AuthMode {
  const hasWindow = typeof window !== "undefined";
  const calla = hasWindow ? window.__CALLA_CONFIG__ : undefined;
  const legacy = hasWindow ? window.__EDGE_CONSOLE_CONFIG__ : undefined;
  const env = import.meta.env;

  const explicit = String(
    calla?.AUTH_MODE ?? legacy?.AUTH_MODE ?? env.VITE_AUTH_MODE ?? "",
  )
    .trim()
    .toLowerCase();
  if (explicit === "disabled" || explicit === "standalone" || explicit === "marketplace") {
    return explicit;
  }

  const authDisabledEnv = String(env.VITE_AUTH_DISABLED ?? "").trim().toLowerCase();
  if (authDisabledEnv === "true") return "disabled";
  if (authDisabledEnv !== "false" && isLocalhostHostname()) return "disabled";

  const marketplace = String(getCallaConfig().MARKETPLACE_URL ?? "")
    .trim()
    .toLowerCase();
  if (!marketplace || marketplace === "none" || marketplace === "self") return "standalone";
  return "marketplace";
}

/** Snapshot of the resolved config at first access. */
export const callaConfig: ResolvedCallaConfig = getCallaConfig();
