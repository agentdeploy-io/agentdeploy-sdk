import type { CheckpointBlob } from "./types.js";
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const CHECKPOINT_DIR = () => {
  const dataDir = process.env["DATA_DIR"] || "/data";
  return join(dataDir, "checkpoints");
};

export function saveCheckpoint(taskId: string, blob: CheckpointBlob): void {
  const dir = CHECKPOINT_DIR();
  mkdirSync(dir, { recursive: true });

  const enriched: CheckpointBlob = {
    ...blob,
    taskId,
    createdAt: new Date().toISOString(),
  };

  const filePath = join(dir, `${taskId}.checkpoint.json`);
  writeFileSync(filePath, JSON.stringify(enriched), "utf-8");
}

export function loadCheckpoint(taskId: string): CheckpointBlob | null {
  const filePath = join(CHECKPOINT_DIR(), `${taskId}.checkpoint.json`);
  if (!existsSync(filePath)) return null;

  try {
    const content = readFileSync(filePath, "utf-8");
    return JSON.parse(content) as CheckpointBlob;
  } catch {
    return null;
  }
}

export function listCheckpoints(): string[] {
  const dir = CHECKPOINT_DIR();
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f: string) => f.endsWith(".checkpoint.json"))
    .map((f: string) => f.replace(".checkpoint.json", ""));
}

export function deleteCheckpoint(taskId: string): void {
  const filePath = join(CHECKPOINT_DIR(), `${taskId}.checkpoint.json`);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
}
