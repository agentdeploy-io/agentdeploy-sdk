import React, { useState, useCallback, useMemo } from "react";
import { Card, Button, Badge } from "../components/ui";
import { Modal, ConfirmDialog } from "../components/ui/Modal";
import { LoadingState, EmptyState } from "../components/shared";
import { DeploymentSelector } from "../components/DeploymentSelector";
import { COLORS, RADIUS, STATUS_COLORS } from "../constants/theme";
import { useDeploymentSelector } from "../hooks/useDeploymentSelector";
import { useSchedules, useScheduleActions, type ScheduleEntry } from "../hooks/useDataApi";
import { toast } from "../hooks/useToast";
import {
  cronToHumanReadable,
  validateCron,
  getNextRun,
  CRON_PRESETS,
} from "../utils/cron";

function generateHistory(successRate: number) {
  const days: { date: string; success: number; failed: number }[] = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const total = Math.floor(Math.random() * 10) + 5;
    const success = Math.round(total * successRate);
    days.push({
      date: d.toISOString().split("T")[0],
      success,
      failed: total - success,
    });
  }
  return days;
}

export interface ScheduleManagerViewProps {}

export const ScheduleManagerView: React.FC<ScheduleManagerViewProps> = () => {
  const { deploymentId } = useDeploymentSelector();
  const { schedules, loading, error, refetch } = useSchedules(deploymentId);
  const { createOrUpdate, remove, runNow, loading: actionLoading } = useScheduleActions(deploymentId);
  const [editingSchedule, setEditingSchedule] = useState<ScheduleEntry | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<ScheduleEntry | null>(null);

  const handleToggle = useCallback(async (schedule: ScheduleEntry) => {
    const success = await createOrUpdate({ ...schedule, enabled: !schedule.enabled });
    if (success) {
      toast.success("Schedule updated", `${schedule.name} ${schedule.enabled ? "paused" : "resumed"}`);
      refetch();
    }
  }, [createOrUpdate, refetch]);

  const handleRunNow = useCallback(async (id: string) => {
    const success = await runNow(id);
    if (success) {
      toast.success("Schedule triggered", "Run started successfully");
      refetch();
    }
  }, [runNow, refetch]);

  const handleDelete = useCallback(async () => {
    if (!deleteTarget) return;
    const success = await remove(deleteTarget.id);
    if (success) {
      toast.success("Schedule deleted", `"${deleteTarget.name}" has been removed`);
      refetch();
    }
    setDeleteTarget(null);
  }, [deleteTarget, remove, refetch]);

  const handleSave = useCallback(
    async (updated: ScheduleEntry) => {
      const success = await createOrUpdate(updated);
      if (success) {
        toast.success("Schedule saved", `"${updated.name}" has been saved`);
        refetch();
      }
      setEditingSchedule(null);
      setShowCreate(false);
    },
    [createOrUpdate, refetch],
  );

  if (!deploymentId) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "20px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <div>
            <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>Schedule Manager</h1>
            <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>Manage edge DO alarms and scheduled handoffs</p>
          </div>
          <DeploymentSelector />
        </div>
        <EmptyState icon="clock" title="No deployment selected" message="Select a deployment above to manage schedules." />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "20px", height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: "1.25rem", fontWeight: 700, color: COLORS.foreground, margin: 0 }}>
            Schedule Manager
          </h1>
          <p style={{ fontSize: "0.8125rem", color: COLORS.mutedForeground, margin: "4px 0 0" }}>
            Manage edge DO alarms and scheduled handoffs
          </p>
        </div>
        <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
          <DeploymentSelector />
          <Button variant="outline" size="sm" onClick={refetch}>
            Refresh
          </Button>
          <Button variant="primary" size="sm" onClick={() => setShowCreate(true)}>
            New Schedule
          </Button>
        </div>
      </div>

      {loading ? (
        <LoadingState variant="spinner" message="Loading schedules..." height="300px" />
      ) : error ? (
        <Card>
          <div style={{ padding: "32px", textAlign: "center" }}>
            <p style={{ color: STATUS_COLORS.error, fontSize: "0.875rem", marginBottom: "12px" }}>{error}</p>
            <Button variant="outline" size="sm" onClick={refetch}>
              Try Again
            </Button>
          </div>
        </Card>
      ) : schedules.length === 0 ? (
        <EmptyState
          icon="clock"
          title="No schedules yet"
          message="Create your first schedule to automate recurring tasks."
        />
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
          {schedules.map((schedule) => (
            <ScheduleCard
              key={schedule.id}
              schedule={schedule}
              onToggle={() => handleToggle(schedule)}
              onRunNow={() => handleRunNow(schedule.id)}
              onEdit={setEditingSchedule}
              onDelete={setDeleteTarget}
            />
          ))}
        </div>
      )}

      {editingSchedule && (
        <ScheduleEditorModal
          schedule={editingSchedule}
          onClose={() => setEditingSchedule(null)}
          onSave={handleSave}
        />
      )}

      {showCreate && (
        <ScheduleEditorModal
          schedule={null}
          onClose={() => setShowCreate(false)}
          onSave={handleSave}
        />
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title="Delete Schedule"
        message={`Are you sure you want to delete "${deleteTarget?.name}"? This cannot be undone.`}
        confirmLabel="Delete"
        destructive
      />
    </div>
  );
};

interface ScheduleCardProps {
  schedule: ScheduleEntry;
  onToggle: () => void;
  onRunNow: () => void;
  onEdit: (s: ScheduleEntry) => void;
  onDelete: (s: ScheduleEntry) => void;
}

const ScheduleCard: React.FC<ScheduleCardProps> = ({ schedule, onToggle, onRunNow, onEdit, onDelete }) => {
  const nextRun = getNextRun(schedule.cron);
  const humanReadable = cronToHumanReadable(schedule.cron);
  const successRate = schedule.runCount > 0 ? (schedule.successCount / schedule.runCount) * 100 : 0;

  return (
    <Card>
      <div style={{ padding: "16px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "12px" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <h3 style={{ fontSize: "0.9375rem", fontWeight: 600, color: COLORS.foreground, margin: 0 }}>
              {schedule.name}
            </h3>
            <Badge variant={schedule.enabled ? "success" : "neutral"}>
              {schedule.enabled ? "Active" : "Paused"}
            </Badge>
            {schedule.lastStatus === "failed" && (
              <Badge variant="error">Last Failed</Badge>
            )}
          </div>
          <div style={{ display: "flex", gap: "6px" }}>
            <Button variant="outline" size="sm" onClick={onRunNow}>
              Run Now
            </Button>
            <Button variant="outline" size="sm" onClick={() => onEdit(schedule)}>
              Edit
            </Button>
            <Button variant="outline" size="sm" onClick={onToggle}>
              {schedule.enabled ? "Pause" : "Resume"}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => onDelete(schedule)}>
              Delete
            </Button>
          </div>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))", gap: "16px", marginBottom: "12px" }}>
          <Stat label="Cron" value={schedule.cron} mono />
          <Stat label="Description" value={humanReadable} />
          <Stat label="Next Run" value={nextRun ? formatDateTime(nextRun) : "—"} />
          <Stat label="Last Run" value={schedule.lastRun ? formatDateTime(new Date(schedule.lastRun)) : "—"} />
          <Stat label="Runs" value={String(schedule.runCount)} />
          <Stat label="Success Rate" value={`${successRate.toFixed(1)}%`} />
          <Stat label="Avg Duration" value={formatDuration(schedule.avgDurationMs)} />
          <Stat label="Avg Cost" value={`$${schedule.avgCostUsd.toFixed(2)}`} />
        </div>

        {schedule.history && schedule.history.length > 0 && (
          <MiniBarChart history={schedule.history} />
        )}
      </div>
    </Card>
  );
};

interface StatProps {
  label: string;
  value: string;
  mono?: boolean;
}

const Stat: React.FC<StatProps> = ({ label, value, mono }) => (
  <div>
    <div style={{ fontSize: "0.6875rem", fontWeight: 500, color: COLORS.mutedForeground, textTransform: "uppercase", letterSpacing: "0.5px", marginBottom: "2px" }}>
      {label}
    </div>
    <div style={{ fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, fontFamily: mono ? "var(--font-mono)" : undefined }}>
      {value}
    </div>
  </div>
);

interface MiniBarChartProps {
  history: { date: string; success: number; failed: number }[];
}

const MiniBarChart: React.FC<MiniBarChartProps> = ({ history }) => {
  const maxVal = Math.max(...history.map((h) => h.success + h.failed), 1);
  const barHeight = 40;

  return (
    <div>
      <div style={{ fontSize: "0.6875rem", fontWeight: 500, color: COLORS.mutedForeground, marginBottom: "4px" }}>
        Last 14 Days
      </div>
      <div style={{ display: "flex", alignItems: "flex-end", gap: "2px", height: `${barHeight}px` }}>
        {history.map((day) => {
          const total = day.success + day.failed;
          const successH = (day.success / maxVal) * barHeight;
          const failedH = (day.failed / maxVal) * barHeight;
          return (
            <div
              key={day.date}
              style={{ display: "flex", flexDirection: "column", alignItems: "center", flex: 1, gap: "1px" }}
              title={`${day.date}: ${day.success} success, ${day.failed} failed`}
            >
              <div
                style={{
                  width: "100%",
                  height: `${failedH}px`,
                  backgroundColor: STATUS_COLORS.error,
                  borderRadius: "2px 2px 0 0",
                  minHeight: day.failed > 0 ? "2px" : "0",
                }}
              />
              <div
                style={{
                  width: "100%",
                  height: `${successH}px`,
                  backgroundColor: STATUS_COLORS.success,
                  borderRadius: failedH > 0 ? "0" : "2px 2px 0 0",
                  minHeight: day.success > 0 ? "2px" : "0",
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

interface ScheduleEditorModalProps {
  schedule: ScheduleEntry | null;
  onClose: () => void;
  onSave: (s: ScheduleEntry) => void;
}

const ScheduleEditorModal: React.FC<ScheduleEditorModalProps> = ({ schedule, onClose, onSave }) => {
  const [name, setName] = useState(schedule?.name ?? "");
  const [cron, setCron] = useState(schedule?.cron ?? "0 1 * * *");
  const [enabled, setEnabled] = useState(schedule?.enabled ?? true);
  const [cronError, setCronError] = useState<string | null>(null);

  const humanReadable = useMemo(() => cronToHumanReadable(cron), [cron]);
  const isValid = validateCron(cron);

  const handlePresetSelect = useCallback((value: string) => {
    setCron(value);
    setCronError(null);
  }, []);

  const handleCronChange = useCallback((value: string) => {
    setCron(value);
    if (value.trim() && !validateCron(value)) {
      setCronError("Invalid cron expression");
    } else {
      setCronError(null);
    }
  }, []);

  const handleSave = useCallback(() => {
    if (!name.trim() || !isValid) return;

    const newSchedule: ScheduleEntry = {
      id: schedule?.id ?? `sch-${Date.now()}`,
      name: name.trim(),
      cron,
      enabled,
      lastRun: schedule?.lastRun ?? null,
      lastStatus: schedule?.lastStatus ?? null,
      runCount: schedule?.runCount ?? 0,
      successCount: schedule?.successCount ?? 0,
      avgDurationMs: schedule?.avgDurationMs ?? 0,
      avgCostUsd: schedule?.avgCostUsd ?? 0,
      history: schedule?.history ?? generateHistory(1.0),
    };
    onSave(newSchedule);
  }, [schedule, name, cron, enabled, isValid, onSave]);

  return (
    <Modal open onClose={onClose} title={schedule ? "Edit Schedule" : "New Schedule"} size="lg">
      <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
        <div>
          <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}>
            Name
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g., Nightly Crawl"
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: "0.875rem",
              border: `1px solid ${COLORS.border}`,
              borderRadius: RADIUS.md,
              backgroundColor: COLORS.background,
              color: COLORS.foreground,
              outline: "none",
            }}
          />
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}>
            Cron Presets
          </label>
          <div style={{ display: "flex", flexWrap: "wrap", gap: "6px" }}>
            {CRON_PRESETS.map((preset) => (
              <button
                key={preset.value}
                onClick={() => handlePresetSelect(preset.value)}
                style={{
                  padding: "4px 10px",
                  fontSize: "0.75rem",
                  borderRadius: RADIUS.md,
                  border: `1px solid ${cron === preset.value ? COLORS.primary : COLORS.border}`,
                  backgroundColor: cron === preset.value ? COLORS.primary : "transparent",
                  color: cron === preset.value ? COLORS.primaryForeground : COLORS.foreground,
                  cursor: "pointer",
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label style={{ display: "block", fontSize: "0.8125rem", fontWeight: 500, color: COLORS.foreground, marginBottom: "6px" }}>
            Cron Expression
          </label>
          <input
            type="text"
            value={cron}
            onChange={(e) => handleCronChange(e.target.value)}
            placeholder="* * * * *"
            style={{
              width: "100%",
              padding: "8px 12px",
              fontSize: "0.875rem",
              fontFamily: "var(--font-mono)",
              border: `1px solid ${cronError ? STATUS_COLORS.error : COLORS.border}`,
              borderRadius: RADIUS.md,
              backgroundColor: COLORS.background,
              color: COLORS.foreground,
              outline: "none",
            }}
          />
          {cronError && (
            <p style={{ fontSize: "0.75rem", color: STATUS_COLORS.error, marginTop: "4px" }}>{cronError}</p>
          )}
          {isValid && (
            <p style={{ fontSize: "0.75rem", color: COLORS.mutedForeground, marginTop: "4px" }}>
              {humanReadable}
            </p>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <input
            type="checkbox"
            id="schedule-enabled"
            checked={enabled}
            onChange={(e) => setEnabled(e.target.checked)}
            style={{ accentColor: COLORS.primary }}
          />
          <label htmlFor="schedule-enabled" style={{ fontSize: "0.8125rem", color: COLORS.foreground, cursor: "pointer" }}>
            Enable this schedule
          </label>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: "8px", marginTop: "24px" }}>
        <Button variant="outline" size="sm" onClick={onClose}>
          Cancel
        </Button>
        <Button variant="primary" size="sm" onClick={handleSave} disabled={!name.trim() || !isValid}>
          {schedule ? "Save Changes" : "Create Schedule"}
        </Button>
      </div>
    </Modal>
  );
};

function formatDateTime(d: Date): string {
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  return `${m}m ${remS}s`;
}
