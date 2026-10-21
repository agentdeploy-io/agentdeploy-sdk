/**
 * Calla UI entry
 * ──────────────
 * Provider stack (outermost → innermost):
 *   StrictMode
 *     QueryClientProvider      — react-query cache (staleTime 5s)
 *       AuthProvider           — marketplace session / edge JWT / local dev
 *         ToastProvider        — toast context + imperative `toast` helper
 *           AgentRegistryProvider      — live agent list (deployments API)
 *             DeploymentSelectorProvider — active /d/{id} deployment
 *               ErrorBoundary  — last-resort render crash net
 *                 AuthGuard    — login gate (no-op when auth disabled)
 *                   App        — router + console shell
 *
 * <ToastContainer /> mounts inside ToastProvider (it consumes the context);
 * the shell's own /events socket and approval aggregator live in
 * ConsoleLayout so every screen shares one instance.
 */

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { App } from "@/App";
import { AuthGuard, ErrorBoundary, ToastContainer } from "@/components/shared";
import { applyBrandAccent } from "@/config";
import {
  AgentRegistryProvider,
  AuthProvider,
  DeploymentSelectorProvider,
  ToastProvider,
} from "@/hooks";
import "./index.css";

// Whitelabel accent — no-op unless BRAND_ACCENT is a valid hex color.
applyBrandAccent();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 5_000,
    },
  },
});

const container = document.getElementById("root");
if (!container) {
  throw new Error("Calla UI: #root mount node is missing");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <ToastProvider>
          <ToastContainer />
          <AgentRegistryProvider>
            <DeploymentSelectorProvider>
              <ErrorBoundary>
                <AuthGuard>
                  <App />
                </AuthGuard>
              </ErrorBoundary>
            </DeploymentSelectorProvider>
          </AgentRegistryProvider>
        </ToastProvider>
      </AuthProvider>
    </QueryClientProvider>
  </StrictMode>,
);
