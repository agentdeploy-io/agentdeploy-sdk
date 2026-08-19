/**
 * Auth Types
 * ──────────
 * Type definitions for the marketplace auth layer.
 * Aligns with Better Auth user structure and hosting subscription tiers.
 */

import type { HostingTier } from "../constants/auth";

/**
 * The authenticated user, from Better Auth.
 * This maps to the betterauth_users collection in Directus.
 */
export interface AuthUser {
  /** User ID (UUID) from betterauth_users */
  id: string;
  /** Email address */
  email: string;
  /** Display name (name field from Better Auth) */
  name: string;
  /** Avatar URL (from OAuth provider or uploaded) */
  image?: string | null;
  /** Whether email is verified */
  emailVerified: boolean;
  /** User role: buyer, seller, agent, operator */
  role: "buyer" | "seller" | "agent" | "operator" | null;
  /** Account status */
  status: "active" | "suspended" | "inactive" | null;
  /** First name (hydrated after OAuth) */
  firstName?: string | null;
  /** Last name (hydrated after OAuth) */
  lastName?: string | null;
}

/**
 * The buyer's hosting subscription details.
 * Maps to HostingSubscriptionsRecord in the database.
 */
export interface HostingSubscription {
  id: string;
  tier: HostingTier;
  status: "active" | "trialing" | "past_due" | "incomplete" | "canceled" | "unpaid" | "paused";
  billingCycle: "monthly" | "annual";
  agentLimit: number;
  agentsDeployed: number;
  tokenAllowance: number;
  tokenUsed: number;
  customDomain: string | null;
  currentPeriodEnd: string | null;
}

/**
 * A purchased agent template that the buyer has access to.
 * This is dynamically loaded from the deployment-service API —
 * not hardcoded in the AGENTS constant.
 */
export interface PurchasedTemplate {
  /** Deployment ID */
  id: string;
  /** Template name (from the marketplace listing) */
  name: string;
  /** Template description */
  description: string;
  /** Emoji or icon */
  icon: string;
  /** Agent kind */
  kind: "chat" | "cron" | "api" | "worker";
  /** WebSocket path for this agent */
  wsPath: string;
  /** Whether chat is supported */
  supportsChat: boolean;
  /** Whether the agent has cron schedules */
  hasCron: boolean;
  /** Capabilities list */
  capabilities: string[];
  /** Seller name */
  sellerName?: string;
  /** Template ID from marketplace */
  templateId?: string;
  /** Deployment status */
  deploymentStatus?: "active" | "suspended" | "pending" | "failed";
  /** Custom domain for this specific deployment (if Pro/Business) */
  customDomain?: string | null;
}

/**
 * Complete auth state as exposed by the useAuth hook.
 */
export interface AuthState {
  /** Whether the user is currently authenticated */
  isAuthenticated: boolean;
  /** Whether auth is disabled entirely (local dev mode) */
  authDisabled: boolean;
  /** Whether the auth check is in progress (initial load) */
  isLoading: boolean;
  /** The authenticated user, or null */
  user: AuthUser | null;
  /** The auth token (Better Auth session token or edge JWT for custom domains) */
  token: string | null;
  /** Auth error message, or null */
  error: string | null;
  /** Whether we're on a custom domain (vs agentdeploy.io subdomain) */
  isCustomDomain: boolean;
}

/**
 * Shape of the edge JWT payload issued by the token exchange endpoint.
 * This is the JWT used for custom-domain auth bridging.
 */
export interface EdgeJwtPayload {
  /** Subject — user ID */
  sub: string;
  /** User email */
  email: string;
  /** User name */
  name: string;
  /** User role */
  role: string;
  /** Issuer — always the marketplace URL */
  iss: string;
  /** Audience — the custom domain */
  aud: string;
  /** Expiry (seconds since epoch) */
  exp: number;
  /** Issued at (seconds since epoch) */
  iat: number;
  /** Subscription tier */
  tier?: HostingTier;
  /** Deployment IDs this token grants access to */
  dep?: string[];
}
