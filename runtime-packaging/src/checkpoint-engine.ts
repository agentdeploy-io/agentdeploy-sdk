/**
 * Checkpoint engine — tar adapter checkpointPaths to /data/checkpoints and
 * restore them back. Uses `tar` (present in every base image here).
 *
 * Layout: /data/checkpoints/<taskId>/<basename-of-path>.tar.gz
 */
import { execFile } from "node:child_process";
import { mkdir, cp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

const CHECKPOINT_ROOT = process.env["CHECKPOINT_DIR"] || "/data/checkpoints";
const MAX_CHECKPOINT_BYTES = 512 * 1024 * 1024; // contract R4 cap

function tarName(sourcePath: string): string {
  return `${path.basename(sourcePath)}.tar.gz`;
}

/** Save one directory into the checkpoint root for a task. */
async function saveDir(taskId: string, sourcePath: string): Promise<void> {
  if (!existsSync(sourcePath)) return;
  const destDir = path.join(CHECKPOINT_ROOT, taskId);
  await mkdir(destDir, { recursive: true });
  const dest = path.join(destDir, tarName(sourcePath));
  await exec("tar", ["-czf", dest, "-C", path.dirname(sourcePath), path.basename(sourcePath)], {
    timeout: 120_000,
  });
}

/**
 * Checkpoint all adapter paths for a task. Best-effort per path — one missing
 * dir doesn't abort the rest. Throws only if NOTHING was saved.
 */
export async function checkpoint(taskId: string, checkpointPaths: string[]): Promise<string[]> {
  const saved: string[] = [];
  const errors: string[] = [];
  try {
    await mkdir(CHECKPOINT_ROOT, { recursive: true });
  } catch (error) {
    // No volume mounted (local dev) — checkpointing is unavailable, not fatal.
    throw new Error(
      `checkpoint root ${CHECKPOINT_ROOT} unavailable (${error instanceof Error ? error.message : String(error)})`
    );
  }
  for (const p of checkpointPaths) {
    try {
      await saveDir(taskId, p);
      saved.push(p);
    } catch (error) {
      errors.push(`${p}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (saved.length === 0 && checkpointPaths.length > 0) {
    throw new Error(`checkpoint failed for all paths: ${errors.join("; ")}`);
  }
  return saved;
}

/** Restore checkpointed dirs for a task back to their original locations. */
export async function restore(taskId: string, checkpointPaths: string[]): Promise<string[]> {
  const taskDir = path.join(CHECKPOINT_ROOT, taskId);
  if (!existsSync(taskDir)) return [];
  const restored: string[] = [];
  for (const p of checkpointPaths) {
    const archive = path.join(taskDir, tarName(p));
    if (!existsSync(archive)) continue;
    const parent = path.dirname(p);
    await mkdir(parent, { recursive: true });
    // Remove stale live dir so the restore is authoritative.
    await rm(p, { recursive: true, force: true });
    await exec("tar", ["-xzf", archive, "-C", parent], { timeout: 120_000 });
    restored.push(p);
  }
  return restored;
}

/** Enforce the contract's 512MB cap on a task's checkpoints. Deletes oldest. */
export async function enforceCheckpointCap(taskId: string): Promise<void> {
  const taskDir = path.join(CHECKPOINT_ROOT, taskId);
  if (!existsSync(taskDir)) return;
  try {
    const { stdout } = await exec("du", ["-sb", taskDir]);
    const bytes = Number(stdout.split("\t")[0] ?? 0);
    if (bytes > MAX_CHECKPOINT_BYTES) {
      logger_warn(`checkpoint cap exceeded (${bytes} bytes) — pruning ${taskDir}`);
      await rm(path.join(taskDir, tarName("/root/.hermes")), { force: true });
    }
  } catch {
    // du unavailable or race — non-fatal
  }
}

function logger_warn(msg: string): void {
  console.error("[shim:checkpoint]", msg);
}

/** Copy-on-boot convenience: restore latest known task checkpoints at startup. */
export async function restoreAllAtBoot(checkpointPaths: string[]): Promise<void> {
  if (!existsSync(CHECKPOINT_ROOT)) return;
  try {
    // Restore every task dir found (idempotent; last write wins).
    const { readdir } = await import("node:fs/promises");
    const taskIds = await readdir(CHECKPOINT_ROOT);
    for (const taskId of taskIds) {
      await restore(taskId, checkpointPaths).catch(() => {});
    }
  } catch (error) {
    console.error("[shim:checkpoint] boot restore failed:", error);
  }
}
