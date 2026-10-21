import React, { useState, useEffect, useCallback } from "react";
import { COLORS, RADIUS, Z_INDEX, TRANSITIONS, STATUS_COLORS } from "../constants/theme";
import { Button } from "./ui/Button";
import { Badge } from "./ui/Badge";
import { Tabs, type TabItem } from "./ui/Tabs";
import { Input, Textarea } from "./ui/Input";
import { LoadingState } from "./shared/LoadingState";
import { useLeadDetail, useUpdateLead } from "../hooks/useDataApi";

// ─── Types ───────────────────────────────────────────────────────

export interface RowDrawerProps {
  rowKey: string | null;
  onClose: () => void;
  onAction: (key: string, action: string) => void;
}

// ─── Evidence Panel ──────────────────────────────────────────────

const EvidencePanel: React.FC<{ evidence: Record<string, unknown> | undefined }> = ({ evidence }) => {
  if (!evidence || typeof evidence !== "object") {
    return (
      <div style={{ padding: "24px", textAlign: "center", color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        No website evidence available
      </div>
    );
  }

  const signals = evidence.signals ?? evidence.checklist ?? {};
  const snippet = evidence.snippet ?? evidence.summary ?? "";

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {snippet && (
        <div
          style={{
            padding: "12px",
            backgroundColor: COLORS.secondary,
            borderRadius: RADIUS.md,
            fontSize: "0.8125rem",
            color: COLORS.foreground,
            lineHeight: 1.5,
          }}
        >
          {String(snippet)}
        </div>
      )}
      {typeof signals === "object" && signals !== null && (
        <div style={{ display: "flex", flexDirection: "column", gap: "6px" }}>
          {Object.entries(signals as Record<string, unknown>).map(([key, val]) => {
            const isPass = val === true || val === "pass" || val === "yes";
            const isFail = val === false || val === "fail" || val === "no";
            const color = isPass ? STATUS_COLORS.success : isFail ? STATUS_COLORS.error : STATUS_COLORS.warning;
            const icon = isPass ? "\u2713" : isFail ? "\u2717" : "\u25CF";
            return (
              <div
                key={key}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "8px",
                  padding: "6px 10px",
                  borderRadius: RADIUS.sm,
                  backgroundColor: isPass ? STATUS_COLORS.successBg : isFail ? STATUS_COLORS.errorBg : STATUS_COLORS.warningBg,
                  fontSize: "0.8125rem",
                }}
              >
                <span style={{ color, fontWeight: 700, fontSize: "0.75rem" }}>{icon}</span>
                <span style={{ color: COLORS.foreground, fontWeight: 500 }}>{key.replace(/_/g, " ")}</span>
                <span style={{ marginLeft: "auto", color: COLORS.mutedForeground, fontSize: "0.75rem" }}>
                  {typeof val === "boolean" ? (val ? "Yes" : "No") : String(val)}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};

// ─── Classification Panel ────────────────────────────────────────

const ClassificationPanel: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const classification = data.classification;
  if (!classification || typeof classification !== "object") {
    return (
      <div style={{ padding: "24px", textAlign: "center", color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        No classification data
      </div>
    );
  }

  const cls = classification as Record<string, unknown>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
      {Object.entries(cls).map(([key, val]) => (
        <div
          key={key}
          style={{
            display: "flex",
            alignItems: "flex-start",
            justifyContent: "space-between",
            padding: "8px 12px",
            borderRadius: RADIUS.sm,
            backgroundColor: COLORS.secondary,
            fontSize: "0.8125rem",
          }}
        >
          <span style={{ color: COLORS.mutedForeground, fontWeight: 500, textTransform: "capitalize" }}>
            {key.replace(/_/g, " ")}
          </span>
          <span style={{ color: COLORS.foreground, fontWeight: 500, maxWidth: "60%", textAlign: "right" }}>
            {typeof val === "object" ? JSON.stringify(val) : String(val)}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Research Panel ──────────────────────────────────────────────

const ResearchPanel: React.FC<{ data: Record<string, unknown> }> = ({ data }) => {
  const research = data.research_recommendations ?? data.research;
  if (!research) {
    return (
      <div style={{ padding: "24px", textAlign: "center", color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
        No research recommendations
      </div>
    );
  }

  const items = Array.isArray(research) ? research : [research];
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
      {items.map((item, idx) => {
        const rec = item as Record<string, unknown>;
        return (
          <div
            key={idx}
            style={{
              padding: "12px",
              borderRadius: RADIUS.md,
              border: `1px solid ${COLORS.border}`,
              backgroundColor: COLORS.card,
            }}
          >
            <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "4px" }}>
              {rec.title ?? rec.action ?? `Recommendation ${idx + 1}`}
            </div>
            {rec.description && (
              <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, lineHeight: 1.5 }}>
                {String(rec.description)}
              </div>
            )}
            {rec.evidence_ref && (
              <Badge variant="neutral" style={{ marginTop: "6px" }}>
                Ref: {String(rec.evidence_ref)}
              </Badge>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ─── Component ───────────────────────────────────────────────────

const DRAWER_TABS: TabItem[] = [
  { id: "overview", label: "Overview" },
  { id: "evidence", label: "Evidence" },
  { id: "research", label: "Research" },
  { id: "audit", label: "Audit" },
];

export const RowDrawer: React.FC<RowDrawerProps> = ({ rowKey, onClose, onAction }) => {
  const { detail, loading, error } = useLeadDetail(rowKey);
  const { update, loading: updating } = useUpdateLead();
  const [tab, setTab] = useState("overview");
  const [editing, setEditing] = useState(false);
  const [editFields, setEditFields] = useState<Record<string, string>>({});

  useEffect(() => {
    if (detail) {
      setEditFields({
        status: String(detail.status ?? ""),
        note: String(detail.note ?? ""),
      });
    }
  }, [detail]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const handleSave = useCallback(async () => {
    if (!rowKey) return;
    const success = await update(rowKey, editFields);
    if (success) setEditing(false);
  }, [rowKey, editFields, update]);

  const isOpen = rowKey !== null;

  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          onClick={onClose}
          style={{
            position: "fixed",
            inset: 0,
            backgroundColor: "rgba(0,0,0,0.3)",
            backdropFilter: "blur(2px)",
            zIndex: Z_INDEX.overlay,
            transition: `opacity ${TRANSITIONS.slow}`,
          }}
        />
      )}

      {/* Drawer */}
      <div
        style={{
          position: "fixed",
          top: 0,
          right: 0,
          width: "520px",
          maxWidth: "100vw",
          height: "100vh",
          backgroundColor: COLORS.card,
          borderLeft: `1px solid ${COLORS.border}`,
          boxShadow: "-20px 0 45px -5px rgba(0,0,0,0.1)",
          zIndex: Z_INDEX.modal,
          display: "flex",
          flexDirection: "column",
          transform: isOpen ? "translateX(0)" : "translateX(100%)",
          transition: `transform ${TRANSITIONS.slow}`,
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "16px 20px",
            borderBottom: `1px solid ${COLORS.border}`,
            flexShrink: 0,
          }}
        >
          <div>
            <div style={{ fontSize: "1rem", fontWeight: 600, color: COLORS.foreground }}>
              Lead Details
            </div>
            {detail && (
              <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginTop: "2px" }}>
                {String(detail.email ?? detail.name ?? rowKey)}
              </div>
            )}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            {tab === "overview" && detail && (
              <Button
                variant={editing ? "primary" : "outline"}
                size="sm"
                onClick={() => (editing ? handleSave() : setEditing(true))}
                loading={updating}
                style={{ fontSize: "0.8125rem" }}
              >
                {editing ? "Save" : "Edit"}
              </Button>
            )}
            <button
              onClick={onClose}
              style={{
                width: "32px",
                height: "32px",
                borderRadius: RADIUS.sm,
                border: "none",
                backgroundColor: "transparent",
                color: COLORS.mutedForeground,
                cursor: "pointer",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        </div>

        {/* Tabs */}
        <Tabs tabs={DRAWER_TABS} activeTab={tab} onChange={setTab} style={{ flexShrink: 0 }} />

        {/* Content */}
        <div style={{ flex: 1, overflowY: "auto", padding: "20px" }}>
          {loading && <LoadingState variant="spinner" message="Loading details..." />}
          {error && (
            <div style={{ padding: "16px", color: STATUS_COLORS.error, fontSize: "0.875rem", textAlign: "center" }}>
              {error}
            </div>
          )}
          {detail && !loading && (
            <>
              {tab === "overview" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  {Object.entries(detail)
                    .filter(([key]) => !["classification", "website_evidence", "research_recommendations", "research", "audit_log"].includes(key))
                    .map(([key, val]) => {
                      const isEditable = editing && (key === "status" || key === "note");
                      return (
                        <div key={key} style={{ display: "flex", flexDirection: "column", gap: "4px" }}>
                          <div style={{ fontSize: "0.75rem", fontWeight: 500, color: COLORS.mutedForeground, textTransform: "uppercase", letterSpacing: "0.04em" }}>
                            {key.replace(/_/g, " ")}
                          </div>
                          {isEditable && key === "note" ? (
                            <Textarea
                              value={editFields.note ?? ""}
                              onChange={(e) => setEditFields({ ...editFields, note: (e.target as HTMLTextAreaElement).value })}
                              style={{ minHeight: "60px" }}
                            />
                          ) : isEditable && key === "status" ? (
                            <Input
                              value={editFields.status ?? ""}
                              onChange={(e) => setEditFields({ ...editFields, status: (e.target as HTMLInputElement).value })}
                            />
                          ) : typeof val === "object" && val !== null ? (
                            <pre
                              style={{
                                fontSize: "0.75rem",
                                fontFamily: "var(--font-mono)",
                                color: COLORS.foreground,
                                backgroundColor: COLORS.secondary,
                                padding: "8px 12px",
                                borderRadius: RADIUS.sm,
                                overflow: "auto",
                                maxHeight: "200px",
                                margin: 0,
                              }}
                            >
                              {JSON.stringify(val, null, 2)}
                            </pre>
                          ) : (
                            <div style={{ fontSize: "0.875rem", color: COLORS.foreground }}>
                              {val === null || val === undefined || val === "" ? (
                                <span style={{ color: COLORS.mutedForeground }}>-</span>
                              ) : (
                                String(val)
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                </div>
              )}
              {tab === "evidence" && <EvidencePanel evidence={detail.website_evidence as Record<string, unknown>} />}
              {tab === "research" && (
                <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
                  <ClassificationPanel data={detail} />
                  <div style={{ borderTop: `1px solid ${COLORS.border}`, paddingTop: "16px" }}>
                    <ResearchPanel data={detail} />
                  </div>
                </div>
              )}
              {tab === "audit" && (
                <div>
                  {detail.audit_log ? (
                    <pre
                      style={{
                        fontSize: "0.75rem",
                        fontFamily: "var(--font-mono)",
                        color: COLORS.foreground,
                        backgroundColor: COLORS.secondary,
                        padding: "12px",
                        borderRadius: RADIUS.md,
                        overflow: "auto",
                        maxHeight: "400px",
                        margin: 0,
                      }}
                    >
                      {JSON.stringify(detail.audit_log, null, 2)}
                    </pre>
                  ) : (
                    <div style={{ padding: "24px", textAlign: "center", color: COLORS.mutedForeground, fontSize: "0.8125rem" }}>
                      No audit log entries
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>

        {/* Actions */}
        {detail && rowKey && (
          <div
            style={{
              display: "flex",
              gap: "8px",
              padding: "16px 20px",
              borderTop: `1px solid ${COLORS.border}`,
              flexShrink: 0,
              flexWrap: "wrap",
            }}
          >
            <Button variant="primary" size="sm" onClick={() => onAction(rowKey, "approve")}>
              Approve
            </Button>
            <Button variant="outline" size="sm" onClick={() => onAction(rowKey, "reject")}>
              Reject
            </Button>
            <Button variant="outline" size="sm" onClick={() => onAction(rowKey, "research-now")}>
              Research Now
            </Button>
            <Button variant="destructive" size="sm" onClick={() => onAction(rowKey, "erase")}>
              Erase
            </Button>
          </div>
        )}
      </div>
    </>
  );
};
