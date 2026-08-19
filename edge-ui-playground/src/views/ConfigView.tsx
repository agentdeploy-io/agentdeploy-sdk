/**
 * ConfigView Component
 * ────────────────────
 * Global configuration: prompts, models, environment variables,
 * and secrets management.
 *
 * Data availability:
 *   Real Cloudflare Agents configuration lives in wrangler.toml /
 *   wrangler.jsonc per-agent and in the agent source code. The
 *   Edge Console is a read-only client that introspects agent
 *   backends via the /health endpoint. There is no central write
 *   API for prompts, models, or secrets — those are managed via
 *   `wrangler secret put`, dashboard, or source control.
 *
 *   Each section therefore shows an honest empty state explaining
 *   where the real data lives.
 *
 * Layout (from edge.pen mockup DjCfF):
 *   ┌─────────────────────────────────────────────┐
 *   │ "Configuration" title                       │
 *   ├──────────┬──────────┬───────────────────────┤
 *   │ Prompts  │ Models   │ Secrets & Env Vars    │
 *   │ (list)   │ (list)   │ (list)                │
 *   └──────────────────────────────────────────────┘
 */

import React from "react";
import { Card, Badge, Button, Tabs, Textarea } from "../components/ui";
import { EmptyState } from "../components/shared";
import { COLORS, RADIUS } from "../constants/theme";
import { AGENTS } from "../constants/agents";
import { useAgentInfo } from "../hooks/useAgentInfo";
import type { AgentRegistryEntry } from "../constants/agents";

// ─── Props ───────────────────────────────────────────────────────

export interface ConfigViewProps {}

// ─── Component ───────────────────────────────────────────────────

export const ConfigView: React.FC<ConfigViewProps> = () => {
  const [activeSection, setActiveSection] = React.useState("prompts");

  const sections = [
    { id: "prompts", label: "Prompts" },
    { id: "models", label: "Models" },
    { id: "secrets", label: "Secrets" },
    { id: "bindings", label: "Bindings" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "24px" }} className="fade-in">
      {/* ─── Header ───────────────────────────────────────────── */}
      <div>
        <h1 style={{ fontSize: "1.5rem", fontWeight: 700, color: COLORS.foreground, marginBottom: "4px" }}>
          Configuration
        </h1>
        <p style={{ fontSize: "0.875rem", color: COLORS.mutedForeground }}>
          Prompts, models, secrets, and resource bindings live in agent source code
        </p>
      </div>

      {/* ─── Section Tabs ────────────────────────────────────── */}
      <Tabs tabs={sections} activeTab={activeSection} onChange={setActiveSection} variant="pills" />

      {/* ─── Section Content ─────────────────────────────────── */}
      {activeSection === "prompts" && <PromptsSection />}
      {activeSection === "models" && <ModelsSection />}
      {activeSection === "secrets" && <SecretsSection />}
      {activeSection === "bindings" && <BindingsSection />}
    </div>
  );
};

// ─── Prompts Section ─────────────────────────────────────────────
//
// System prompts are defined in each agent's source code. The
// textarea here is a local scratchpad for drafting prompts; it
// persists to localStorage so users can iterate without losing work.
// Saving the final prompt requires editing the agent source.

const PromptsSection: React.FC = () => {
  const [systemPrompt, setSystemPrompt] = React.useState(
    () => localStorage.getItem("edge-draft-system-prompt") ??
      "You are a helpful AI assistant. Provide accurate, concise answers. If you're unsure, say so rather than guessing.",
  );
  const [hasChanges, setHasChanges] = React.useState(false);

  const handleSave = () => {
    localStorage.setItem("edge-draft-system-prompt", systemPrompt);
    setHasChanges(false);
  };

  return (
    <Card>
      <Card.Header
        title="System Prompt (Draft)"
        subtitle="Local scratchpad — edit agent source to apply changes in production"
        actions={
          <Button variant="primary" size="sm" disabled={!hasChanges} onClick={handleSave}>
            Save Draft
          </Button>
        }
      />
      <Textarea
        value={systemPrompt}
        onChange={(e) => {
          setSystemPrompt(e.target.value);
          setHasChanges(true);
        }}
        label="Prompt Template"
        description="Use {{variable}} syntax for dynamic values. This draft lives in localStorage only."
        style={{ minHeight: "160px" }}
      />
      <div style={{ marginTop: "16px" }}>
        <h4 style={{ fontSize: "0.8125rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "8px" }}>
          Available Variables
        </h4>
        <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
          {["{{agent_name}}", "{{user_name}}", "{{conversation_id}}", "{{timestamp}}"].map((v) => (
            <Badge key={v} variant="neutral">
              {v}
            </Badge>
          ))}
        </div>
      </div>
    </Card>
  );
};

// ─── Models Section ──────────────────────────────────────────────
//
// Each agent reports its model via the /health endpoint. The
// ModelsSection shows the real per-agent model pulled from live
// health data, not a hardcoded list.

const ModelsSection: React.FC = () => {
  const agents = AGENTS;

  return (
    <Card padding="none">
      <div style={{ padding: "20px 20px 0" }}>
        <Card.Header
          title="Per-Agent Models"
          subtitle="Model identifiers reported by each agent's /health endpoint"
        />
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {agents.map((agent, i) => (
          <ModelRow key={agent.id} agent={agent} isLast={i === agents.length - 1} />
        ))}
      </div>
    </Card>
  );
};

const ModelRow: React.FC<{ agent: AgentRegistryEntry; isLast: boolean }> = ({ agent, isLast }) => {
  const { info, loading, error } = useAgentInfo(agent);

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "16px",
        padding: "12px 20px",
        borderBottom: isLast ? "none" : `1px solid ${COLORS.border}`,
      }}
    >
      <div
        style={{
          width: "36px",
          height: "36px",
          borderRadius: RADIUS.md,
          backgroundColor: COLORS.secondary,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          fontSize: "1rem",
          flexShrink: 0,
        }}
      >
        {agent.icon}
      </div>
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: "0.875rem", fontWeight: 500, color: COLORS.foreground }}>
          {agent.name}
        </div>
        <div style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, fontFamily: "var(--font-mono)" }}>
          {loading
            ? "loading…"
            : error
              ? "unreachable"
              : info?.model
                ? info.model
                : "model not reported"}
        </div>
      </div>
      {error ? (
        <Badge variant="error" dot>
          Offline
        </Badge>
      ) : info?.model ? (
        <Badge variant="success">In Use</Badge>
      ) : loading ? (
        <Badge variant="info">Checking…</Badge>
      ) : (
        <Badge variant="neutral">Unknown</Badge>
      )}
    </div>
  );
};

// ─── Secrets Section ─────────────────────────────────────────────
//
// Secrets are managed via `wrangler secret put` per agent — there
// is no central secrets API. The section explains this honestly.

const SecretsSection: React.FC = () => {
  // Required secrets derived from agent capabilities (informational only).
  const requiredSecrets = React.useMemo(() => {
    const map = new Map<string, string[]>();
    map.set("OPENAI_API_KEY", ["support", "sales"]);
    map.set("ANTHROPIC_API_KEY", []);
    map.set("POLYMARKET_API_KEY", ["polymarket-intel"]);
    map.set("GMAIL_OAUTH_TOKEN", ["gmail-invoices"]);
    return map;
  }, []);

  return (
    <Card>
      <Card.Header
        title="Secrets & Environment Variables"
        subtitle="Managed per-agent via `wrangler secret put` — values never reach this console"
      />
      <EmptyState
        icon="🔐"
        title="Secrets Are Not Stored Here"
        message="Cloudflare Agents secrets are encrypted at rest and stored in the Workers runtime — they are never exposed to any client, including this console. Use `wrangler secret put KEY` in each agent's directory to set or update values."
      />
      <div style={{ marginTop: "8px", padding: "0 20px 20px" }}>
        <h4 style={{ fontSize: "0.8125rem", fontWeight: 600, color: COLORS.foreground, marginBottom: "8px" }}>
          Required Keys (informational)
        </h4>
        <div style={{ display: "flex", flexDirection: "column", gap: "8px" }}>
          {Array.from(requiredSecrets.entries()).map(([key, consumers]) => (
            <div
              key={key}
              style={{
                display: "flex",
                alignItems: "center",
                gap: "10px",
                padding: "10px 12px",
                borderRadius: RADIUS.md,
                border: `1px solid ${COLORS.border}`,
                backgroundColor: COLORS.secondary,
              }}
            >
              <code style={{ fontSize: "0.8125rem", color: COLORS.foreground }}>{key}</code>
              <div style={{ flex: 1 }} />
              {consumers.length === 0 ? (
                <span style={{ fontSize: "0.75rem", color: COLORS.mutedForeground }}>
                  optional
                </span>
              ) : (
                consumers.map((id) => (
                  <Badge key={id} variant="neutral">
                    {id}
                  </Badge>
                ))
              )}
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

// ─── Bindings Section ────────────────────────────────────────────

const BindingsSection: React.FC = () => (
  <Card>
    <Card.Header
      title="Resource Bindings"
      subtitle="KV namespaces, Durable Objects, R2 buckets, and D1 databases"
    />
    <EmptyState
      icon="🔗"
      title="Bindings Live in wrangler.toml"
      message="Resource bindings (KV, DO, R2, D1, Queues) are declared in each agent's wrangler configuration. They cannot be added or modified at runtime from this console. Inspect each agent's wrangler.toml or run `wrangler deploy --dry-run` to see effective bindings."
    />
  </Card>
);
