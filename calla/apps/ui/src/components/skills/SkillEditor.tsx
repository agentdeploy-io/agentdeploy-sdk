/**
 * SkillEditor
 * ───────────
 * Card-based markdown editor for a single SkillRecord.
 *
 * Tracks a dirty draft against the loaded record (description + instructions).
 * Save → skillsClient.upsertSkill (version bumps) → toast; Revert discards the
 * draft; Delete (uploaded only) confirms via Dialog then skillsClient.deleteSkill.
 *
 * Built-in skills are editable but NOT deletable (brain returns 400) — the
 * Delete button is disabled with an explanatory tooltip instead.
 *
 * Fully controlled by the parent (SkillsTab) for the record + mutation
 * side-effects; owns only the draft text state.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, RotateCcw, Save, Trash2 } from "lucide-react";
import type { SkillRecord } from "@calla/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  Input,
  Textarea,
  Dialog,
} from "@/components/ui";
import { skillsClient } from "@/lib/skills-client";
import { relativeTime } from "@/lib/utils";
import { toast } from "@/hooks/useToast";

export interface SkillEditorProps {
  skill: SkillRecord;
  /** Called after a successful save/delete so the parent can refetch. */
  onChanged: () => void;
  /** Called after a successful delete (parent clears selection). */
  onDeleted?: () => void;
  disabled?: boolean;
}

export const SkillEditor: React.FC<SkillEditorProps> = ({
  skill,
  onChanged,
  onDeleted,
  disabled,
}) => {
  const [description, setDescription] = useState(skill.description);
  const [instructions, setInstructions] = useState(skill.instructions);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  // Reload the draft whenever a different record (or a newer version of the
  // same skill after save) is selected. Keyed on id + version + updatedAt so a
  // refetch that bumps the version resets the editor to the saved state.
  useEffect(() => {
    setDescription(skill.description);
    setInstructions(skill.instructions);
  }, [skill.id, skill.version, skill.updatedAt, skill.description, skill.instructions]);

  const dirty = useMemo(
    () =>
      description !== skill.description || instructions !== skill.instructions,
    [description, instructions, skill.description, skill.instructions],
  );

  const isBuiltin = skill.source === "builtin";

  const handleSave = async () => {
    if (!dirty || busy) return;
    setBusy(true);
    try {
      const updated = await skillsClient.upsertSkill(skill.agentId, skill.name, {
        description,
        instructions,
      });
      toast.success(`Skill saved (v${updated.version}) — applied to new runs`);
      onChanged();
    } catch (err) {
      toast.error("Couldn't save skill", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  const handleRevert = () => {
    setDescription(skill.description);
    setInstructions(skill.instructions);
  };

  const handleDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await skillsClient.deleteSkill(skill.agentId, skill.name);
      toast.success(`Skill "${skill.name}" deleted`);
      setConfirmDelete(false);
      onChanged();
      onDeleted?.();
    } catch (err) {
      toast.error("Couldn't delete skill", err instanceof Error ? err.message : "Unknown error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card className="p-0">
      <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate font-mono text-sm font-medium text-foreground">
            {skill.name}
          </span>
          <Badge variant={isBuiltin ? "info" : "secondary"}>
            {skill.source}
          </Badge>
          <Badge variant="muted" className="font-mono font-normal">
            v{skill.version}
          </Badge>
          <span className="text-[0.6875rem] text-faint">
            updated {relativeTime(skill.updatedAt)}
          </span>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRevert}
            disabled={!dirty || busy || disabled}
            title="Discard changes"
          >
            <RotateCcw className="size-4" />
            Revert
          </Button>
          <Button
            variant="default"
            size="sm"
            onClick={() => void handleSave()}
            disabled={!dirty || busy || disabled}
          >
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
          <span
            title={
              isBuiltin ? "Built-in skills can be edited, not deleted" : undefined
            }
            className="inline-flex"
          >
            <Button
              variant="destructive"
              size="sm"
              onClick={() => setConfirmDelete(true)}
              disabled={isBuiltin || busy || disabled}
              aria-label={
                isBuiltin
                  ? "Built-in skills can be edited, not deleted"
                  : `Delete skill ${skill.name}`
              }
            >
              <Trash2 className="size-4" />
            </Button>
          </span>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`skill-desc-${skill.id}`}
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Description
          </label>
          <Input
            id={`skill-desc-${skill.id}`}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this skill does / when to use it"
            disabled={busy || disabled}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={`skill-instr-${skill.id}`}
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Instructions (markdown)
          </label>
          <Textarea
            id={`skill-instr-${skill.id}`}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-[320px] resize-y font-mono text-xs"
            spellCheck={false}
            disabled={busy || disabled}
          />
          <p className="text-[0.6875rem] text-muted-foreground">
            YAML frontmatter (--- key: value ---) is parsed into skill metadata.
          </p>
        </div>

        {dirty && (
          <p className="text-[0.6875rem] text-warning">
            Unsaved changes — save to bump the version and apply to new runs.
          </p>
        )}
      </CardContent>

      <Dialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title={`Delete skill "${skill.name}"?`}
        description="This removes the skill from the agent's stack. Runs already in flight keep their resolved behavior; new runs won't see it."
        footer={
          <>
            <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={() => void handleDelete()}
              disabled={busy}
            >
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Trash2 className="size-4" />
              )}
              Delete
            </Button>
          </>
        }
      />
    </Card>
  );
};

SkillEditor.displayName = "SkillEditor";
