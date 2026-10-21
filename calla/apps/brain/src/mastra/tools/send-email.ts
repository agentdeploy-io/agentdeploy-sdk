import { createTool } from "@mastra/core/tools";
import { z } from "zod";

/**
 * Demo HITL tool (spec §3.2): sending external email is a risky, outward-facing
 * action, so `requireApproval: true` suspends the agent run until a human
 * approves or declines it via POST /agents/:agentId/approve-tool-call.
 *
 * The actual send is stubbed — execution is logged and a synthetic messageId
 * is returned.
 */
export const sendExternalEmail = createTool({
  id: "send-external-email",
  description:
    "Send an email to an external contact. Gated by human-in-the-loop approval: calling it suspends the run until a human approves or declines. Do not assume the email was sent until the tool result says so.",
  inputSchema: z.object({
    to: z.email().describe("Recipient email address."),
    subject: z.string().min(1).describe("Email subject line."),
    body: z.string().describe("Plain-text email body."),
  }),
  outputSchema: z.object({
    sent: z.boolean(),
    messageId: z.string(),
  }),
  requireApproval: true,
  execute: async ({ to, subject, body }) => {
    const messageId = `calla-stub-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    console.log(
      JSON.stringify({
        level: "info",
        service: "calla-brain",
        tool: "send-external-email",
        event: "stub-send",
        to,
        subject,
        bodyChars: body.length,
        messageId,
      }),
    );
    return { sent: true, messageId };
  },
});
