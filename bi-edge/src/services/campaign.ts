import type Database from "better-sqlite3";
import { getSetting, setSetting, deleteSetting } from "../db/index.js";

/**
 * Campaign = the operator-editable identity + targeting of this deployment's
 * outreach. Each field is a `campaign:*` key in the settings table; when a
 * field is unset it falls back to the deployment env (BRAND_*) so a fresh
 * deployment still works before anyone opens the UI.
 *
 * countries / crawlLimit are intentionally NOT here — the crawl cron already
 * reads plain `countries` / `crawlLimit` settings, and the UI writes those
 * keys directly.
 */
export interface Campaign {
  brandName: string;
  brandOneLiner: string;
  brandSiteUrl: string;
  brandLogoUrl: string;
  calendlyUrl: string;
  icpNotes: string;
}

interface Field {
  key: string;
  envKey: string;
  fallback: string;
}

const FIELDS: Record<keyof Campaign, Field> = {
  brandName: { key: "campaign:brandName", envKey: "BRAND_NAME", fallback: "" },
  brandOneLiner: { key: "campaign:brandOneLiner", envKey: "BRAND_ONE_LINER", fallback: "" },
  brandSiteUrl: { key: "campaign:brandSiteUrl", envKey: "BRAND_SITE_URL", fallback: "" },
  brandLogoUrl: { key: "campaign:brandLogoUrl", envKey: "BRAND_LOGO_URL", fallback: "" },
  calendlyUrl: { key: "campaign:calendlyUrl", envKey: "CALENDLY_URL", fallback: "" },
  icpNotes: { key: "campaign:icpNotes", envKey: "", fallback: "" },
};

export function resolveCampaign(
  db: Database.Database,
  env: Record<string, unknown>
): Campaign {
  const out = {} as Campaign;
  for (const [field, spec] of Object.entries(FIELDS)) {
    const stored = (getSetting(db, spec.key) ?? "").trim();
    const fromEnv = String((env as Record<string, unknown>)[spec.envKey] ?? "").trim();
    out[field as keyof Campaign] = stored || fromEnv || spec.fallback;
  }
  return out;
}

/**
 * Env-shaped overrides for the resolved campaign, ready to be merged over the
 * raw Worker env so the writer / outreach / reply-drafter (which read
 * env.BRAND_*) pick up UI edits without any per-call-site change. Empty
 * values never override (a cleared field falls back to env).
 */
export function campaignEnvOverrides(
  db: Database.Database,
  env: Record<string, unknown>
): Record<string, string> {
  const c = resolveCampaign(db, env);
  const overrides: Record<string, string> = {};
  const map: Array<[string, string]> = [
    ["BRAND_NAME", c.brandName],
    ["BRAND_ONE_LINER", c.brandOneLiner],
    ["BRAND_SITE_URL", c.brandSiteUrl],
    ["BRAND_LOGO_URL", c.brandLogoUrl],
    ["CALENDLY_URL", c.calendlyUrl],
  ];
  for (const [k, v] of map) {
    if (v) overrides[k] = v;
  }
  return overrides;
}

/**
 * Persist a partial campaign update. Empty strings clear the stored value
 * (fall back to env). Returns the freshly resolved campaign.
 */
export function updateCampaign(
  db: Database.Database,
  patch: Partial<Record<keyof Campaign, string>>,
  env: Record<string, unknown>
): Campaign {
  for (const [field, value] of Object.entries(patch ?? {})) {
    const spec = FIELDS[field as keyof Campaign];
    if (!spec) continue;
    const v = (value ?? "").trim();
    if (v === "") deleteSetting(db, spec.key);
    else setSetting(db, spec.key, v);
  }
  return resolveCampaign(db, env);
}
