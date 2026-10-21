import React from "react";
import { COLORS, RADIUS, TRANSITIONS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";

export const DeploymentSelector: React.FC = () => {
  const { deploymentId, deployments, setDeploymentId, loading } = useDeploymentSelector();
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClick), 0);
    return () => { clearTimeout(timer); document.removeEventListener("mousedown", handleClick); };
  }, [open]);

  if (loading || deployments.length <= 1) return null;

  const current = deployments.find((d) => d.id === deploymentId);

  return (
    <div ref={containerRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "6px",
          height: "32px",
          padding: "0 12px",
          borderRadius: RADIUS.md,
          border: `1px solid ${COLORS.border}`,
          backgroundColor: COLORS.card,
          color: COLORS.foreground,
          fontSize: "0.8125rem",
          fontWeight: 500,
          cursor: "pointer",
          transition: `border-color ${TRANSITIONS.fast}`,
          minWidth: "140px",
          textAlign: "left",
        }}
      >
        <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {current?.name ?? "Select deployment"}
        </span>
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke={COLORS.mutedForeground} strokeWidth="2" strokeLinecap="round">
          <polyline points="3 4.5 6 7.5 9 4.5" />
        </svg>
      </button>

      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            minWidth: "200px",
            backgroundColor: COLORS.card,
            border: `1px solid ${COLORS.border}`,
            borderRadius: RADIUS.md,
            boxShadow: "0 4px 12px rgba(0,0,0,0.1)",
            zIndex: 200,
            padding: "4px",
          }}
        >
          {deployments.map((d) => (
            <button
              key={d.id}
              onClick={() => { setDeploymentId(d.id); setOpen(false); }}
              style={{
                display: "block",
                width: "100%",
                padding: "8px 10px",
                borderRadius: RADIUS.sm,
                border: "none",
                backgroundColor: d.id === deploymentId ? COLORS.secondary : "transparent",
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                fontWeight: d.id === deploymentId ? 600 : 400,
                textAlign: "left",
                cursor: "pointer",
                transition: `background-color ${TRANSITIONS.fast}`,
              }}
              onMouseEnter={(e) => { e.currentTarget.style.backgroundColor = COLORS.secondary; }}
              onMouseLeave={(e) => { if (d.id !== deploymentId) e.currentTarget.style.backgroundColor = "transparent"; }}
            >
              {d.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
