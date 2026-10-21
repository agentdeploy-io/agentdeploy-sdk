import React from "react";
import { COLORS, RADIUS } from "../constants/theme";

export interface DemoBadgeProps {
  onExit?: () => void;
}

export const DemoBadge: React.FC<DemoBadgeProps> = ({ onExit }) => {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "8px",
        padding: "4px 12px",
        borderRadius: RADIUS.full,
        background: "linear-gradient(135deg, #3b82f6 0%, #8b5cf6 100%)",
        color: "#fff",
        fontSize: "0.75rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        boxShadow: "0 2px 8px rgba(59, 130, 246, 0.3)",
        flexShrink: 0,
      }}
    >
      <span
        style={{
          width: "6px",
          height: "6px",
          borderRadius: "50%",
          backgroundColor: "#fff",
          animation: "pulse 2s ease-in-out infinite",
        }}
      />
      <span>Demo Mode</span>
      {onExit && (
        <button
          onClick={onExit}
          aria-label="Exit demo"
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "16px",
            height: "16px",
            borderRadius: "50%",
            border: "none",
            backgroundColor: "rgba(255,255,255,0.2)",
            color: "#fff",
            fontSize: "10px",
            cursor: "pointer",
            lineHeight: 1,
            marginLeft: "2px",
          }}
        >
          ×
        </button>
      )}
    </div>
  );
};
