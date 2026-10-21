/**
 * NewSkillDialog
 * ──────────────
 * Create-skill form: slug name with live SKILL_NAME_RE validation (+ local
 * duplicate check; the brain's 409 also surfaces inline), description, and
 * an instructions template prefill. Create → POST /skills/:agentId → toast
 * → parent selects the new skill.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Loader2, Plus } from "lucide-react";
import type { SkillRecord } from "@calla/shared";
import { SKILL_NAME_RE } from "@calla/shared";
import { Button, Dialog, Input, Textarea } from "@/components/ui";
import { skillsClient } from "@/lib/skills-client";
import { toast } from "@/hooks/useToast";

export interface NewSkillDialogProps {
  open: boolean;
  agentId: string;
  /** Existing skill names — used for the client-side duplicate hint. */
  existingNames: string[];
  onClose: () => void;
  /** Called with the created record (parent selects it + refetches). */
  onCreated: (skill: SkillRecord) => void;
}

function instructionsTemplate(name: string): string {
  const title = name.trim() ? name.trim() : "skill-name";
  return `# ${title}\n\nWhen to use:\n\nSteps:\n`;
}

export const NewSkillDialog: React.FC<NewSkillDialogProps> = ({
  open,
  agentId,
  existingNames,
  onClose,
  onCreated,
}) => {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [instructions, setInstructions] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);

  // Reset the form each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName("");
      setDescription("");
      setInstructions(instructionsTemplate(""));
      setTouched(false);
      setServerError(null);
    }
  }, [open]);

  const nameError = useMemo(() => {
    const slug = name.trim();
    if (!slug) return "Name is required.";
    if (slug.length > 64) return "Name must be 64 characters or fewer.";
    if (!SKILL_NAME_RE.test(slug)) {
      return "Lowercase letters, numbers and hyphens only (e.g. weekly-report).";
    }
    if (existingNames.includes(slug)) return `A skill named "${slug}" already exists.`;
    return null;
  }, [name, existingNames]);

  const canCreate = !nameError && description.trim().length > 0 && !busy;

  const handleCreate = async () => {
    if (!canCreate) return;
    setBusy(true);
    setServerError(null);
    try {
      const skill = await skillsClient.createSkill(agentId, {
        name: name.trim(),
        description: description.trim(),
        instructions,
      });
      toast.success(`Skill "${skill.name}" created (v${skill.version})`);
      onCreated(skill);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      if (/409|already exists|duplicate/i.test(message)) {
        setServerError(`A skill named "${name.trim()}" already exists on this agent.`);
      } else {
        setServerError(message);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="New skill"
      description={`Adds a markdown skill file to the brain agent "${agentId}".`}
      footer={
        <>
          <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={() => void handleCreate()} disabled={!canCreate}>
            {busy ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Plus className="size-4" />
            )}
            Create skill
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3 pb-2">
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-skill-name"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Name (slug)
          </label>
          <Input
            id="new-skill-name"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              setTouched(true);
            }}
            onBlur={() => setTouched(true)}
            placeholder="weekly-report"
            className="font-mono"
            aria-invalid={touched && !!nameError}
            aria-describedby={touched && nameError ? "new-skill-name-error" : undefined}
            disabled={busy}
          />
          {touched && nameError && (
            <p id="new-skill-name-error" className="text-xs text-destructive" role="alert">
              {nameError}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-skill-description"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Description
          </label>
          <Input
            id="new-skill-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What the skill does / when the agent should use it"
            disabled={busy}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor="new-skill-instructions"
            className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
          >
            Instructions (markdown)
          </label>
          <Textarea
            id="new-skill-instructions"
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
            className="min-h-[160px] resize-y font-mono text-xs"
            spellCheck={false}
            disabled={busy}
          />
        </div>

        {serverError && (
          <p className="rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive" role="alert">
            {serverError}
          </p>
        )}
      </div>
    </Dialog>
  );
};

NewSkillDialog.displayName = "NewSkillDialog";
