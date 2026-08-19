// ── Tool Definition ─────────────────────────────────────────────────────────
// Wraps the Vercel AI SDK's tool() with AgentDeploy telemetry and context.

import type { z } from "zod";
import type { AgentDeployTool, ToolContext } from "./types.js";
import { recordTelemetry } from "./internal/telemetry.js";

/**
 * Define a tool that agents can call.
 *
 * Tools are functions with typed inputs (validated via Zod) that agents
 * can invoke during chat conversations or autonomous task execution.
 * The SDK wraps each tool call with telemetry automatically and validates
 * the input against the Zod schema before calling the execute function.
 *
 * @example
 * ```ts
 * import { defineTool } from "@agentdeploy-io/edge-sdk";
 * import { z } from "zod";
 *
 * const checkInventory = defineTool({
 *   description: "Check product inventory by SKU",
 *   inputSchema: z.object({ sku: z.string() }),
 *   execute: async ({ sku }, ctx) => {
 *     const res = await fetch(`https://api.example.com/inventory/${sku}`);
 *     return res.json();
 *   },
 * });
 * ```
 */
export function defineTool<TInput, TOutput>(def: {
  description: string;
  inputSchema: z.ZodType<TInput>;
  execute: (
    input: TInput,
    ctx: ToolContext,
  ) => Promise<TOutput>;
  needsApproval?: boolean;
}): AgentDeployTool<TInput, TOutput> {
  return {
    description: def.description,
    inputSchema: def.inputSchema,
    needsApproval: def.needsApproval,
    execute: async (rawInput: unknown, ctx: ToolContext) => {
      const toolName = def.description.slice(0, 50);
      recordTelemetry("tool.call", { tool: toolName });

      try {
        // Validate input against the Zod schema
        const validationResult = def.inputSchema.safeParse(rawInput);
        if (!validationResult.success) {
          const errorMsg = validationResult.error.issues
            .map((i: { path: (string | number)[]; message: string }) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          recordTelemetry("tool.validation_error", { tool: toolName, error: errorMsg });
          throw new Error(`Tool input validation failed: ${errorMsg}`);
        }

        const result = await def.execute(validationResult.data, ctx);
        recordTelemetry("tool.success", { tool: toolName });
        return result;
      } catch (error) {
        recordTelemetry("tool.error", {
          tool: toolName,
          error: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    },
  };
}
