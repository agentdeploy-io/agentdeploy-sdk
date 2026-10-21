/**
 * Login — self-hosted (standalone) auth screen
 * ─────────────────────────────────────────────
 * Shown by <AuthGuard> when AUTH_MODE === "standalone" and the user is not
 * authenticated. Talks directly to the brain's /auth/* endpoints:
 *
 *   - GET  /auth/status   → { initialized } picks the sign-in vs. create-admin
 *   - POST /auth/login     → email + password
 *   - POST /auth/register  → one-shot admin bootstrap (only while uninitialized)
 *
 * On success the brain JWT is persisted by useAuth (localStorage `calla_jwt`),
 * auth state flips to authenticated, and <AuthGuard> re-renders the app.
 * No redirects — this is a real in-app login form.
 */

import * as React from "react";
import { Flower2, Loader2, Lock, LogIn, Mail, UserPlus } from "lucide-react";
import { Button, Card, CardContent, Input } from "@/components/ui";
import { useAuth } from "@/hooks/useAuth";
import { getBrainUrl, getCallaConfig } from "@/config";

export const Login: React.FC = () => {
  const { login, register } = useAuth();

  const base = React.useMemo(() => getBrainUrl().replace(/\/+$/, ""), []);
  const brand = React.useMemo(() => getCallaConfig(), []);

  const [email, setEmail] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [submitting, setSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  // null = still probing; true = users exist (sign in); false = create admin.
  const [initialized, setInitialized] = React.useState<boolean | null>(null);

  // Probe /auth/status once to decide sign-in vs. create-admin. Defaults to
  // sign-in if the brain is unreachable (safer than offering registration).
  const probeStatus = React.useCallback(async () => {
    try {
      const res = await fetch(`${base}/auth/status`, {
        headers: { Accept: "application/json" },
      });
      if (!res.ok) throw new Error("bad status");
      const data = (await res.json()) as { initialized?: boolean };
      setInitialized(Boolean(data.initialized));
    } catch {
      setInitialized(true);
    }
  }, [base]);

  React.useEffect(() => {
    void probeStatus();
  }, [probeStatus]);

  const registerMode = initialized === false;

  const handleSubmit = React.useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (submitting) return;
      setError(null);

      const trimmedEmail = email.trim();
      if (!trimmedEmail || !password) {
        setError("Please enter your email and password.");
        return;
      }
      if (registerMode && password.length < 10) {
        setError("Choose a password of at least 10 characters.");
        return;
      }

      setSubmitting(true);
      try {
        const result = registerMode
          ? await register(trimmedEmail, password)
          : await login(trimmedEmail, password);

        if (result.ok) return; // AuthGuard re-renders the app on success.

        setError(result.error ?? "Authentication failed. Please try again.");
        // If registration lost a race (instance already set up), flip to sign-in.
        if (registerMode) await probeStatus();
      } finally {
        setSubmitting(false);
      }
    },
    [submitting, email, password, registerMode, login, register, probeStatus],
  );

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-6">
      <Card className="w-full max-w-[400px] shadow-elevated">
        <CardContent className="px-8 py-10">
          {/* Brand */}
          <div className="mb-6 flex flex-col items-center text-center">
            <span className="mb-4 flex size-12 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-control">
              <Flower2 className="size-6" />
            </span>
            <h1 className="text-xl font-bold tracking-tight text-foreground">
              {registerMode ? "Create your admin account" : `Sign in to ${brand.BRAND_NAME}`}
            </h1>
            <p className="mt-1.5 text-sm leading-relaxed text-muted-foreground">
              {registerMode
                ? `Set up the administrator account for your self-hosted ${brand.BRAND_NAME} instance.`
                : `Welcome back. Sign in to your self-hosted ${brand.BRAND_NAME} console.`}
            </p>
          </div>

          {error && (
            <div
              role="alert"
              className="mb-5 rounded-md bg-destructive px-3.5 py-2.5 text-[0.8125rem] text-destructive-foreground"
            >
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4" noValidate>
            <div className="space-y-1.5">
              <label
                htmlFor="calla-email"
                className="text-xs font-medium text-muted-foreground"
              >
                Email
              </label>
              <Input
                id="calla-email"
                type="email"
                autoComplete="username"
                autoFocus
                placeholder="you@example.com"
                leftIcon={<Mail />}
                value={email}
                disabled={submitting}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="calla-password"
                className="text-xs font-medium text-muted-foreground"
              >
                Password
              </label>
              <Input
                id="calla-password"
                type="password"
                autoComplete={registerMode ? "new-password" : "current-password"}
                placeholder={registerMode ? "At least 10 characters" : "Your password"}
                leftIcon={<Lock />}
                value={password}
                disabled={submitting}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>

            <Button type="submit" className="w-full" disabled={submitting}>
              {submitting ? (
                <Loader2 className="size-4 animate-spin" />
              ) : registerMode ? (
                <UserPlus className="size-4" />
              ) : (
                <LogIn className="size-4" />
              )}
              {submitting
                ? "Please wait…"
                : registerMode
                  ? "Create admin account"
                  : "Sign in"}
            </Button>
          </form>

          <p className="mt-6 text-center text-xs leading-relaxed text-muted-foreground">
            Self-hosted mode — credentials are verified by your own {brand.BRAND_NAME} brain.
            No agentdeploy.io account required.
          </p>
        </CardContent>
      </Card>
    </div>
  );
};

Login.displayName = "Login";
