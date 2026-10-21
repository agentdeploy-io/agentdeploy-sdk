/**
 * Calla module registry — canonical per-deployment feature-flag set.
 * ─────────────────────────────────────────────────────────────────
 * Every Calla deployment exposes a subset of modules (Data, Approvals,
 * Conversations, Reports, Voice, …) depending on the vertical the client
 * bought (dental, retrofit, property, …). This registry is the single
 * source of truth shared by brain (persistence/validation), edge and UI
 * (gating), so the enabled-set logic lives in exactly one place.
 *
 * Resolution order for the effective enabled set (first wins):
 *   1. brain `calla_deployment_config` (runtime, toggled via /config/modules)
 *   2. runtime-config `ENABLED_MODULES` (baked at deploy time per vertical)
 *   3. all modules enabled (local dev default)
 *
 * `always: true` modules (fleet, setup) are the console shell — they can
 * never be disabled. `required` expresses dependencies: resolving a set
 * auto-drops any module whose required modules are disabled (e.g. Voice
 * needs the Approvals inbox for escalation + Conversations for transcripts).
 */

export type ModuleId =
  | "fleet"
  | "data"
  | "inbox"
  | "conversations"
  | "reports"
  | "setup"
  | "agents"
  | "booking"
  | "skills"
  | "voice";

export interface CallaModule {
  id: ModuleId;
  /** Display label (sidebar / setup panel). */
  label: string;
  /**
   * Route first segment this module owns, or null for capability modules
   * without a dedicated screen (booking shows inside Reports, skills is an
   * agent-detail tab). "fleet" owns the root path.
   */
  path: string | null;
  /** Command-palette / search keywords. */
  keywords: string;
  /** Modules this one depends on — disabling any of them disables this one. */
  required?: readonly ModuleId[];
  /** Console-shell modules that can never be disabled. */
  always?: boolean;
}

export const CALLA_MODULES: readonly CallaModule[] = [
  { id: "fleet", label: "Fleet", path: "/", keywords: "home overview dashboard g o f", always: true },
  { id: "data", label: "Data", path: "data", keywords: "leads scraped bulk outreach g d" },
  { id: "inbox", label: "Approvals", path: "inbox", keywords: "approvals hitl review inbox g i" },
  {
    id: "conversations",
    label: "Conversations",
    path: "conversations",
    keywords: "conversations messages threads dm whatsapp instagram tiktok g c",
  },
  { id: "reports", label: "Reports", path: "reports", keywords: "reports funnel metrics appointments g r" },
  { id: "setup", label: "Setup", path: "setup", keywords: "setup checklist onboarding configuration", always: true },
  { id: "agents", label: "Agents", path: "agents", keywords: "agents detail chat state" },
  { id: "booking", label: "Booking", path: null, keywords: "appointments booking calendar reps" },
  { id: "skills", label: "Skills", path: null, keywords: "skills persona instructions" },
  {
    id: "voice",
    label: "Voice",
    path: "calls",
    keywords: "voice calls phone receptionist telephony",
    required: ["inbox", "conversations"],
  },
] as const;

const MODULE_BY_ID: ReadonlyMap<ModuleId, CallaModule> = new Map(
  CALLA_MODULES.map((m) => [m.id, m]),
);

export interface ModulePreset {
  label: string;
  description: string;
  modules: readonly ModuleId[];
}

/**
 * Vertical presets — one-click enabled sets. `dental` drops lead-scraping
 * (Data); `retrofit`/`property` are the full stack. Unknown preset names
 * are rejected by the brain (GET /config/modules/presets is the source of
 * the picker list, never hardcoded client-side).
 */
export const MODULE_PRESETS: Record<string, ModulePreset> = {
  dental: {
    label: "Dental practice",
    description: "Voice receptionist + conversations + approvals; no lead scraping.",
    modules: [
      "fleet",
      "inbox",
      "conversations",
      "reports",
      "setup",
      "agents",
      "voice",
      "booking",
      "skills",
    ],
  },
  retrofit: {
    label: "Retrofit / home energy",
    description: "Full stack — lead data, outreach approvals, social, booking.",
    modules: [
      "fleet",
      "data",
      "inbox",
      "conversations",
      "reports",
      "setup",
      "agents",
      "booking",
      "skills",
    ],
  },
  property: {
    label: "Property / estate",
    description: "Full stack — lead data, buyer/seller flows, booking.",
    modules: [
      "fleet",
      "data",
      "inbox",
      "conversations",
      "reports",
      "setup",
      "agents",
      "booking",
      "skills",
    ],
  },
};

export function isKnownModuleId(value: unknown): value is ModuleId {
  return typeof value === "string" && MODULE_BY_ID.has(value as ModuleId);
}

export function getModule(id: ModuleId): CallaModule | undefined {
  return MODULE_BY_ID.get(id);
}

/**
 * Close the dependency closure over a raw enabled set: always-on modules
 * are kept, every other module is kept only if all of its `required`
 * modules are also enabled. Idempotent; returns sorted ids (stable wire
 * shape). Unknown ids are dropped (validation happens at the API layer).
 */
export function resolveModuleSet(ids: readonly string[]): ModuleId[] {
  const wanted = new Set(ids.filter(isKnownModuleId));
  for (const m of CALLA_MODULES) {
    if (m.always) wanted.add(m.id);
  }
  const resolved: ModuleId[] = [];
  for (const m of CALLA_MODULES) {
    if (m.always) {
      resolved.push(m.id);
      continue;
    }
    if (!wanted.has(m.id)) continue;
    const missing = (m.required ?? []).some((dep) => !wanted.has(dep));
    if (!missing) resolved.push(m.id);
  }
  return resolved.sort();
}

/** True when `id` is in the resolved set, or when `enabled` is null (all on). */
export function isModuleEnabled(id: ModuleId, enabled: readonly ModuleId[] | null): boolean {
  const mod = MODULE_BY_ID.get(id);
  if (!mod) return false;
  if (mod.always) return true;
  if (!enabled) return true;
  return enabled.includes(id);
}

// ─── Deployment config persistence payload ───────────────────────

/**
 * Payload of the brain's singleton `calla_deployment_config` row. `modules`
 * absent/undefined means "all modules enabled" (dev default); a stored
 * array is always a resolved set (dep-closed, always-on included).
 */
export interface DeploymentConfigPayload {
  modules?: ModuleId[];
  /** Name of the preset last applied (informational; modules is the truth). */
  preset?: string;
  /** Identity of the last mutator (user email or "deploy"). */
  updatedBy?: string;
}
