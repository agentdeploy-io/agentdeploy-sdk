/**
 * SettingsView Component
 * ─────────────────────
 * User preferences, API tokens, and system configuration.
 *
 * Sections:
 *   - Profile & Organization
 *   - API Tokens
 *   - Notifications
 *   - Appearance (future: dark mode)
 *   - Danger Zone (reset/clear data)
 */

import React from "react";
import { Card, Button, Input, Tabs } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import { useLocalStorage } from "../hooks/useLocalStorage";

// ─── Props ───────────────────────────────────────────────────────

export interface SettingsViewProps {}

// ─── Component ───────────────────────────────────────────────────

export const SettingsView: React.FC<SettingsViewProps> = () => {
  const [section, setSection] = React.useState("profile");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
          Settings
        </h1>
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          Manage your account, tokens, and preferences
        </p>
      </div>

      {/* ─── Section Tabs ────────────────────────────────────── */}
      <Tabs
        tabs={[
          { id: "profile", label: "Profile" },
          { id: "tokens", label: "API Tokens" },
          { id: "notifications", label: "Notifications" },
          { id: "danger", label: "Danger Zone" },
        ]}
        activeTab={section}
        onChange={setSection}
        variant="pills"
      />

      {/* ─── Content ─────────────────────────────────────────── */}
      {section === "profile" && <ProfileSection />}
      {section === "tokens" && <TokensSection />}
      {section === "notifications" && <NotificationsSection />}
      {section === "danger" && <DangerSection />}
    </div>
  );
};

// ─── Profile Section ─────────────────────────────────────────────

const ProfileSection: React.FC = () => {
  const [name, setName] = useLocalStorage("edge-user-name", "Edge Admin");
  const [email, setEmail] = useLocalStorage("edge-user-email", "admin@agentdeploy.io");

  return (
    <Card>
      <Card.Header
        title="Profile"
        subtitle="Your account information"
        actions={<Button variant="primary" size="sm">Save</Button>}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: "20px", maxWidth: "480px" }}>
        <Input label="Display Name" value={name} onChange={(e) => setName(e.target.value)} />
        <Input label="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input label="Organization" value="AgentDeploy" disabled description="Contact support to change organization" />
      </div>
    </Card>
  );
};

// ─── Tokens Section ──────────────────────────────────────────────
//
// The Edge Console is a client-side playground with no backend.
// Real API tokens would require a server to issue and validate them.
// We show an honest empty state explaining where real tokens live.

const TokensSection: React.FC = () => (
  <Card>
    <Card.Header
      title="API Tokens"
      subtitle="Tokens are issued by the Cloudflare Dashboard or a backend API — not generated here"
    />
    <EmptyState
      icon="🔑"
      title="No Token Management in This Console"
      message="This playground runs entirely in your browser with no backend service to issue or validate tokens. In production, manage API tokens via the Cloudflare Dashboard (Manage API Tokens) or implement a token endpoint in your agent worker."
      action={{
        label: "Open Cloudflare Dashboard",
        onClick: () => window.open("https://dash.cloudflare.com/profile/api-tokens", "_blank", "noopener"),
      }}
    />
  </Card>
);

// ─── Notifications Section ───────────────────────────────────────

const NotificationsSection: React.FC = () => {
  const [emailAlerts, setEmailAlerts] = useLocalStorage("edge-email-alerts", true);
  const [slackAlerts, setSlackAlerts] = useLocalStorage("edge-slack-alerts", false);
  const [errorAlerts, setErrorAlerts] = useLocalStorage("edge-error-alerts", true);
  const [dailyDigest, setDailyDigest] = useLocalStorage("edge-daily-digest", true);

  return (
    <Card>
      <Card.Header title="Notifications" subtitle="Choose how you want to be notified" />
      <div style={{ display: "flex", flexDirection: "column", gap: "0" }}>
        <ToggleRow label="Email Alerts" description="Receive email notifications for important events" checked={emailAlerts} onChange={setEmailAlerts} />
        <ToggleRow label="Slack Integration" description="Send alerts to a Slack channel" checked={slackAlerts} onChange={setSlackAlerts} />
        <ToggleRow label="Error Notifications" description="Get notified when agents encounter errors" checked={errorAlerts} onChange={setErrorAlerts} />
        <ToggleRow label="Daily Digest" description="A summary of agent activity every morning" checked={dailyDigest} onChange={setDailyDigest} />
      </div>
    </Card>
  );
};

const ToggleRow: React.FC<{
  label: string;
  description: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}> = ({ label, description, checked, onChange }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      justifyContent: "space-between",
      padding: "12px 0",
      borderBottom: `1px solid ${COLORS.border}`,
    }}
  >
    <div>
      <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>{label}</div>
      <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>{description}</div>
    </div>
    <button
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      onKeyDown={(e) => {
        // Prevent default space scroll and toggle
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onChange(!checked);
        }
      }}
      style={{
        width: "44px",
        height: "24px",
        borderRadius: "12px",
        backgroundColor: checked ? COLORS.primary : COLORS.border,
        position: "relative",
        cursor: "pointer",
        border: "none",
        transition: "background-color 200ms ease",
        flexShrink: 0,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          position: "absolute",
          top: "2px",
          left: checked ? "22px" : "2px",
          width: "20px",
          height: "20px",
          borderRadius: "50%",
          backgroundColor: COLORS.card,
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 200ms ease",
        }}
      />
    </button>
  </div>
);

// ─── Danger Zone Section ─────────────────────────────────────────

const DangerSection: React.FC = () => (
  <Card style={{ borderColor: STATUS_COLORS.errorBorder }}>
    <Card.Header
      title="Danger Zone"
      subtitle="Irreversible actions — proceed with caution"
    />
    <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0", borderBottom: `1px solid ${COLORS.border}` }}>
        <div>
          <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>Clear Local Data</div>
          <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            Remove all cached data and preferences from this browser
          </div>
        </div>
        <Button variant="outline" size="sm" style={{ borderColor: STATUS_COLORS.error, color: STATUS_COLORS.error }} onClick={() => localStorage.clear()}>
          Clear Data
        </Button>
      </div>

      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "12px 0" }}>
        <div>
          <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>Reset All Agent Connections</div>
          <div style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground }}>
            Force disconnect and reconnect all agents
          </div>
        </div>
        <Button variant="destructive" size="sm">
          Reset Connections
        </Button>
      </div>
    </div>
  </Card>
);
