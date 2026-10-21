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
 *     → UI stores the edge JWT in localStorage (calla_jwt)
 */

import React from "react";
import { Lock } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import {
  AUTH_DISABLED,
  isCustomDomain,
  buildLoginUrl,
  buildTokenExchangeUrl,
} from "@/constants/auth";
import { Button } from "@/components/ui";
import { Card, CardContent } from "@/components/ui";
import { Login } from "@/pages/Login";

// ─── Component ───────────────────────────────────────────────────

export const AuthGuard: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, isLoading, authDisabled, error, authMode } = useAuth();

  // Local dev mode — no auth required
  if (authDisabled || AUTH_DISABLED) {
    return <>{children}</>;
  }

  // Initial auth check in progress
  if (isLoading) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4 bg-background">
        <div
          className="size-8 animate-spin rounded-full border-[3px] border-border border-t-primary"
          role="status"
          aria-label="Verifying session"
        />
        <p className="text-sm text-muted-foreground">Verifying your session…</p>
      </div>
    );
  }

  // Authenticated — render protected content
  if (isAuthenticated) {
    return <>{children}</>;
  }

  // Self-hosted (standalone) mode — show the real email + password Login page.
  if (authMode === "standalone") {
    return <Login />;
  }

  // Marketplace modes — show the redirect-based login gate.
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
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-[400px] text-center shadow-elevated">
        <CardContent className="px-8 py-10">
          {/* Icon */}
          <div className="mx-auto mb-5 flex size-14 items-center justify-center rounded-lg bg-primary">
            <Lock className="size-7 text-primary-foreground" />
          </div>

          <h1 className="mb-2 text-xl font-bold text-foreground">
            Authentication Required
          </h1>

          <p className="mb-6 text-sm leading-relaxed text-muted-foreground">
            This Calla console is protected. Sign in to access your agents, view
            metrics, and manage deployments.
          </p>

          {error && (
            <div className="mb-5 rounded-md bg-destructive px-3.5 py-2.5 text-[0.8125rem] text-destructive-foreground">
              {error}
            </div>
          )}

          <Button onClick={handleLogin} className="w-full">
            Sign in
          </Button>

          <p className="mt-4 text-xs leading-relaxed text-muted-foreground">
            You'll be redirected to a secure login page. After signing in, you'll
            be brought back here automatically.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};
