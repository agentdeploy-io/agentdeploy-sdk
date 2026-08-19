// ── Secret Access ───────────────────────────────────────────────────────────
// Provides typed access to secrets injected by the AgentDeploy platform.

/**
 * Detects if we're running in a local development environment (wrangler dev).
 * In local dev, AD_DEPLOYMENT_ID is either undefined or set to a stub value.
 */
function isLocalDev(): boolean {
  try {
    const deploymentId = (globalThis as Record<string, unknown>).AD_DEPLOYMENT_ID;
    return !deploymentId || deploymentId === "local-dev" || deploymentId === "";
  } catch {
    return false;
  }
}

/**
 * Access secrets bound to this deployment via the AgentDeploy platform.
 *
 * Secrets are injected through Cloudflare Workers Secrets API and appear
 * as properties on the `env` object. This helper provides a typed proxy
 * that throws descriptive errors when a secret is missing.
 *
 * In local development (wrangler dev), missing secrets produce a console
 * warning instead of throwing, so developers can iterate without setting
 * up all secrets in `.dev.vars` first.
 *
 * @example
 * ```ts
 * export const MyAgent = createAgent({
 *   name: "my-agent",
 *   async onStart() {
 *     const secrets = useSecrets<{ STRIPE_KEY: string; SLACK_URL?: string }>(this.env);
 *     const stripe = Stripe(secrets.STRIPE_KEY);
 *   },
 * });
 * ```
 *
 * @param env - The environment bindings object (this.env in agent methods)
 */
export function useSecrets<T extends Record<string, string>>(
  env: Record<string, unknown>,
): T {
  const localDev = isLocalDev();

  return new Proxy({} as T, {
    get(_target, key: string) {
      const val = env[key];
      if (val === undefined || val === null) {
        const msg = `Secret "${key}" is not configured. Set it in the AgentDeploy dashboard under Deployment > Secrets, or add it to .dev.vars for local development.`;
        if (localDev) {
          console.warn(`[AgentDeploy] ${msg}`);
          return undefined as unknown as string;
        }
        throw new Error(msg);
      }
      return val as string;
    },
    has(_target, key: string) {
      return key in env;
    },
    ownKeys() {
      return Object.keys(env).filter(
        (k) => typeof env[k] === "string",
      );
    },
    getOwnPropertyDescriptor(_target, key: string) {
      if (key in env && typeof env[key] === "string") {
        return {
          enumerable: true,
          configurable: true,
          writable: false,
          value: env[key],
        };
      }
      return undefined;
    },
  });
}

/**
 * Check if a secret is configured without throwing.
 */
export function hasSecret(env: Record<string, unknown>, key: string): boolean {
  const val = env[key];
  return val !== undefined && val !== null && val !== "";
}

/**
 * Get a secret value with a fallback.
 */
export function getSecret(
  env: Record<string, unknown>,
  key: string,
  fallback: string = "",
): string {
  const val = env[key];
  if (val === undefined || val === null || val === "") {
    return fallback;
  }
  return val as string;
}
