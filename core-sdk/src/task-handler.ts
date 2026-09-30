import type { TaskHandler, TaskResult, TaskContext } from "./types.js";
import type { z } from "zod";

export function defineTaskHandler<TInput>(handler: {
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute(input: TInput, ctx: TaskContext): Promise<TaskResult>;
  onCancel?(ctx: TaskContext): Promise<void>;
  onCheckpoint?(ctx: TaskContext): Promise<{ schemaVersion: number; data: unknown }>;
  onRestore?(blob: { schemaVersion: number; data: unknown }, ctx: TaskContext): Promise<void>;
  onAwaitingInput?(prompt: { type: string; message: string; options?: string[]; timeout?: number; defaultAction?: string }, ctx: TaskContext): Promise<void>;
}): TaskHandler<TInput> {
  return handler as TaskHandler<TInput>;
}
