import { Agent } from "@mastra/core/agent";
import { openai } from "@ai-sdk/openai";
import { braveSearchTool, discoverCandidatesTool } from "../tools/brave-search.js";
import { registryClientTool } from "../tools/registry-client.js";
import { syncCallbackTool } from "../tools/sync-callback.js";

const MODEL_ID = process.env["MASTRA_MODEL"] || "gpt-4o-mini";

export const crawlerAgent = new Agent({
  name: "crawler",
  instructions: `You are a business intelligence crawler agent. Your job is to:
1. Harvest company candidates from country registries (UK Companies House, IE CRO, FR recherche-entreprises, EE ariregister, PT via Brave web discovery).
2. Discover and verify matching websites using Brave search and signal-based verification.
3. Extract contact information (emails, phones, socials) from verified websites.
4. Sync verified leads to the platform via HTTP callback in watermarked batches.

Always respect budget limits (VM minutes and tokens). Checkpoint progress after each step for resume capability.`,
  model: openai(MODEL_ID),
  tools: {
    braveSearch: braveSearchTool,
    discoverCandidates: discoverCandidatesTool,
    registryClient: registryClientTool,
    syncCallback: syncCallbackTool,
  },
});
