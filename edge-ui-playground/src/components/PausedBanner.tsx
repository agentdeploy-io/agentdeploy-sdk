import React from "react";
import { COLORS, RADIUS, Z_INDEX } from "../constants/theme";
import { Button } from "./ui";

export interface PausedBannerProps {
  onResume: () => void;
}

export const PausedBanner: React.FC<PausedBannerProps> = ({ onResume }) => {
  return (
    <div
      role="alert"
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        right: 0,
        zIndex: Z_INDEX.toast,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: "12px",
        padding: "10px 16px",
        backgroundColor: COLORS.destructive,
        color: COLORS.destructiveForeground,
        fontSize: "0.875rem",
        fontWeight: 600,
        fontFamily: "inherit",
        boxShadow: "0 4px 6px -1px rgba(0,0,0,0.15)",
      }}
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: RADIUS.full,
          backgroundColor: COLORS.destructiveForeground,
          opacity: 0.9,
        }}
      />
      <span>SYSTEM PAUSED &mdash; No crawls, no sends</span>
      <Button
        variant="outline"
        size="sm"
        onClick={onResume}
        style={{
          marginLeft: "8px",
          backgroundColor: "rgba(255,255,255,0.15)",
          border: "1px solid rgba(255,255,255,0.4)",
          color: COLORS.destructiveForeground,
          fontSize: "0.75rem",
          height: "28px",
          padding: "0 12px",
        }}
      >
        Resume
      </Button>
    </div>
  );
};
