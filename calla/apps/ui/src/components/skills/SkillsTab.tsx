/**
 * SkillsTab
 * ─────────
 * The Skills tab of AgentDetail: the multi-tenant behavior console.
 *
 *   Left rail   — InstructionsCard (agent persona / instructions.md) over
 *                 the skill list (source dot + version, selected ring) and
 *                 a "New skill" button.
 *   Right       — SkillEditor for the selected skill (or an empty state).
 *   Bottom      — collapsible Test panel: runs POST /agents/:id/generate
 *                 against the latest saved instructions + skills and renders
 *                 the markdown response inline.
 *
 * Data is plain useState/useEffect: skills + configs are fetched on mount and
 * refetched after every mutation (onChanged). When the brain is disabled
 * (BRAIN_URL unset/"none") or unreachable, the tab degrades to an EmptyState
 * with Retry — it never throws into the page.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  BookOpen,
  ChevronRight,
  Loader2,
  Play,
  Plus,
  RefreshCw,
} from "lucide-react";
import type { AgentConfigRecord, SkillRecord } from "@calla/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Skeleton,
  Textarea,
} from "@/components/ui";
import { EmptyState } from "@/components/shared";
import { InstructionsCard } from "./InstructionsCard";
import { SkillEditor } from "./SkillEditor";
import { NewSkillDialog } from "./NewSkillDialog";
import { skillsClient } from "@/lib/skills-client";
import { mastraClient } from "@/lib/mastra-client";
import { renderMarkdown } from "@/lib/markdown";
import { cn } from "@/lib/utils";
import { toast } from "@/hooks/useToast";

export interface SkillsTabProps {
  agentId: string;
  /** Optional muted hint line under the header (e.g. edge-runtime caveat). */
  hint?: string;
  className?: string;
}

interface TestResult {
  text?: string;
  finishReason?: string;
  error?: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export const SkillsTab: React.FC<SkillsTabProps> = ({ agentId, hint, className }) => {
  const [skills, setSkills] = useState<SkillRecord[]>([]);
  const [configs, setConfigs] = useState<AgentConfigRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);

  // ─── Data loading ──────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillList, configList] = await Promise.all([
        skillsClient.listSkills(agentId),
        skillsClient.listConfigs(),
      ]);
      setSkills(skillList);
      setConfigs(configList);
      setSelected((prev) =>
        prev && skillList.some((s) => s.name === prev)
          ? prev
          : (skillList[0]?.name ?? null),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      setError(message);
      toast.error("Couldn't load skills", message);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    if (!skillsClient.enabled) {
      setLoading(false);
      return;
    }
    void load();
  }, [load, agentId]);

  const config = useMemo(
    () => configs.find((c) => c.agentId === agentId) ?? null,
    [configs, agentId],
  );
  const selectedSkill = useMemo(
    () => skills.find((s) => s.name === selected) ?? null,
    [skills, selected],
  );

  // ─── Brain disabled / load failure ─────────────────────────────
  if (!skillsClient.enabled) {
    return (
      <EmptyState
        icon="🧠"
        title="Brain not connected"
        message="Set BRAIN_URL to connect the Mastra brain. Skills and agent instructions live in the brain's store — until it's reachable this tab stays dark."
        action={{ label: "Retry", onClick: () => void load() }}
        className={className}
      />
    );
  }

  if (error && !loading && skills.length === 0) {
    return (
      <EmptyState
        icon="⚠️"
        title="Brain not connected"
        message={`${error} The brain may be down or your session expired.`}
        action={{ label: "Retry", onClick: () => void load() }}
        className={className}
      />
    );
  }

  return (
    <div className={cn("flex flex-col gap-4", className)}>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[280px_1fr]">
        {/* ─── Left rail ──────────────────────────────────────────── */}
        <div className="flex min-w-0 flex-col gap-4">
          <InstructionsCard
            agentId={agentId}
            config={config}
            loading={loading}
            onChanged={() => void load()}
          />

          <Card className="flex min-w-0 flex-col p-0">
            <CardHeader className="flex-row items-center justify-between gap-2 border-b border-border py-3">
              <CardTitle className="flex items-center gap-1.5 text-sm">
                <BookOpen className="size-3.5 text-muted-foreground" aria-hidden />
                Skills
              </CardTitle>
              <Badge variant="muted" className="font-normal">
                {loading ? "…" : skills.length}
              </Badge>
            </CardHeader>

            <CardContent className="flex flex-col gap-2 p-3">
              {loading ? (
                <>
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                  <Skeleton className="h-10 w-full" />
                </>
              ) : skills.length === 0 ? (
                <p className="px-1 py-4 text-center text-xs text-muted-foreground">
                  No skills yet — create one or seed from the builtin stack.
                </p>
              ) : (
                <ul className="flex flex-col gap-1">
                  {skills.map((s) => {
                    const active = s.name === selected;
                    return (
                      <li key={s.id}>
                        <button
                          type="button"
                          onClick={() => setSelected(s.name)}
                          aria-current={active}
                          className={cn(
                            "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors",
                            active
                              ? "bg-surface-hover ring-1 ring-ring"
                              : "hover:bg-surface-hover/60",
                          )}
                        >
                          <span
                            className={cn(
                              "inline-block size-2 shrink-0 rounded-full",
                              s.source === "builtin" ? "bg-info" : "bg-success",
                            )}
                            title={s.source}
                            aria-label={s.source}
                          />
                          <span className="min-w-0 flex-1 truncate font-mono text-xs text-body">
                            {s.name}
                          </span>
                          <span className="shrink-0 text-[0.6875rem] text-faint">
                            v{s.version}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}

              <Button
                variant="outline"
                size="sm"
                className="mt-1 w-full"
                onClick={() => setNewOpen(true)}
                disabled={loading}
              >
                <Plus className="size-4" />
                New skill
              </Button>
            </CardContent>
          </Card>
        </div>

        {/* ─── Right: editor ──────────────────────────────────────── */}
        <div className="min-w-0">
          {loading ? (
            <Card className="p-0">
              <CardContent className="flex flex-col gap-3 p-4">
                <Skeleton className="h-8 w-2/3" />
                <Skeleton className="h-[320px] w-full" />
              </CardContent>
            </Card>
          ) : selectedSkill ? (
            <SkillEditor
              key={`${selectedSkill.id}:${selectedSkill.version}`}
              skill={selectedSkill}
              onChanged={() => void load()}
              onDeleted={() => setSelected(null)}
            />
          ) : skills.length === 0 ? (
            <EmptyState
              icon={<BookOpen className="size-10 text-muted-foreground" />}
              title="No skills yet"
              message="Create one or seed from the builtin stack — skills are markdown files the brain resolves into agent behavior at run time."
              action={{ label: "New skill", onClick: () => setNewOpen(true) }}
            />
          ) : (
            <EmptyState
              icon={<BookOpen className="size-10 text-muted-foreground" />}
              title="Select a skill"
              message="Pick a skill from the list to view and edit its description and markdown instructions."
            />
          )}
        </div>
      </div>

      {/* ─── Test panel ───────────────────────────────────────────── */}
      <TestPanel agentId={agentId} />

      <NewSkillDialog
        open={newOpen}
        agentId={agentId}
        existingNames={skills.map((s) => s.name)}
        onClose={() => setNewOpen(false)}
        onCreated={(skill) => {
          setNewOpen(false);
          setSelected(skill.name);
          void load();
        }}
      />
    </div>
  );
};

SkillsTab.displayName = "SkillsTab";

// ─── Test panel ──────────────────────────────────────────────────

const TestPanel: React.FC<{ agentId: string }> = ({ agentId }) => {
  const [message, setMessage] = useState("");
  const [running, setRunning] = useState(false);
  const [result, setResult] = useState<TestResult | null>(null);

  const run = async () => {
    const content = message.trim();
    if (!content || running) return;
    setRunning(true);
    setResult(null);
    try {
      const resp = await mastraClient.generate(agentId, {
        messages: [{ role: "user", content }],
      });
      const rec = asRecord(resp);
      const steps = Array.isArray(rec.steps) ? rec.steps : [];
      const lastStep = asRecord(steps[steps.length - 1]);
      setResult({
        text: str(rec.text),
        finishReason: str(rec.finishReason) ?? str(lastStep.finishReason),
      });
    } catch (err) {
      setResult({
        error: err instanceof Error ? err.message : "Unknown error",
      });
    } finally {
      setRunning(false);
    }
  };

  return (
    <Card className="p-0">
      <details>
        <summary className="group flex cursor-pointer select-none list-none items-center gap-2 px-4 py-3 text-sm font-medium text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight
            className="size-4 text-muted-foreground transition-transform group-open:rotate-90"
            aria-hidden
          />
          <Play className="size-3.5 text-muted-foreground" aria-hidden />
          Test this agent with current behavior
          <span className="ml-auto text-[0.6875rem] font-normal text-muted-foreground">
            Runs use the latest saved instructions + skills
          </span>
        </summary>

        <CardContent className="flex flex-col gap-3 border-t border-border p-4">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor="skills-test-message"
              className="text-[0.6875rem] uppercase tracking-wide text-muted-foreground"
            >
              Message
            </label>
            <Textarea
              id="skills-test-message"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Ask the agent something that should exercise the edited behavior…"
              className="min-h-[80px] resize-y text-sm"
              disabled={running}
            />
          </div>

          <div className="flex items-center gap-2">
            <Button
              size="sm"
              onClick={() => void run()}
              disabled={!message.trim() || running || !mastraClient.enabled}
            >
              {running ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <Play className="size-4" />
              )}
              {running ? "Running…" : "Run"}
            </Button>
            {!mastraClient.enabled && (
              <span className="text-xs text-muted-foreground">
                Brain not connected — set BRAIN_URL to run tests.
              </span>
            )}
            <span className="ml-auto flex items-center gap-1 text-[0.6875rem] text-muted-foreground">
              <RefreshCw className="size-3" aria-hidden />
              POST /agents/{agentId}/generate
            </span>
          </div>

          {running && (
            <div className="flex items-center gap-2 rounded-lg border border-border bg-surface-canvas px-3 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Waiting for the brain to finish the run…
            </div>
          )}

          {result?.error && (
            <p
              className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive"
              role="alert"
            >
              {result.error}
            </p>
          )}

          {result && !result.error && (
            <div className="rounded-lg border border-border bg-surface-canvas p-3">
              {result.finishReason && (
                <div className="mb-2 flex items-center gap-2">
                  <Badge
                    variant={result.finishReason === "stop" ? "success" : "muted"}
                    className="font-normal"
                  >
                    {result.finishReason}
                  </Badge>
                </div>
              )}
              {result.text ? (
                <div
                  className="chat-markdown break-words text-sm text-body"
                  dangerouslySetInnerHTML={{ __html: renderMarkdown(result.text) }}
                />
              ) : (
                <p className="text-xs text-muted-foreground">
                  The run produced no text output.
                </p>
              )}
            </div>
          )}
        </CardContent>
      </details>
    </Card>
  );
};
