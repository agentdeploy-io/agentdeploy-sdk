import React, { useState, useCallback, useEffect, useRef } from "react";
import { Card, Button, Badge, Tabs, type TabItem } from "../components/ui";
import { LoadingState, EmptyState } from "../components/shared";
import { DeploymentSelector } from "../components/DeploymentSelector";
import { COLORS, RADIUS, STATUS_COLORS, TRANSITIONS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";
import { useLeads, useUpdateLead, type DataFilters } from "../hooks/useDataApi";

// ─── Props ───────────────────────────────────────────────────────

export interface HITLViewProps {
  // no props needed
}

// ─── Tabs ────────────────────────────────────────────────────────

const HITL_TABS: TabItem[] = [
  { id: "leads", label: "Leads", badge: undefined as string | number | undefined },
  { id: "replies", label: "Reply Drafts" },
  { id: "websites", label: "Flagged Websites" },
];

// ─── Tier Badge ──────────────────────────────────────────────────

const TIER_VARIANT: Record<string, "success" | "warning" | "error" | "info" | "neutral"> = {
  A: "success",
  B: "info",
  C: "warning",
  D: "error",
};

// ─── Lead Card ───────────────────────────────────────────────────

const LeadCard: React.FC<{
  lead: Record<string, unknown>;
  onApprove: (key: string) => void;
  onReject: (key: string) => void;
  isFocused: boolean;
}> = ({ lead, onApprove, onReject, isFocused }) => {
  const key = String(lead.email ?? lead.id ?? lead.key ?? "");
  const tier = String(lead.tier ?? "");
  const evidence = lead.website_evidence as Record<string, unknown> | undefined;
  const snippet = evidence?.snippet ?? evidence?.summary ?? "";

  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: RADIUS.lg,
        border: `1px solid ${isFocused ? COLORS.primary : COLORS.border}`,
        backgroundColor: COLORS.card,
        outline: isFocused ? `2px solid ${COLORS.primary}` : "none",
        outlineOffset: "-2px",
        transition: `border-color ${TRANSITIONS.fast}`,
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
              {String(lead.name ?? lead.email ?? "Unknown")}
            </span>
            {tier && <Badge variant={TIER_VARIANT[tier] ?? "neutral"}>Tier {tier}</Badge>}
            <Badge variant="warning">pending_review</Badge>
          </div>
          <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, marginBottom: "4px" }}>
            {String(lead.email ?? "")}
            {lead.company && ` · ${String(lead.company)}`}
          </div>
          {snippet && (
            <div
              style={{
                fontSize: "0.8125rem",
                color: COLORS.foreground,
                padding: "8px 12px",
                backgroundColor: COLORS.secondary,
                borderRadius: RADIUS.sm,
                marginTop: "8px",
                lineHeight: 1.5,
              }}
            >
              {String(snippet)}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => onApprove(key)}
            style={{ fontSize: "0.8125rem" }}
          >
            Approve
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onReject(key)}
            style={{ fontSize: "0.8125rem" }}
          >
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
};

// ─── Reply Draft Card ────────────────────────────────────────────

const ReplyDraftCard: React.FC<{
  draft: Record<string, unknown>;
  onApprove: (key: string) => void;
  onDiscard: (key: string) => void;
  isFocused: boolean;
}> = ({ draft, onApprove, onDiscard, isFocused }) => {
  const key = String(draft.email ?? draft.id ?? draft.key ?? "");
  const reply = draft.reply_draft ?? draft.reply ?? "";
  const context = draft.context ?? draft.last_message ?? "";

  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: RADIUS.lg,
        border: `1px solid ${isFocused ? COLORS.primary : COLORS.border}`,
        backgroundColor: COLORS.card,
        outline: isFocused ? `2px solid ${COLORS.primary}` : "none",
        outlineOffset: "-2px",
      }}
    >
      <div style={{ marginBottom: "8px" }}>
        <span style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
          {String(draft.name ?? draft.email ?? "Unknown")}
        </span>
        <span style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, marginLeft: "8px" }}>
          {String(draft.email ?? "")}
        </span>
      </div>

      {context && (
        <div
          style={{
            fontSize: "0.8125rem",
            color: COLORS.mutedForeground,
            padding: "8px 12px",
            backgroundColor: COLORS.secondary,
            borderRadius: RADIUS.sm,
            marginBottom: "8px",
            borderLeft: `3px solid ${COLORS.border}`,
            lineHeight: 1.5,
          }}
        >
          {String(context)}
        </div>
      )}

      {reply && (
        <div
          style={{
            fontSize: "0.875rem",
            color: COLORS.foreground,
            padding: "12px",
            backgroundColor: STATUS_COLORS.successBg,
            borderRadius: RADIUS.md,
            marginBottom: "12px",
            lineHeight: 1.6,
            border: `1px solid ${STATUS_COLORS.successBorder}`,
          }}
        >
          {String(reply)}
        </div>
      )}

      <div style={{ display: "flex", gap: "6px" }}>
        <Button variant="primary" size="sm" onClick={() => onApprove(key)}>
          Approve & Send
        </Button>
        <Button variant="outline" size="sm" onClick={() => onDiscard(key)}>
          Discard
        </Button>
      </div>
    </div>
  );
};

// ─── Flagged Website Card ────────────────────────────────────────

const FlaggedWebsiteCard: React.FC<{
  item: Record<string, unknown>;
  onConfirm: (key: string) => void;
  onReject: (key: string) => void;
  isFocused: boolean;
}> = ({ item, onConfirm, onReject, isFocused }) => {
  const key = String(item.email ?? item.website ?? item.id ?? "");
  const website = item.website ?? "";
  const evidence = item.website_evidence as Record<string, unknown> | undefined;

  return (
    <div
      style={{
        padding: "16px 20px",
        borderRadius: RADIUS.lg,
        border: `1px solid ${isFocused ? COLORS.primary : COLORS.border}`,
        backgroundColor: COLORS.card,
        outline: isFocused ? `2px solid ${COLORS.primary}` : "none",
        outlineOffset: "-2px",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "6px" }}>
            <span style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground }}>
              {String(website)}
            </span>
            <Badge variant="warning">Flagged</Badge>
          </div>
          <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, marginBottom: "8px" }}>
            {String(item.name ?? item.email ?? "")}
          </div>

          {evidence && typeof evidence === "object" && (
            <div
              style={{
                padding: "10px 12px",
                backgroundColor: COLORS.secondary,
                borderRadius: RADIUS.sm,
                fontSize: "0.8125rem",
              }}
            >
              {Object.entries(evidence).slice(0, 6).map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0" }}>
                  <span style={{ color: COLORS.mutedForeground }}>{k.replace(/_/g, " ")}</span>
                  <span style={{ color: COLORS.foreground, fontWeight: 500 }}>
                    {typeof v === "boolean" ? (v ? "Yes" : "No") : typeof v === "object" ? "-" : String(v)}
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: "flex", gap: "6px", flexShrink: 0 }}>
          <Button variant="primary" size="sm" onClick={() => onConfirm(key)}>
            Confirm Domain
          </Button>
          <Button variant="outline" size="sm" onClick={() => onReject(key)}>
            Reject
          </Button>
        </div>
      </div>
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────

export const HITLView: React.FC<HITLViewProps> = () => {
  const { deploymentId } = useDeploymentSelector();
  const [tab, setTab] = useState("leads");
  const [focusIdx, setFocusIdx] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  const pendingFilters: DataFilters = { status: ["pending_review"] };
  const flaggedFilters: DataFilters = { website_status: ["unreachable", "timeout"] };

  const leadsQuery = useLeads(pendingFilters, 1, 50, deploymentId);
  const repliesQuery = useLeads({ stage: ["sent"], status: ["pending"] }, 1, 50, deploymentId);
  const websitesQuery = useLeads(flaggedFilters, 1, 50, deploymentId);

  const { update: updateLead } = useUpdateLead(deploymentId);

  const currentItems =
    tab === "leads" ? leadsQuery.data.rows :
    tab === "replies" ? repliesQuery.data.rows :
    websitesQuery.data.rows;

  const isLoading = tab === "leads" ? leadsQuery.loading : tab === "replies" ? repliesQuery.loading : websitesQuery.loading;
  const hasError = tab === "leads" ? leadsQuery.error : tab === "replies" ? repliesQuery.error : websitesQuery.error;

  const handleAction = useCallback(
    async (key: string, action: string) => {
      const patches: Record<string, Record<string, unknown>> = {
        approve: { status: "approved" },
        reject: { status: "rejected" },
        discard: { status: "rejected", reply_draft: null },
        confirm: { website_status: "confirmed" },
      };
      const patch = patches[action];
      if (patch) {
        await updateLead(key, patch);
        leadsQuery.refetch();
        repliesQuery.refetch();
        websitesQuery.refetch();
      }
    },
    [updateLead, leadsQuery, repliesQuery, websitesQuery],
  );

  // Keyboard shortcuts: j/k navigate, a approve, r reject
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      const isTyping = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;
      if (isTyping) return;

      if (e.key === "j") {
        e.preventDefault();
        setFocusIdx((i) => Math.min(currentItems.length - 1, i + 1));
      } else if (e.key === "k") {
        e.preventDefault();
        setFocusIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "a" && currentItems[focusIdx]) {
        const item = currentItems[focusIdx];
        const key = String(item.email ?? item.id ?? item.key ?? "");
        handleAction(key, "approve");
      } else if (e.key === "r" && currentItems[focusIdx]) {
        const item = currentItems[focusIdx];
        const key = String(item.email ?? item.id ?? item.key ?? "");
        handleAction(key, tab === "replies" ? "discard" : "reject");
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [focusIdx, currentItems, handleAction, tab]);

  useEffect(() => {
    setFocusIdx(0);
  }, [tab]);

  const tabsWithBadges: TabItem[] = HITL_TABS.map((t) => {
    if (t.id === "leads") return { ...t, badge: leadsQuery.data.total || undefined };
    if (t.id === "replies") return { ...t, badge: repliesQuery.data.total || undefined };
    if (t.id === "websites") return { ...t, badge: websitesQuery.data.total || undefined };
    return t;
  });

  return (
    <div ref={containerRef} style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "12px" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
            HITL Center
          </h1>
          <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
            Unified inbox for all human decisions
            <span style={{ marginLeft: "12px", fontSize: "0.75rem", color: COLORS.mutedForeground, fontStyle: "italic" }}>
              Shortcuts: j/k navigate, a approve, r reject
            </span>
          </p>
        </div>
        <DeploymentSelector />
      </div>

      {/* Tabs */}
      <Tabs tabs={tabsWithBadges} activeTab={tab} onChange={setTab} />

      {/* Content */}
      {!deploymentId ? (
        <EmptyState icon="🎯" title="No deployment selected" message="Select a deployment above to view items requiring human review." />
      ) : isLoading ? (
        <LoadingState variant="spinner" message="Loading items..." height="200px" />
      ) : hasError ? (
        <Card>
          <div style={{ padding: "24px", textAlign: "center" }}>
            <p style={{ color: STATUS_COLORS.error, fontSize: "0.875rem", marginBottom: "12px" }}>
              {String(hasError)}
            </p>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                leadsQuery.refetch();
                repliesQuery.refetch();
                websitesQuery.refetch();
              }}
            >
              Try Again
            </Button>
          </div>
        </Card>
      ) : currentItems.length === 0 ? (
        <EmptyState
          icon={tab === "leads" ? "🎉" : tab === "replies" ? "✉️" : "🌐"}
          title={
            tab === "leads" ? "All caught up!" :
            tab === "replies" ? "No reply drafts pending" :
            "No flagged websites"
          }
          message={
            tab === "leads" ? "There are no leads pending review right now." :
            tab === "replies" ? "No reply drafts are waiting for approval." :
            "No websites have been flagged for review."
          }
        />
      ) : (
        <div data-tour="hitl" style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {tab === "leads" &&
            currentItems.map((lead, idx) => (
              <LeadCard
                key={String(lead.email ?? idx)}
                lead={lead}
                onApprove={(k) => handleAction(k, "approve")}
                onReject={(k) => handleAction(k, "reject")}
                isFocused={idx === focusIdx}
              />
            ))}
          {tab === "replies" &&
            currentItems.map((draft, idx) => (
              <ReplyDraftCard
                key={String(draft.email ?? idx)}
                draft={draft}
                onApprove={(k) => handleAction(k, "approve")}
                onDiscard={(k) => handleAction(k, "discard")}
                isFocused={idx === focusIdx}
              />
            ))}
          {tab === "websites" &&
            currentItems.map((item, idx) => (
              <FlaggedWebsiteCard
                key={String(item.website ?? item.email ?? idx)}
                item={item}
                onConfirm={(k) => handleAction(k, "confirm")}
                onReject={(k) => handleAction(k, "reject")}
                isFocused={idx === focusIdx}
              />
            ))}
        </div>
      )}
    </div>
  );
};
