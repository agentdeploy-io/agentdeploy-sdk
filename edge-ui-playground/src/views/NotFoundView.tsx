/**
 * NotFoundView Component (404)
 * ───────────────────────────────
 * Displayed when the user navigates to an unknown route.
 * Shows the attempted path and offers navigation back to safety.
 *
 * Design matches the empty-state pattern used throughout the app.
 */

import React from "react";
import { Button } from "../components/ui";
import { COLORS } from "../constants/theme";

// ─── Props ───────────────────────────────────────────────────────

export interface NotFoundViewProps {
  /** The unknown path that was attempted (for display) */
  attemptedPath?: string;
  /** Navigate to a known route */
  onNavigateHome: () => void;
  /** Navigate to agents list */
  onNavigateAgents: () => void;
}

// ─── Component ───────────────────────────────────────────────────

export const NotFoundView: React.FC<NotFoundViewProps> = ({
  attemptedPath,
  onNavigateHome,
  onNavigateAgents,
}) => {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        minHeight: "60vh",
        gap: "24px",
        textAlign: "center",
      }}
      className="fade-in"
    >
      {/* 404 Big Number */}
      <div
        style={{
          fontSize: "5rem",
          fontWeight: 800,
          lineHeight: 1,
          color: COLORS.mutedForeground,
          letterSpacing: "-0.04em",
        }}
      >
        404
      </div>

      {/* Message */}
      <div style={{ maxWidth: "420px" }}>
        <h2
          style={{
            fontSize: "1.25rem",
            fontWeight: 600,
            color: COLORS.foreground,
            marginBottom: "8px",
          }}
        >
          Page Not Found
        </h2>
        <p
          style={{
            fontSize: "0.875rem",
            color: COLORS.mutedForeground,
            lineHeight: 1.5,
          }}
        >
          The page you're looking for doesn't exist or has been moved.
          {attemptedPath && (
            <>
              <br />
              <code
                style={{
                  display: "inline-block",
                  marginTop: "8px",
                  padding: "2px 8px",
                  fontSize: "0.8125rem",
                  backgroundColor: COLORS.secondary,
                  borderRadius: "4px",
                  color: COLORS.foreground,
                }}
              >
                {attemptedPath}
              </code>
            </>
          )}
        </p>
      </div>

      {/* Actions */}
      <div style={{ display: "flex", gap: "12px" }}>
        <Button variant="primary" onClick={onNavigateHome}>
          Go to Overview
        </Button>
        <Button variant="outline" onClick={onNavigateAgents}>
          Browse Agents
        </Button>
      </div>
    </div>
  );
};
