/**
 * App — route switch
 * ──────────────────
 * One useRouter instance owns history; screens receive `onNavigate` so every
 * navigation goes through the same state (pushState alone doesn't notify
 * other router instances).
 *
 *   /                        → FleetDashboard
 *   /data                    → DataSection
 *   /operations              → OperationsSection
 *   /inbox                   → ApprovalInbox
 *   /conversations           → ConversationsSection
 *   /reports                 → ReportsSection
 *   /setup                   → SetupSection
 *   /agents/:agentId/:tab    → AgentDetail
 *   anything else            → NotFound
 *
 * Also owns the whitelabel document.title (BRAND_NAME — BRAND_TAGLINE);
 * the accent override is applied once at boot in main.tsx (applyBrandAccent).
 *
 * Module gate: renderScreen is the single chokepoint every screen flows
 * through, so per-deployment module flags (lib/modules.ts) are enforced
 * here — a disabled module renders NotFound regardless of how the user
 * got there (deep link, back button, stale palette entry).
 */

import * as React from "react";
import { isModuleEnabled, type ModuleId } from "@calla/shared";
import { ConsoleLayout } from "@/components/layout";
import { getCallaConfig } from "@/config";
import { useRouter } from "@/hooks";
import { initModuleConfig, useModuleConfig } from "@/lib/modules";
import { AgentDetail } from "@/pages/AgentDetail";
import { ApprovalInbox } from "@/pages/ApprovalInbox";
import { ConversationsSection } from "@/pages/ConversationsSection";
import { DataSection } from "@/pages/DataSection";
import { FleetDashboard } from "@/pages/FleetDashboard";
import { OperationsSection } from "@/pages/OperationsSection";
import { NotFound } from "@/pages/NotFound";
import { ReportsSection } from "@/pages/ReportsSection";
import { SetupSection } from "@/pages/SetupSection";
import type { Route, ViewId } from "@/types/ui";

// Code-split: the voice client (Agents SDK + PartySocket) is only needed on
// the Calls screen and is heavy — keep it out of the main bundle.
const CallsSectionLazy = React.lazy(
  () => import("@/pages/CallsSection").then((m) => ({ default: m.CallsSection })),
);

/** ViewId → owning module (null = no gate). Always-on modules pass trivially. */
const VIEW_MODULE: Partial<Record<ViewId, ModuleId>> = {
  fleet: "fleet",
  data: "data",
  operations: "data",
  inbox: "inbox",
  conversations: "conversations",
  reports: "reports",
  calls: "voice",
  setup: "setup",
  "agent-detail": "agents",
};

function renderScreen(
  route: Route,
  navigate: (path: string) => void,
  modules: ModuleId[] | null,
) {
  const module = VIEW_MODULE[route.view];
  if (module && !isModuleEnabled(module, modules)) {
    return <NotFound onNavigate={navigate} />;
  }
  switch (route.view) {
    case "fleet":
      return <FleetDashboard onNavigate={navigate} />;
    case "data":
      return <DataSection onNavigate={navigate} />;
    case "operations":
      return <OperationsSection onNavigate={navigate} />;
    case "inbox":
      return <ApprovalInbox onNavigate={navigate} />;
    case "conversations":
      return <ConversationsSection onNavigate={navigate} />;
    case "reports":
      return <ReportsSection onNavigate={navigate} />;
    case "calls":
      return (
        <React.Suspense fallback={null}>
          <CallsSectionLazy />
        </React.Suspense>
      );
    case "setup":
      return <SetupSection onNavigate={navigate} />;
    case "agent-detail":
      return route.agentId ? (
        <AgentDetail agentId={route.agentId} tab={route.tab} />
      ) : (
        <NotFound onNavigate={navigate} />
      );
    default:
      return <NotFound onNavigate={navigate} />;
  }
}

export function App() {
  const { route, navigate } = useRouter();
  const brand = React.useMemo(() => getCallaConfig(), []);
  const { modules } = useModuleConfig();

  // Resolve the per-deployment module set once (brain → config → all).
  React.useEffect(() => {
    initModuleConfig();
  }, []);

  // Whitelabel: keep document.title in sync with the runtime brand config.
  React.useEffect(() => {
    document.title = `${brand.BRAND_NAME} — ${brand.BRAND_TAGLINE}`;
  }, [brand.BRAND_NAME, brand.BRAND_TAGLINE]);

  return (
    <ConsoleLayout route={route} onNavigate={navigate}>
      {renderScreen(route, navigate, modules)}
    </ConsoleLayout>
  );
}

export default App;
