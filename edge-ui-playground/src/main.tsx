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
import { AgentRegistryProvider } from "./hooks/useAgentRegistry";
import { DeploymentSelectorProvider } from "./hooks/useDeploymentSelector";

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
  CoreView,
  CoreDetailView,
  ConfigView,
  ObservabilityView,
  DataStudioView,
  PipelineView,
  HITLView,
  ScheduleManagerView,
  AgentWireView,
  SecretsConfigView,
  SettingsView,
  NotFoundView,
} from "./views";

// ─── Showcase ────────────────────────────────────────────────────
import { ShowcaseOverlay, useShowcase, isTourMode } from "./showcase";
import { DemoBadge } from "./showcase/DemoBadge";

// ─── Shared Components (auth guard + error boundary) ─────────────
import { ErrorBoundary, AuthGuard } from "./components/shared";

// ─── Global Components ──────────────────────────────────────────
import { PausedBanner } from "./components/PausedBanner";
import { useSettingsState } from "./hooks/useSettings";

// ─── App Component ───────────────────────────────────────────────

/**
 * Inner App component that uses the router hook.
 * Must be inside <ToastProvider> to access toast functionality.
 */
const App: React.FC = () => {
  const { route, navigate } = useRouter();
  const { push } = useToast();
  const { paused, setPaused } = useSettingsState();
  const { tourActive, stepIndex, totalSteps, onNext, onPrev, onSkip } = useShowcase();

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

  const handleNavigateCoreTab = React.useCallback(
    (tabId: string) => {
      if (route.subId) {
        navigate(`/core/${route.subId}/${tabId}`);
      }
    },
    [navigate, route.subId],
  );

  const handleNavigateCoreBack = React.useCallback(() => {
    navigate("/core");
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

      case "core":
        return <CoreView onNavigate={handleNavigate} />;

      case "core-detail":
        return (
          <CoreDetailView
            deploymentId={route.subId!}
            tab={route.tab ?? "controls"}
            onNavigateTab={handleNavigateCoreTab}
            onNavigateBack={handleNavigateCoreBack}
          />
        );

      case "config":
        return <ConfigView />;

      case "observability":
        return <ObservabilityView />;

      case "data-studio":
        return <DataStudioView />;

      case "pipeline":
        return <PipelineView />;

      case "hitl":
        return <HITLView />;

      case "agent-wire":
        return <AgentWireView />;

      case "schedule-manager":
        return <ScheduleManagerView />;

      case "settings":
        return <SettingsView />;

      case "secrets-config":
        return <SecretsConfigView />;

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
      {paused && <PausedBanner onResume={() => setPaused(false)} />}
      <ConsoleLayout
        route={route}
        onNavigate={handleNavigate}
        topBarActions={
          (tourActive || isTourMode()) ? (
            <DemoBadge onExit={onSkip} />
          ) : undefined
        }
      >
        <ErrorBoundary resetKeys={[route.view, route.agentId, route.tab]}>
          {renderView()}
        </ErrorBoundary>
      </ConsoleLayout>
      {tourActive && (
        <ShowcaseOverlay
          stepIndex={stepIndex}
          totalSteps={totalSteps}
          onNext={onNext}
          onPrev={onPrev}
          onSkip={onSkip}
        />
      )}
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
        <AgentRegistryProvider>
          <DeploymentSelectorProvider>
            <AuthGuard>
              <App />
            </AuthGuard>
          </DeploymentSelectorProvider>
        </AgentRegistryProvider>
      </ToastProvider>
    </AuthProvider>
  </React.StrictMode>,
);
