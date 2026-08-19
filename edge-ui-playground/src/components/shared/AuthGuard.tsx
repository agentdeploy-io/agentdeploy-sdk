/**
 * AuthGuard Component
 * ────────────────────
 * Wraps protected content. If the user is not authenticated, shows
 * a login screen that redirects to the correct auth flow based on
 * the deployment context.
 *
 * States:
 *   - isLoading: Show a centered spinner.
 *   - authDisabled: Render children directly (local dev mode).
 *   - isAuthenticated: Render children.
 *   - !isAuthenticated: Show login gate with "Sign in" button.
 *
 * Auth redirect paths:
 *   Subdomain (*.agentdeploy.io):
 *     → Redirects to marketplace login at agentdeploy.io/login
 *     → Better Auth session cookie is set on *.agentdeploy.io
 *
 *   Custom Domain (agents.acme.com):
 *     → Redirects to marketplace token exchange at
 *       agentdeploy.io/api/edge/authorize?return_url=...
 *     → Marketplace validates Better Auth session
 *     → Redirects back with ?edge_token=xxx
 *     → Console stores the edge JWT in localStorage
 */

import React from "react";
import { useAuth } from "../../hooks/useAuth";
import {
  AUTH_DISABLED,
  isCustomDomain,
  buildLoginUrl,
  buildTokenExchangeUrl,
} from "../../constants/auth";
import { COLORS, RADIUS } from "../../constants/theme";

// ─── Component ───────────────────────────────────────────────────

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, authDisabled, error } = useAuth();

  // Local dev mode — no auth required
  if (authDisabled || AUTH_DISABLED) {
    return <>{children}</>;
  }

  // Initial auth check in progress
  if (isLoading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          backgroundColor: COLORS.background,
          flexDirection: "column",
          gap: "16px",
        }}
      >
        <div
          style={{
            width: "32px",
            height: "32px",
            border: `3px solid ${COLORS.border}`,
            borderTopColor: COLORS.primary,
            borderRadius: "50%",
            animation: "spin 800ms linear infinite",
          }}
        />
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          Verifying your session…
        </p>
        <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      </div>
    );
  }

  // Authenticated — render protected content
  if (isAuthenticated) {
    return <>{children}</>;
  }

  // Not authenticated — show login gate
  return <LoginGate error={error} />;
};

// ─── Login Gate ──────────────────────────────────────────────────

const LoginGate: React.FC<{ error: string | null }> = ({ error }) => {
  const handleLogin = React.useCallback(() => {
    const returnUrl = window.location.href;

    if (isCustomDomain()) {
      // Custom domain: redirect to token exchange endpoint.
      // Marketplace validates the Better Auth session, then redirects
      // back with ?edge_token=xxx
      window.location.href = buildTokenExchangeUrl(returnUrl);
    } else {
      // Subdomain: redirect to marketplace login.
      // After login, Better Auth sets the session cookie on *.agentdeploy.io
      // and redirects back here.
      window.location.href = buildLoginUrl(returnUrl);
    }
  }, []);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "100vh",
        backgroundColor: COLORS.background,
        padding: "24px",
      }}
    >
      <div
        style={{
          maxWidth: "400px",
          width: "100%",
          backgroundColor: COLORS.card,
          border: `1px solid ${COLORS.border}`,
          borderRadius: RADIUS.lg,
          padding: "40px 32px",
          textAlign: "center",
          boxShadow: "0 4px 24px rgba(0, 0, 0, 0.08)",
        }}
      >
        {/* Icon */}
        <div
          style={{
            width: "56px",
            height: "56px",
            margin: "0 auto 20px",
            borderRadius: RADIUS.lg,
            backgroundColor: COLORS.primary,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "1.5rem",
          }}
        >
          <svg
            width="28"
            height="28"
            viewBox="0 0 24 24"
            fill="none"
            stroke={COLORS.primaryForeground}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
            <path d="M7 11V7a5 5 0 0 1 10 0v4" />
          </svg>
        </div>

        <h1
          style={{
            fontSize: "1.25rem",
            fontWeight: 700,
            color: COLORS.foreground,
            marginBottom: "8px",
          }}
        >
          Authentication Required
        </h1>

        <p
          style={{
            fontSize: "0.875rem",
            color: COLORS.mutedForeground,
            lineHeight: 1.5,
            marginBottom: "24px",
          }}
        >
          This Edge Console is protected. Sign in to access your agents, view metrics, and
          manage deployments.
        </p>

        {error && (
          <div
            style={{
              padding: "10px 14px",
              backgroundColor: COLORS.destructive,
              borderRadius: RADIUS.md,
              marginBottom: "20px",
              fontSize: "0.8125rem",
              color: COLORS.destructiveForeground,
            }}
          >
            {error}
          </div>
        )}

        <button
          onClick={handleLogin}
          style={{
            width: "100%",
            padding: "11px 20px",
            fontSize: "0.875rem",
            fontWeight: 600,
            backgroundColor: COLORS.primary,
            color: COLORS.primaryForeground,
            border: "none",
            borderRadius: RADIUS.md,
            cursor: "pointer",
            transition: "opacity 150ms ease",
          }}
          onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.9")}
          onMouseLeave={(e) => (e.currentTarget.style.opacity = "1")}
        >
          Sign in
        </button>

        <p
          style={{
            fontSize: "0.75rem",
            color: COLORS.mutedForeground,
            marginTop: "16px",
            lineHeight: 1.5,
          }}
        >
          You'll be redirected to a secure login page. After signing in, you'll be brought
          back here automatically.
        </p>
      </div>
    </div>
  );
};
