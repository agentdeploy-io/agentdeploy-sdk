import React, { useState, useCallback, useMemo } from "react";
import { Card, Button, Badge, Tabs, Tooltip, type TabItem } from "../components/ui";
import { ConfirmDialog } from "../components/ui/Modal";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import { useSettingsState } from "../hooks/useSettings";

export interface SecretsConfigViewProps {}

// ─── Types ───────────────────────────────────────────────────────

interface SecretDef {
  key: string;
  label: string;
  required: "required" | "required for outreach" | "optional" | "optional flag";
  category: string;
}

interface SecretState {
  configured: boolean;
  value: string;
  dirty: boolean;
  saving: boolean;
}

interface SettingsState {
  paused: boolean;
  dryRun: boolean;
  sendEnabled: boolean;
  dailyCap: number;
  countries: string[];
  testRecipients: string;
  brandName: string;
  brandOneLiner: string;
  dryRunExecuted: boolean;
}

// ─── Constants ───────────────────────────────────────────────────

const SECRETS: SecretDef[] = [
  { key: "COMPANIES_HOUSE_KEY", label: "Companies House API Key", required: "required", category: "Search & Discovery" },
  { key: "BRAVE_API_KEY", label: "Brave Search API Key", required: "required", category: "Search & Discovery" },
  { key: "BREVO_API_KEY", label: "Brevo API Key", required: "required for outreach", category: "Email & Outreach" },
  { key: "BREVO_SENDER_EMAIL", label: "Brevo Sender Email", required: "required for outreach", category: "Email & Outreach" },
  { key: "BREVO_SENDER_NAME", label: "Brevo Sender Name", required: "optional", category: "Email & Outreach" },
  { key: "BREVO_REPLY_TO", label: "Brevo Reply-To", required: "optional", category: "Email & Outreach" },
  { key: "CALENDLY_URL", label: "Calendly URL", required: "optional", category: "Email & Outreach" },
  { key: "BRAND_NAME", label: "Brand Name", required: "required", category: "Brand & Identity" },
  { key: "BRAND_ONE_LINER", label: "Brand One-Liner", required: "required", category: "Brand & Identity" },
  { key: "SLACK_BOT_TOKEN", label: "Slack Bot Token", required: "optional", category: "Optional" },
  { key: "PLAYWRIGHT_ON_CORE", label: "Playwright on Core", required: "optional flag", category: "Optional" },
];

const CATEGORY_ORDER = ["Search & Discovery", "Email & Outreach", "Brand & Identity", "Optional"];

const COUNTRY_OPTIONS = ["UK", "IE", "FR", "EE", "PT"];

const VIEW_TABS: TabItem[] = [
  { id: "secrets", label: "Secrets" },
  { id: "settings", label: "Settings" },
];

// ─── Mock Data ───────────────────────────────────────────────────

function getMockSecretStatuses(): Record<string, boolean> {
  return {
    COMPANIES_HOUSE_KEY: true,
    BRAVE_API_KEY: true,
    BREVO_API_KEY: false,
    BREVO_SENDER_EMAIL: false,
    BREVO_SENDER_NAME: false,
    BREVO_REPLY_TO: false,
    CALENDLY_URL: false,
    BRAND_NAME: true,
    BRAND_ONE_LINER: true,
    SLACK_BOT_TOKEN: false,
    PLAYWRIGHT_ON_CORE: false,
  };
}

function getMockSettings(): SettingsState {
  return {
    paused: false,
    dryRun: true,
    sendEnabled: false,
    dailyCap: 10,
    countries: ["UK"],
    testRecipients: "",
    brandName: "Acme Corp",
    brandOneLiner: "AI-powered outreach that actually works",
    dryRunExecuted: true,
  };
}

// ─── Component ───────────────────────────────────────────────────

export const SecretsConfigView: React.FC<SecretsConfigViewProps> = () => {
  const [activeTab, setActiveTab] = useState("secrets");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", height: "100%" }}>
      <div>
        <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
          Secrets &amp; Config
        </h1>
        <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
          Manage API keys, secrets, and agent runtime settings
        </p>
      </div>

      <Tabs tabs={VIEW_TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === "secrets" && <SecretsSection />}
      {activeTab === "settings" && <SettingsSection />}
    </div>
  );
};

// ─── Secrets Section ─────────────────────────────────────────────

const SecretsSection: React.FC = () => {
  const statuses = useMemo(() => getMockSecretStatuses(), []);

  const [secrets, setSecrets] = useState<Record<string, SecretState>>(() => {
    const initial: Record<string, SecretState> = {};
    for (const s of SECRETS) {
      initial[s.key] = {
        configured: statuses[s.key] ?? false,
        value: "",
        dirty: false,
        saving: false,
      };
    }
    return initial;
  });

  const handleChange = useCallback((key: string, value: string) => {
    setSecrets((prev) => ({
      ...prev,
      [key]: { ...prev[key], value, dirty: true },
    }));
  }, []);

  const handleSave = useCallback(async (key: string) => {
    setSecrets((prev) => ({ ...prev, [key]: { ...prev[key], saving: true } }));
    await new Promise((r) => setTimeout(r, 600));
    setSecrets((prev) => ({
      ...prev,
      [key]: { configured: true, value: "", dirty: false, saving: false },
    }));
  }, []);

  const grouped = useMemo(() => {
    const groups: Record<string, SecretDef[]> = {};
    for (const cat of CATEGORY_ORDER) {
      groups[cat] = SECRETS.filter((s) => s.category === cat);
    }
    return groups;
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }}>
      {CATEGORY_ORDER.map((cat) => (
        <Card key={cat}>
          <div style={{ marginBottom: "16px" }}>
            <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
              {cat}
            </h3>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
            {grouped[cat].map((secret) => {
              const state = secrets[secret.key];
              const isRequired = secret.required === "required" || secret.required === "required for outreach";
              const showWarning = isRequired && !state.configured;

              return (
                <div
                  key={secret.key}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: "12px",
                    padding: "12px 16px",
                    borderRadius: RADIUS.md,
                    border: `1px solid ${showWarning ? STATUS_COLORS.warningBorder : COLORS.border}`,
                    backgroundColor: showWarning ? STATUS_COLORS.warningBg : COLORS.background,
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "4px" }}>
                      <span style={{ fontSize: "0.8125rem", fontWeight: 600, color: COLORS.foreground, fontFamily: "var(--font-mono)" }}>
                        {secret.key}
                      </span>
                      {state.configured ? (
                        <Badge variant="success">Configured</Badge>
                      ) : (
                        <Badge variant={isRequired ? "error" : "neutral"}>Not configured</Badge>
                      )}
                      {isRequired && <Badge variant="warning">{secret.required}</Badge>}
                      {!isRequired && secret.required !== "optional" && secret.required !== "optional flag" && (
                        <Badge variant="neutral">{secret.required}</Badge>
                      )}
                    </div>
                    <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                      {secret.label}
                    </span>
                  </div>

                  <div style={{ display: "flex", alignItems: "center", gap: "8px", flexShrink: 0 }}>
                    <input
                      type="password"
                      placeholder={state.configured ? "••••••••" : "Enter value..."}
                      value={state.value}
                      onChange={(e) => handleChange(secret.key, e.target.value)}
                      style={{
                        width: "200px",
                        height: "36px",
                        padding: "0 12px",
                        borderRadius: RADIUS.md,
                        border: `1px solid ${COLORS.border}`,
                        backgroundColor: COLORS.card,
                        color: COLORS.foreground,
                        fontSize: "0.8125rem",
                        outline: "none",
                        fontFamily: "var(--font-mono)",
                      }}
                    />
                    <Button
                      variant="primary"
                      size="sm"
                      disabled={!state.dirty || !state.value}
                      loading={state.saving}
                      onClick={() => handleSave(secret.key)}
                    >
                      Save
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      ))}
    </div>
  );
};

// ─── Settings Section ────────────────────────────────────────────

const SettingsSection: React.FC = () => {
  const { paused: globalPaused, setPaused: setGlobalPaused } = useSettingsState();
  const [settings, setSettings] = useState<SettingsState>(() => ({
    ...getMockSettings(),
    paused: globalPaused,
  }));
  const [saving, setSaving] = useState(false);
  const [confirmDryRun, setConfirmDryRun] = useState(false);
  const [saved, setSaved] = useState(false);

  const secretStatuses = useMemo(() => getMockSecretStatuses(), []);
  const brevoEmailConfigured = secretStatuses.BREVO_SENDER_EMAIL;

  const canEnableSend = settings.dryRunExecuted && brevoEmailConfigured;

  const sendDisabledReason = useMemo(() => {
    if (canEnableSend) return null;
    const reasons: string[] = [];
    if (!settings.dryRunExecuted) reasons.push("Dry run must be executed at least once");
    if (!brevoEmailConfigured) reasons.push("BREVO_SENDER_EMAIL must be configured");
    return reasons.join(". ");
  }, [canEnableSend, settings.dryRunExecuted, brevoEmailConfigured]);

  const update = useCallback(<K extends keyof SettingsState>(key: K, value: SettingsState[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
    setSaved(false);
  }, []);

  const handleToggleDryRun = useCallback(() => {
    if (settings.dryRun) {
      if (!settings.dryRunExecuted) {
        setConfirmDryRun(true);
        return;
      }
      update("dryRun", false);
    } else {
      update("dryRun", true);
    }
  }, [settings.dryRun, settings.dryRunExecuted, update]);

  const handleConfirmDryRunDisable = useCallback(() => {
    update("dryRun", false);
    setConfirmDryRun(false);
  }, [update]);

  const handleToggleSend = useCallback(() => {
    if (!canEnableSend) return;
    update("sendEnabled", !settings.sendEnabled);
  }, [canEnableSend, settings.sendEnabled, update]);

  const handleToggleCountry = useCallback(
    (country: string) => {
      const next = settings.countries.includes(country)
        ? settings.countries.filter((c) => c !== country)
        : [...settings.countries, country];
      update("countries", next);
    },
    [settings.countries, update],
  );

  const handleSave = useCallback(async () => {
    setSaving(true);
    await new Promise((r) => setTimeout(r, 600));
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }, []);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
      {/* Kill Switch */}
      <Card>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
              Kill Switch
            </h3>
            <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
              Immediately pause all crawls and email sends
            </p>
          </div>
          <ToggleSwitch
            checked={settings.paused}
            onChange={(v) => {
              update("paused", v);
              setGlobalPaused(v);
            }}
            danger
          />
        </div>
      </Card>

      {/* Agent Settings */}
      <Card>
        <div style={{ marginBottom: "16px" }}>
          <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
            Agent Settings
          </h3>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
          {/* Dry Run */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground }}>
                Dry Run Mode
              </span>
              <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, margin: "2px 0 0" }}>
                Process leads without actually sending emails
              </p>
            </div>
            <ToggleSwitch checked={settings.dryRun} onChange={handleToggleDryRun} />
          </div>

          {/* Send Enabled */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
              <div>
                <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground }}>
                  Enable Sending
                </span>
                <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, margin: "2px 0 0" }}>
                  Allow the agent to send real emails
                </p>
              </div>
              {!canEnableSend && (
                <Tooltip content={sendDisabledReason} side="top">
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: "18px",
                      height: "18px",
                      borderRadius: RADIUS.full,
                      backgroundColor: STATUS_COLORS.warningBg,
                      color: STATUS_COLORS.warning,
                      fontSize: "0.6875rem",
                      fontWeight: 700,
                      cursor: "help",
                    }}
                  >
                    ?
                  </span>
                </Tooltip>
              )}
            </div>
            <ToggleSwitch
              checked={settings.sendEnabled}
              onChange={handleToggleSend}
              disabled={!canEnableSend}
            />
          </div>

          {/* Daily Cap */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <div>
              <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground }}>
                Daily Cap
              </span>
              <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, margin: "2px 0 0" }}>
                Maximum emails sent per day
              </p>
            </div>
            <input
              type="number"
              min={1}
              max={500}
              value={settings.dailyCap}
              onChange={(e) => update("dailyCap", Math.max(1, parseInt(e.target.value, 10) || 10))}
              style={{
                width: "80px",
                height: "36px",
                padding: "0 12px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.card,
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                textAlign: "center",
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
          </div>

          {/* Countries */}
          <div>
            <span style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, display: "block", marginBottom: "8px" }}>
              Target Countries
            </span>
            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              {COUNTRY_OPTIONS.map((country) => {
                const selected = settings.countries.includes(country);
                return (
                  <button
                    key={country}
                    onClick={() => handleToggleCountry(country)}
                    style={{
                      padding: "6px 14px",
                      borderRadius: RADIUS.md,
                      border: `1px solid ${selected ? COLORS.primary : COLORS.border}`,
                      backgroundColor: selected ? COLORS.primary : COLORS.card,
                      color: selected ? COLORS.primaryForeground : COLORS.foreground,
                      fontSize: "0.8125rem",
                      fontWeight: 500,
                      cursor: "pointer",
                      transition: "all 150ms ease",
                    }}
                  >
                    {country}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Test Recipients */}
          <div>
            <label
              style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}
            >
              Test Recipients
            </label>
            <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, margin: "0 0 8px" }}>
              Comma-separated email addresses for dry-run testing
            </p>
            <input
              type="text"
              placeholder="test@example.com, qa@example.com"
              value={settings.testRecipients}
              onChange={(e) => update("testRecipients", e.target.value)}
              style={{
                width: "100%",
                height: "36px",
                padding: "0 12px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.card,
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                outline: "none",
                fontFamily: "var(--font-mono)",
              }}
            />
          </div>

          {/* Brand Name */}
          <div>
            <label
              style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}
            >
              Brand Name
            </label>
            <input
              type="text"
              value={settings.brandName}
              onChange={(e) => update("brandName", e.target.value)}
              style={{
                width: "100%",
                height: "36px",
                padding: "0 12px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.card,
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                outline: "none",
              }}
            />
          </div>

          {/* Brand One-Liner */}
          <div>
            <label
              style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}
            >
              Brand One-Liner
            </label>
            <input
              type="text"
              value={settings.brandOneLiner}
              onChange={(e) => update("brandOneLiner", e.target.value)}
              style={{
                width: "100%",
                height: "36px",
                padding: "0 12px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.card,
                color: COLORS.foreground,
                fontSize: "0.8125rem",
                outline: "none",
              }}
            />
          </div>
        </div>

        {/* Save */}
        <div style={{ display: "flex", alignItems: "center", gap: "12px", marginTop: "24px", paddingTop: "16px", borderTop: `1px solid ${COLORS.border}` }}>
          <Button variant="primary" size="sm" loading={saving} onClick={handleSave}>
            Save Settings
          </Button>
          {saved && (
            <span style={{ fontSize: "0.8125rem", color: STATUS_COLORS.success, fontWeight: 500 }}>
              Settings saved
            </span>
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={confirmDryRun}
        onClose={() => setConfirmDryRun(false)}
        onConfirm={handleConfirmDryRunDisable}
        title="Disable Dry Run?"
        message="Disabling dry run means the agent will begin processing real leads. Make sure you've reviewed the pipeline output first. This action cannot be undone for the current run."
        confirmLabel="Disable Dry Run"
        destructive
      />
    </div>
  );
};

// ─── Toggle Switch ───────────────────────────────────────────────

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}

const ToggleSwitch: React.FC<ToggleSwitchProps> = ({ checked, onChange, disabled, danger }) => {
  const trackColor = disabled
    ? COLORS.muted
    : checked
      ? danger
        ? COLORS.destructive
        : STATUS_COLORS.success
      : COLORS.muted;

  return (
    <button
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => !disabled && onChange(!checked)}
      style={{
        position: "relative",
        width: "44px",
        height: "24px",
        borderRadius: RADIUS.full,
        backgroundColor: trackColor,
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        transition: "background-color 200ms ease",
        opacity: disabled ? 0.5 : 1,
        flexShrink: 0,
        padding: 0,
      }}
    >
      <span
        style={{
          position: "absolute",
          top: "2px",
          left: checked ? "22px" : "2px",
          width: "20px",
          height: "20px",
          borderRadius: RADIUS.full,
          backgroundColor: "#fff",
          boxShadow: "0 1px 3px rgba(0,0,0,0.2)",
          transition: "left 200ms ease",
        }}
      />
    </button>
  );
};
