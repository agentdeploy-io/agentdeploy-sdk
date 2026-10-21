/**
 * Evaluator pipeline types.
 *
 * The Evaluator interface pattern (name/description/similes/alwaysRun/
 * validate/handler + two-phase filter-then-run evaluation) is adapted from
 * ElizaOS core (MIT). Calla runs evaluators AFTER an LLM response completes
 * (generate or stream), never in the request path — failures are audited,
 * never thrown at the caller.
 */

/** A normalized chat message (content flattened to text). */
export interface EvalMessage {
  role: string;
  content: string;
}

export interface EvalToolCall {
  toolCallId: string;
  toolName: string;
  args?: unknown;
}

export interface EvalContext {
  agentId: string;
  runId?: string;
  input: EvalMessage[];
  output: {
    text?: string;
    toolCalls?: EvalToolCall[];
    finishReason?: string | null;
  };
  /** Epoch ms when the run started. */
  startedAt: number;
  /** Measured wall-clock duration of the run in ms. */
  durationMs: number;
  threadId?: string;
  resourceId?: string;
}

export interface EvalResult {
  success: boolean;
  /** Named metrics/flags this evaluator produced (audit-friendly). */
  values?: Record<string, unknown>;
  /** Arbitrary payload (not persisted to the audit chain by default). */
  data?: unknown;
}

export interface CallaEvaluator {
  name: string;
  description: string;
  /** Alternative names (ElizaOS-style discoverability). */
  similes?: string[];
  /** Run even when the agent produced no response text/tool calls. */
  alwaysRun?: boolean;
  /** Cheap gate: should this evaluator run for this context? */
  validate(ctx: EvalContext): Promise<boolean> | boolean;
  /** The actual evaluation; may write audit rows via the Calla store. */
  handler(ctx: EvalContext): Promise<EvalResult | void>;
}

/** Per-evaluator outcome collected by runEvaluators(). */
export interface EvalOutcome {
  evaluator: string;
  status: "ok" | "skipped" | "error";
  result?: EvalResult | void;
  error?: string;
}
