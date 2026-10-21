import React from "react";
import { COLORS, STATUS_COLORS } from "../../constants/theme";

export interface TierBadgeProps {
  tier: string;
  usage?: {
    leads: number;
    maxLeads: number;
    tokensToday: number;
    maxTokensPerDay: number;
    vmHoursToday: number;
    maxVmHoursPerDay: number;
  };
  onUpgrade?: () => void;
}

const TIER_COLORS: Record<string, { bg: string; text: string; border: string }> = {
  sandbox: { bg: "#f1f5f9", text: "#64748b", border: "#cbd5e1" },
  starter: { bg: "#eff6ff", text: "#2563eb", border: "#93c5fd" },
  pro: { bg: "#f0fdf4", text: "#16a34a", border: "#86efac" },
  business: { bg: "#fefce8", text: "#ca8a04", border: "#fde047" },
};

export const TierBadge: React.FC<TierBadgeProps> = ({ tier, usage, onUpgrade }) => {
  const colors = TIER_COLORS[tier] ?? TIER_COLORS.sandbox;
  const tierLabel = tier.charAt(0).toUpperCase() + tier.slice(1);

  const usagePercent = usage
    ? Math.max(
        (usage.leads / usage.maxLeads) * 100,
        (usage.tokensToday / usage.maxTokensPerDay) * 100,
        (usage.vmHoursToday / usage.maxVmHoursPerDay) * 100,
      )
    : 0;
  const nearLimit = usagePercent >= 80;

  return (
    <div
      style={{
        display: "inline-flex",
        flexDirection: "column",
        gap: "4px",
        padding: "6px 12px",
        borderRadius: "8px",
        border: `1px solid ${nearLimit ? STATUS_COLORS.warning : colors.border}`,
        backgroundColor: nearLimit ? STATUS_COLORS.warningBg : colors.bg,
        fontSize: "12px",
        fontWeight: 500,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
        <span
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: nearLimit ? STATUS_COLORS.warning : colors.text,
          }}
        />
        <span style={{ color: nearLimit ? STATUS_COLORS.warning : colors.text, fontWeight: 600 }}>
          {tierLabel}
        </span>
        {nearLimit && onUpgrade && (
          <button
            onClick={onUpgrade}
            style={{
              marginLeft: "4px",
              padding: "2px 8px",
              borderRadius: "4px",
              border: `1px solid ${STATUS_COLORS.info}`,
              backgroundColor: "transparent",
              color: STATUS_COLORS.info,
              fontSize: "10px",
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            Upgrade
          </button>
        )}
      </div>
      {usage && (
        <div style={{ display: "flex", gap: "8px", fontSize: "10px", color: COLORS.mutedForeground }}>
          <span>{usage.leads}/{usage.maxLeads} leads</span>
          <span>{usage.vmHoursToday.toFixed(1)}/{usage.maxVmHoursPerDay}h VM</span>
          <span>{(usage.tokensToday / 1000).toFixed(0)}/{(usage.maxTokensPerDay / 1000).toFixed(0)}k tok</span>
        </div>
      )}
    </div>
  );
};

TierBadge.displayName = "TierBadge";
