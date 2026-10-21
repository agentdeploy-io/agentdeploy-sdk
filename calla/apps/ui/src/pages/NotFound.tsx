/**
 * NotFound — 404 for unknown routes
 * ─────────────────────────────────
 * Calla has three screens; anything else lands here with a way back.
 */

import * as React from "react";
import { Compass, Inbox, LayoutDashboard } from "lucide-react";
import { Button } from "@/components/ui";

export interface NotFoundProps {
  onNavigate: (path: string) => void;
}

export const NotFound: React.FC<NotFoundProps> = ({ onNavigate }) => {
  const path = typeof window === "undefined" ? "/" : window.location.pathname;

  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 px-6 text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-surface-tag text-muted-foreground">
        <Compass className="size-7" />
      </span>

      <div className="space-y-1.5">
        <h1 className="text-2xl font-bold tracking-tight text-foreground">Page not found</h1>
        <p className="max-w-[420px] text-sm text-muted-foreground">
          Nothing is routed at{" "}
          <code className="rounded bg-surface-tag px-1.5 py-0.5 font-mono text-xs text-foreground">
            {path}
          </code>
          . Calla ships three screens — the fleet, the approval inbox, and an agent's detail view.
        </p>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-center gap-2">
        <Button onClick={() => onNavigate("/")}>
          <LayoutDashboard className="size-4" />
          Go to Fleet
        </Button>
        <Button variant="outline" onClick={() => onNavigate("/inbox")}>
          <Inbox className="size-4" />
          Approval Inbox
        </Button>
      </div>
    </div>
  );
};

NotFound.displayName = "NotFound";
