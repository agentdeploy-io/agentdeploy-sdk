import { z } from "zod";

export const riskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

export const callaStepSchema = z.object({
  id: z.string(),
  action: z.string(),
  params: z.record(z.string(), z.unknown()).default({}),
  requiresApproval: z.boolean().default(false),
  risk: riskLevelSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
});

export const approvalRequestSchema = z.object({
  id: z.string(),
  source: z.enum(["mastra", "cloudflare", "core", "data"]),
  agentId: z.string(),
  runId: z.string().optional(),
  toolCallId: z.string().optional(),
  approvalId: z.string().optional(),
  rowKey: z.string().optional(),
  taskId: z.string().optional(),
  toolName: z.string(),
  arguments: z.record(z.string(), z.unknown()).default({}),
  risk: riskLevelSchema,
  summary: z.string(),
  requestedAt: z.string(),
  expiresAt: z.string().nullable(),
  status: z.enum(["pending", "approved", "declined", "expired"]),
  deploymentId: z.string().optional(),
});

export const approvalDecisionSchema = z.object({
  approved: z.boolean(),
  updatedArgs: z.record(z.string(), z.unknown()).optional(),
  input: z.string().optional(),
});

export const agentEventSchema = z.object({
  id: z.string(),
  agentId: z.string(),
  type: z.enum([
    "state_change",
    "tool_call",
    "approval_request",
    "approval_resolved",
    "message",
    "error",
    "classification_completed",
  ]),
  payload: z.unknown(),
  timestamp: z.string(),
});

/** Client → hub subscription frame (see events.ts CallaSubscribeFrame). */
export const callaSubscribeFrameSchema = z.object({
  type: z.literal("calla:subscribe"),
  channels: z.array(z.string()).optional(),
  since: z.string().optional(),
});

/** Authorization role carried by a self-hosted Calla JWT (see auth.ts). */
export const callaUserRoleSchema = z.enum(["admin", "operator"]);

/**
 * Verified payload of a self-hosted Calla JWT (HS256, iss "calla").
 * Mirrors the `CallaJwtClaims` interface in auth.ts — kept as a zod schema so
 * consumers can re-validate decoded claims at trust boundaries.
 */
export const callaJwtClaimsSchema = z.object({
  sub: z.string(),
  email: z.string(),
  role: callaUserRoleSchema,
  iat: z.number(),
  exp: z.number(),
  iss: z.string(),
});

export type CallaStepInput = z.input<typeof callaStepSchema>;
export type ApprovalRequestInput = z.input<typeof approvalRequestSchema>;
export type ApprovalDecisionInput = z.input<typeof approvalDecisionSchema>;
export type CallaUserRoleInput = z.input<typeof callaUserRoleSchema>;
export type CallaJwtClaimsInput = z.input<typeof callaJwtClaimsSchema>;
