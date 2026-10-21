/**
 * InstructionsCard
 * ────────────────
 * The agent persona editor — the per-tenant "instructions.md" hot-swap
 * surface. Loads its AgentConfigRecord from the parent (SkillsTab fetches
 * listConfigs()); when the agent has no brain config yet, shows a create
 * flow (Dialog form → POST /agents/configs).
 *
 * Save → PUT /agents/configs/:agentId → version bump → toast. The brain
 * hot-applies changes: no restart, effective for new runs immediately.
 */

import React, { useEffect, useMemo, useState } from "react";
import { FileText, Loader2, Plus, Save } from "lucide-react";
import type { AgentConfigRecord } from "@calla/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Dialog,
  Input,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { skillsClient } from "@/lib/skills-client";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/hooks/useToast";

export interface InstructionsCardProps {
  agentId: string;
  /** Matching config from listConfigs(), or null when the agent has none. */
  config: AgentConfigRecord | null;
  /** Configs still loading — render a skeleton instead of the create state. */
  loading?: boolean;
  /** Refetch configs after a create/update mutation. */
  onChanged: () => void;
}

const DEFAULT_INSTRUCTIONS =
  "# Persona\n\nWho this agent is, its tone, and its boundaries.\n";

export const InstructionsCard: React.FC<InstructionsCardProps> = ({
  agentId,
  config,
  loading,
  onChanged,
}) => {
  const [createOpen, setCreateOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  // ─── Draft state (edit mode) ───────────────────────────────────
  const [name, setName] = useState(config?.name ?? "");
  const [description, setDescription] = useState(config?.description ?? "");
  const [instructions, setInstructions] = useState(config?.instructions ?? "");
  const [enabled, setEnabled] = useState(config?.enabled ?? true);

  useEffect(() => {
    setName(config?.name ?? "");
    setDescription(config?.description ?? "");
    setInstructions(config?.instructions ?? "");
    setEnabled(config?.enabled ?? true);
  }, [config?.agentId, config?.version, config?.updatedAt]);

  const dirty = useMemo(
    () =>
      !!config &&
      (name !== config.name ||
        description !== (config.description ?? "") ||
        instructions !== config.instructions ||
        enabled !== config.enabled),
    [config, name, description, instructions, enabled],
  );

  const handleSave = async () => {
    if (!config || !dirty || busy) return;
    setBusy(true);
    try {
      const updated = await skillsClient.updateConfig(agentId, {
        name,
        description,
        instructions,
        enabled,
      });
      toast.success(
        `Instructions saved (v${updated.version}) — applied to new runs`,
      );
      onChanged();
    } catch (err) {
      toast.error(
        "Couldn't save instructions",
        err instanceof Error ? err.message : "Unknown error",
      );
    } finally {
      setBusy(false);
    }
  };

  // ─── Create mode ───────────────────────────────────────────────
  const handleCreated = (created: AgentConfigRecord) => {
    setCreateOpen(false);
    toast.success(`Brain config created for "${created.agentId}" (v${created.version})`);
    onChanged();
  };

  if (loading) {
    return (
      <Card className="p-0">
        <CardHeader className="border-b border-border py-3">
          <CardTitle className="text-sm">Instructions</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-2 p-4">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-24 w-full" />
        </CardContent>
      </Card>
    );
  }

  if (!config) {
    return (
      <>
        <Card className="p-0">
          <CardHeader className="border-b border-border py-3">
            <CardTitle className="text-sm">Instructions</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col items-start gap-2 p-4">
            <p className="text-[0.8125rem] text-muted-foreground">
              No brain config for this agent. Create one to give{" "}
              <code className="rounded bg-surface-tag px-1 py-0.5 font-mono text-xs">
                {agentId}
              </code>{" "}
              an editable persona (instructions.md) that hot-applies to new runs.
            </p>
            <Button size="sm" variant="outline" onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create config
            </Button>
          </CardContent>
        </Card>

        <CreateConfigDialog
          open={createOpen}
          agentId={agentId}
          onClose={() => setCreateOpen(false)}
          onCreated={handleCreated}
        />
      </>
    );
  }

  // ─── Edit mode ─────────────────────────────────────────────────
  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border py-3">
        <CardTitle className="flex items-center gap-1.5 text-sm">
          <FileText className="size-3.5 text-muted-foreground" aria-hidden />
          Instructions
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <Badge variant={config.enabled ? "success" : "muted"}>
            {config.enabled ? "enabled" : "disabled"}
          </Badge>
          <Badge variant="muted" className="font-mono font-normal">
            v{config.version}
          </Badge>
          <span className="text-[0.6875rem] text-faint">
            {relativeTime(config.updatedAt)}
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-4">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="config-name"
              className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
            >
              Name
            </label>
            <Input
              id="config-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              disabled={busy}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="config-description"
              className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
            >
              Description
            </label>
            <Input
              id="config-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What this agent does"
              disabled={busy}
            />
          </div>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="config-instructions"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            System instructions (markdown)
          </label>
          <Textarea
            id="config-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-[200px] resize-y font-mono text-xs"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        <label className="flex w-fit cursor-pointer items-center gap-2 text-sm text-body">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            disabled={busy}
            className="size-4 cursor-pointer rounded border-border-strong bg-input accent-primary"
            aria-label="Agent config enabled"
          />
          Enabled — the brain resolves this agent from its config
        </label>

        <div className="flex items-center justify-between gap-2">
          <p className="text-[0.6875rem] text-muted-foreground">
            {dirty
              ? "Unsaved changes — save to hot-apply to new runs."
              : "Saved state matches the brain."}
          </p>
          <Button
            size="sm"
            variant="default"
            onClick={() => void handleSave()}
            disabled={!dirty || busy}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
        </div>
      </CardContent>
    </Card>
  );
};

InstructionsCard.displayName = "InstructionsCard";

// ─── Create-config dialog ────────────────────────────────────────

const CreateConfigDialog: React.FC<{
  open: boolean;
  agentId: string;
  onClose: () => void;
  onCreated: (config: AgentConfigRecord) => void;
}> = ({ open, agentId, onClose, onCreated }) => {
  const [name, setName] = useState(agentId);
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState(DEFAULT_INSTRUCTIONS);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName(agentId);
      setDescription("");
      setInstructions(DEFAULT_INSTRUCTIONS);
      setError(null);
    }
  }, [open, agentId]);

  const valid = name.trim().length > 0 && instructions.trim().length > 0;

  const handleCreate = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await skillsClient.createConfig({
        agentId,
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
        instructions,
      });
      onCreated(created);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Create brain config"
      description={`Persona + instructions for the brain agent "${agentId}".`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={() => void handleCreate()}
            disabled={!valid || busy}
          >
            {busy && <Loader2 className="size-4 animate-spin" />}
            Create
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-config-name"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Name
          </label>
          <Input
            id="new-config-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-config-description"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Description (optional)
          </label>
          <Input
            id="new-config-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            disabled={busy}
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-config-instructions"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Instructions (markdown)
          </label>
          <Textarea
            id="new-config-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-[160px] resize-y font-mono text-xs"
            spellCheck={false}
            disabled={busy}
          />
        </div>
        {error && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
            {error}
          </p>
        )}
      </div>
    </Dialog>
  );
};
