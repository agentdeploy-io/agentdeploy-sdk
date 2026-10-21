/**
 * Qualification flows — shared types (Flowly-style multi-step enquiry
 * qualification for the Irish retrofit + property verticals).
 *
 * A FlowDefinition is a deterministic state machine: an ordered list of
 * fields (questions), scoring rules applied to the collected answers, hot/
 * warm tier thresholds, and an outcome (route to a rep with a booking
 * proposal, or tag-only). FlowRun is one in-flight/completed conversation.
 *
 * No runtime deps beyond node:crypto/fetch (same discipline as booking/).
 */

/** Where a run was started (channels + REST all funnel into flows/runner). */
export type FlowChannel = "rest" | "social" | "whatsapp" | "form" | "leadform";

/** Business vertical a flow qualifies for (drives routing + lead tagging). */
export type FlowVertical = "retrofit" | "property" | "generic";

/** Field input types; the runner matches answers per type (see runner.ts). */
export type FlowFieldType =
  | "choice"
  | "yesno"
  | "text"
  | "number"
  | "email"
  | "eircode";

/** One question in a flow. */
export interface FlowField {
  /** Snake-case id, unique within the flow (answers are keyed by it). */
  name: string;
  question: string;
  type: FlowFieldType;
  /** Required for type "choice". */
  options?: string[];
  /** Default true; optional text fields accept "skip"/"none" answers. */
  required?: boolean;
  /** Shown with the question for optional fields (e.g. "type 'skip'…"). */
  optionalHint?: string;
  /** Skip this field when another answer already equals a value. */
  skipIf?: { field: string; equals: string };
}

/**
 * Deterministic scoring rule. Exactly one of equals/in/min should be set;
 * all comparisons are normalization-insensitive (case/dashes/€/spaces —
 * see runner.normValue). min is numeric (>=).
 */
export interface FlowScoreRule {
  field: string;
  equals?: string | number;
  in?: (string | number)[];
  min?: number;
  weight: number;
}

/** Score thresholds: score >= hot → "hot", >= warm → "warm", else "cold". */
export interface FlowTiers {
  hot: number;
  warm: number;
}

/** What happens when every field has an answer. */
export interface FlowOutcome {
  /** "route" → rep routing + booking proposal; "tag" → lead patch + audit only. */
  onComplete: "route" | "tag";
  /** When present, routing/booking only fires if answers[field] == equals. */
  bookingIntent?: { field: string; equals: string | number };
  /** Nurture-sequence label patched onto the lead's classification. */
  sequenceTag?: string;
}

/** A flow template — builtins are versioned in code (definitions.ts). */
export interface FlowDefinition {
  /** Slug id (lowercase letters/numbers/hyphens). */
  id: string;
  name: string;
  vertical: FlowVertical;
  description: string;
  /** Convenience for channel trigger seeding (not auto-matched). */
  triggerKeywords?: string[];
  fields: FlowField[];
  scoring: FlowScoreRule[];
  tiers: FlowTiers;
  outcome: FlowOutcome;
}

export type FlowRunStatus = "active" | "completed" | "cancelled";

export type FlowTier = "hot" | "warm" | "cold";

/** Routing/booking outcome attached to a completed run. */
export interface FlowRunRouting {
  repId: string;
  repName?: string;
  /** Routing rule that selected the rep (null-ish → policy default). */
  ruleId?: string;
  /** Proposed survey slots (ISO-8601 UTC); provisional = work-hours-only. */
  proposedSlots?: { start: string; end: string; provisional?: boolean }[];
  /** Calendly reps: the scheduling link replaces slot proposals. */
  link?: string;
  /** ISO — when the calla:message routing relay fired. */
  notifiedAt?: string;
  /** Set by POST /flows/runs/:id/book once the appointment exists. */
  bookedAppointmentId?: string;
  bookedAt?: string;
}

/** One qualification conversation. */
export interface FlowRun {
  id: string;
  flowId: string;
  /** Engine lead key (IG:handle / WA:phone / …) when known. */
  leadKey?: string;
  channel: FlowChannel;
  /** Conversation identity: `<platform>:<userId>`, phone, or form session. */
  chatRef?: string;
  status: FlowRunStatus;
  /** Field name being asked; null when done/cancelled. */
  currentField: string | null;
  answers: Record<string, string | number>;
  score?: number;
  tier?: FlowTier;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  routing?: FlowRunRouting;
  /** "high" when an urgency keyword was seen (leak/flood/emergency…). */
  priority?: "normal" | "high";
}

/** The question to send back to the conversation (channel layer formats/sends). */
export interface FlowPrompt {
  field: string;
  question: string;
  type: FlowFieldType;
  options?: string[];
  optionalHint?: string;
}

/** Completion summary returned with done:true step results. */
export interface FlowSummary {
  score: number;
  tier: FlowTier;
  /** Closing message for the conversation (booking proposal / thanks). */
  message?: string;
  repId?: string;
  link?: string;
  slots?: { start: string; end: string; provisional?: boolean }[];
  leadPatched?: boolean;
  sequenceTag?: string;
}

/** Result of startFlow/answerFlow: either a step or a typed error. */
export type FlowStepResult =
  | {
      run: FlowRun;
      prompt?: FlowPrompt;
      done?: boolean;
      /** false → the answer didn't match; the same prompt is returned. */
      matched?: boolean;
      summary?: FlowSummary;
      error?: undefined;
    }
  | { error: string; status: number; run?: undefined };

/** Index row kept under "flow:runs:index" (capped, newest first). */
export interface FlowRunIndexEntry {
  id: string;
  flowId: string;
  status: FlowRunStatus;
  leadKey?: string;
  chatRef?: string;
  updatedAt: string;
}
