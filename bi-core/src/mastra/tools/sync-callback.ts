import { createTool } from "@mastra/core/tools";
import { z } from "zod";

const BATCH_SIZE = 25;

let watermark = 0;

export function resetWatermark(): void {
  watermark = 0;
}

export function getWatermark(): number {
  return watermark;
}

export interface SyncLead {
  key: string;
  country: string;
  name: string;
  reg_number?: string;
  sic?: string;
  sic_label?: string;
  incorporated?: string;
  address?: string;
  city?: string;
  website?: string;
  website_status?: string;
  score?: number;
  emails?: Array<{ address: string; kind: string; mx_ok: boolean | null }>;
  phones?: string[];
  socials?: Record<string, string[]>;
  source: string;
  source_url?: string;
  stage?: string;
}

export interface SyncBatch {
  leads: SyncLead[];
  watermark: number;
  runId: string;
  country: string;
}

async function pushBatch(
  syncUrl: string,
  syncSecret: string,
  batch: SyncBatch,
): Promise<{ ok: boolean; status: number; retryable: boolean }> {
  const res = await fetch(syncUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-AD-Sync": syncSecret,
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(30_000),
  });

  if (res.ok) {
    return { ok: true, status: res.status, retryable: false };
  }

  const retryable = res.status >= 500 || res.status === 429;
  return { ok: false, status: res.status, retryable };
}

export async function syncCallback(
  syncUrl: string,
  syncSecret: string,
  runId: string,
  country: string,
  leads: SyncLead[],
): Promise<{ pushed: number; failed: number; watermark: number }> {
  let pushed = 0;
  let failed = 0;

  for (let i = 0; i < leads.length; i += BATCH_SIZE) {
    const chunk = leads.slice(i, i + BATCH_SIZE);
    watermark += 1;

    const batch: SyncBatch = {
      leads: chunk,
      watermark,
      runId,
      country,
    };

    let attempts = 0;
    let success = false;

    while (attempts < 3 && !success) {
      attempts += 1;
      const result = await pushBatch(syncUrl, syncSecret, batch);

      if (result.ok) {
        success = true;
        pushed += chunk.length;
      } else if (result.retryable) {
        const delay = Math.min(1000 * 2 ** attempts, 10_000);
        await new Promise((r) => setTimeout(r, delay));
      } else {
        failed += chunk.length;
        break;
      }
    }

    if (!success && attempts >= 3) {
      failed += chunk.length;
    }
  }

  return { pushed, failed, watermark };
}

const syncLeadSchema = z.object({
  key: z.string(),
  country: z.string(),
  name: z.string(),
  reg_number: z.string().optional(),
  sic: z.string().optional(),
  sic_label: z.string().optional(),
  incorporated: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  website: z.string().optional(),
  website_status: z.string().optional(),
  score: z.number().optional(),
  emails: z.array(z.object({
    address: z.string(),
    kind: z.string(),
    mx_ok: z.boolean().nullable(),
  })).optional(),
  phones: z.array(z.string()).optional(),
  socials: z.record(z.array(z.string())).optional(),
  source: z.string(),
  source_url: z.string().optional(),
  stage: z.string().optional(),
});

export const syncCallbackTool = createTool({
  id: "sync-callback",
  description: "Push a batch of verified leads to the sync endpoint via HTTP callback",
  inputSchema: z.object({
    syncUrl: z.string().describe("The sync callback URL"),
    syncSecret: z.string().describe("The sync secret for X-AD-Sync header"),
    runId: z.string().describe("The current run identifier"),
    country: z.string().describe("Country code for this batch"),
    leads: z.array(syncLeadSchema).describe("Leads to push (max 25 per batch)"),
  }),
  execute: async ({ context }) => {
    const { syncUrl, syncSecret, runId, country, leads } = context;
    const result = await syncCallback(syncUrl, syncSecret, runId, country, leads);
    return result;
  },
});
