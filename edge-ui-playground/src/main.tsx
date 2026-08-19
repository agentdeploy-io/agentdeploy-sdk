/**
 * Edge Console — Application Entry Point
 * ───────────────────────────────────────
 * Wires together the router, layout, views, and providers.
 *
 * Architecture (12factor.net):
 *   - Config in constants/ (not hardcoded)
 *   - Errors centralized via errorHandler
 *   - All state managed via hooks (no prop drilling)
 *   - Views are pure renderers of route + hooks
 *
 * Boot sequence:
 *   1. Apply CSS variables to :root
 *   2. Register toast pusher (for imperative toast API)
 *   3. Render <ToastProvider><App /></ToastProvider>
 */

import React from "react";
import { createRoot } from "react-dom/client";

// ─── Global Styles ───────────────────────────────────────────────
import "./styles/globals.css";

// ─── Constants (inject CSS vars) ─────────────────────────────────
import { CSS_VARS } from "./constants/theme";

// Apply design tokens to :root
const root = document.documentElement;
Object.entries(CSS_VARS).forEach(([key, value]) => {
  root.style.setProperty(key, value);
});

// ─── Providers ───────────────────────────────────────────────────
import { ToastProvider, registerToastPusher, useToast } from "./hooks/useToast";
import { AuthProvider } from "./hooks/useAuth";

// ─── Router ──────────────────────────────────────────────────────
import { useRouter, buildAgentRoute } from "./hooks/useRouter";

// ─── Layout ──────────────────────────────────────────────────────
import { ConsoleLayout } from "./components/layout";

// ─── Views ───────────────────────────────────────────────────────
import {
  OverviewView,
  AgentsView,
  AgentDetailView,
  ConversationsView,
  WorkersView,
  ConfigView,
  ObservabilityView,
  SettingsView,
  NotFoundView,
} from "./views";

// ─── Shared Components (auth guard + error boundary) ─────────────
import { ErrorBoundary, AuthGuard } from "./components/shared";

// ─── App Component ───────────────────────────────────────────────

/**
 * Inner App component that uses the router hook.
 * Must be inside <ToastProvider> to access toast functionality.
 */
const App: React.FC = () => {
  const { route, navigate } = useRouter();
  const { push } = useToast();

  // Register imperative toast pusher for non-component usage
  React.useEffect(() => {
    registerToastPusher(push);
  }, [push]);

  // ─── Navigation Handlers ──────────────────────────────────────

  const handleNavigate = React.useCallback(
    (path: string) => {
      navigate(path);
    },
    [navigate],
  );

  const handleNavigateAgent = React.useCallback(
    (agentId: string) => {
      navigate(buildAgentRoute(agentId, "chat"));
    },
    [navigate],
  );

  const handleNavigateTab = React.useCallback(
    (tabId: string) => {
      if (route.agentId) {
        navigate(buildAgentRoute(route.agentId, tabId));
      }
    },
    [navigate, route.agentId],
  );

  const handleNavigateBack = React.useCallback(() => {
    navigate("/agents");
  }, [navigate]);

  // ─── Render Current View ──────────────────────────────────────

  const renderView = (): React.ReactNode => {
    switch (route.view) {
      case "overview":
        return (
          <OverviewView
            onNavigateAgents={() => navigate("/agents")}
            onNavigateAgent={handleNavigateAgent}
          />
        );

      case "agents":
        return <AgentsView onNavigateAgent={handleNavigateAgent} />;

      case "agent-detail":
        return (
          <AgentDetailView
            agentId={route.agentId!}
            tab={route.tab ?? "chat"}
            onNavigateTab={handleNavigateTab}
            onNavigateBack={handleNavigateBack}
          />
        );

      case "conversations":
        return <ConversationsView onNavigateAgent={handleNavigateAgent} />;

      case "workers":
        return <WorkersView />;

      case "config":
        return <ConfigView />;

      case "observability":
        return <ObservabilityView />;

      case "settings":
        return <SettingsView />;

      case "not-found":
        return (
          <NotFoundView
            attemptedPath={window.location.pathname}
            onNavigateHome={() => navigate("/")}
            onNavigateAgents={() => navigate("/agents")}
          />
        );

      default:
        // This should never happen, but just in case
        return (
          <NotFoundView
            attemptedPath={window.location.pathname}
            onNavigateHome={() => navigate("/")}
            onNavigateAgents={() => navigate("/agents")}
          />
        );
    }
  };

  // ─── Render ────────────────────────────────────────────────────

  return (
    <ErrorBoundary
      resetKeys={[route.view]}
      fallback={({ reset }) => (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            minHeight: "100vh",
            gap: "16px",
            padding: "48px",
            textAlign: "center",
            fontFamily: "system-ui, -apple-system, sans-serif",
          }}
        >
          <div style={{ fontSize: "3rem" }}>⚠️</div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 600 }}>
            The application encountered a fatal error
          </h1>
          <p style={{ color: "#6b7280", maxWidth: "400px", fontSize: "0.875rem" }}>
            The layout shell failed to render. This is likely a bug. Try reloading the page.
          </p>
          <div style={{ display: "flex", gap: "8px" }}>
            <button
              onClick={reset}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "1px solid #d1d5db",
                backgroundColor: "#fff",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Try Again
            </button>
            <button
              onClick={() => window.location.reload()}
              style={{
                padding: "8px 16px",
                borderRadius: "6px",
                border: "none",
                backgroundColor: "#18181B",
                color: "#fff",
                cursor: "pointer",
                fontSize: "0.875rem",
              }}
            >
              Reload Page
            </button>
          </div>
        </div>
      )}
    >
      <ConsoleLayout route={route} onNavigate={handleNavigate}>
        <ErrorBoundary resetKeys={[route.view, route.agentId, route.tab]}>
          {renderView()}
        </ErrorBoundary>
      </ConsoleLayout>
    </ErrorBoundary>
  );
};

// ─── Root Render ─────────────────────────────────────────────────

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found in document");
}

createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <ToastProvider>
        <AuthGuard>
          <App />
        </AuthGuard>
      </ToastProvider>
    </AuthProvider>
  </React.StrictMode>,
);
