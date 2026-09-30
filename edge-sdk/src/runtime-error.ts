// ── Runtime Error Catalog & Response Builder ────────────────────────────────
// Single place where worker-facing error codes are mapped to:
//   - an HTTP status
//   - a customer-facing message (safe to show in any UI)
//
// Mirrored in deployment-service/src/constants.ts (AGENT_RUNTIME_ERROR_*)
// and agent-deploy/lib/constants/error-codes.ts per the repo's
// centralised-codes convention — keep the three in sync.
//
// Developer logging: callers log the FULL error (stack, code, details) via
// console.error before responding. The customer only ever sees `message`.

export const RUNTIME_ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  NOT_FOUND: "NOT_FOUND",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  QUOTA_EXCEEDED: "QUOTA_EXCEEDED",
  SANDBOX_WEEKLY_CAP: "SANDBOX_WEEKLY_CAP",
  METERING_UNAVAILABLE: "METERING_UNAVAILABLE",
  GATEWAY_TIMEOUT: "GATEWAY_TIMEOUT",
  GATEWAY_UNAVAILABLE: "GATEWAY_UNAVAILABLE",
  LLM_OUTPUT_INVALID: "LLM_OUTPUT_INVALID",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR",
} as const;

export type RuntimeErrorCode =
  (typeof RUNTIME_ERROR_CODES)[keyof typeof RUNTIME_ERROR_CODES];

const CATALOG: Record<RuntimeErrorCode, { status: number; message: string }> = {
  VALIDATION_ERROR: {
    status: 400,
    message: "That request is missing something. Check the input and try again.",
  },
  NOT_FOUND: {
    status: 404,
    message: "We couldn't find what you asked for. Check the id or path and try again.",
  },
  AUTH_REQUIRED: {
    status: 401,
    message: "Your access key is invalid or was revoked. Contact your workspace admin.",
  },
  QUOTA_EXCEEDED: {
    status: 429,
    message:
      "You've used all the tokens included in your plan for this period. Try again after the quota resets, or upgrade your plan.",
  },
  SANDBOX_WEEKLY_CAP: {
    status: 429,
    message:
      "You've reached the sandbox usage limit for this week. Try again next week, or move to a paid plan to lift the cap.",
  },
  METERING_UNAVAILABLE: {
    status: 503,
    message: "We can't verify usage right now. Please try again in a couple of minutes.",
  },
  GATEWAY_TIMEOUT: {
    status: 504,
    message: "The model took too long to respond. Please try again.",
  },
  GATEWAY_UNAVAILABLE: {
    status: 502,
    message: "The model service is temporarily unavailable. Please try again shortly.",
  },
  LLM_OUTPUT_INVALID: {
    status: 502,
    message: "The model's answer couldn't be processed. Please try again.",
  },
  UNEXPECTED_ERROR: {
    status: 500,
    message:
      "Something went wrong on our end. Please try again, and let us know if it keeps happening.",
  },
};

export class RuntimeApiError extends Error {
  readonly code: RuntimeErrorCode;
  readonly httpStatus: number;
  readonly customerMessage: string;
  /** Machine details (gateway body, counts, etc.) — never shown to customers. */
  readonly details?: Record<string, unknown>;

  constructor(
    code: RuntimeErrorCode,
    details?: Record<string, unknown>,
    originalMessage?: string
  ) {
    // The code is embedded in the message: the base partyserver fetch
    // swallows thrown errors and returns Response(err.stack, 500), so the
    // fetch override recovers the code from the stack text via this prefix.
    super(originalMessage ? `[${code}] ${originalMessage}` : code);
    this.name = "RuntimeApiError";
    this.code = code;
    const entry = CATALOG[code] ?? CATALOG.UNEXPECTED_ERROR;
    this.httpStatus = entry.status;
    this.customerMessage = entry.message;
    this.details = details;
  }
}

export function customerMessageFor(code: RuntimeErrorCode): string {
  return (CATALOG[code] ?? CATALOG.UNEXPECTED_ERROR).message;
}

export function statusFor(code: RuntimeErrorCode): number {
  return (CATALOG[code] ?? CATALOG.UNEXPECTED_ERROR).status;
}

interface GatewayErrorBody {
  error?: { code?: string; message?: string; details?: Record<string, unknown> };
}

/**
 * Map a failed gateway response to a RuntimeApiError. Parses the service's
 * structured error body ({ error: { code, message, details } }) so quota
 * failures surface their real cause; falls back to status-based mapping.
 */
export async function gatewayErrorFromResponse(
  res: Response,
  path: string
): Promise<RuntimeApiError> {
  let body: GatewayErrorBody | null = null;
  try {
    body = (await res.clone().json()) as GatewayErrorBody;
  } catch {
    body = null;
  }
  const rawCode = body?.error?.code;
  const details = body?.error?.details;
  const rawMessage = body?.error?.message ?? res.statusText;

  if (rawCode === "QUOTA_EXCEEDED") {
    return new RuntimeApiError("QUOTA_EXCEEDED", details, rawMessage);
  }
  if (rawCode === "SANDBOX_WEEKLY_CAP") {
    return new RuntimeApiError("SANDBOX_WEEKLY_CAP", details, rawMessage);
  }
  if (rawCode === "METERING_UNAVAILABLE") {
    return new RuntimeApiError("METERING_UNAVAILABLE", details, rawMessage);
  }
  if (rawCode === "VALIDATION_ERROR") {
    return new RuntimeApiError("VALIDATION_ERROR", details, rawMessage);
  }

  if (res.status === 401 || res.status === 403) {
    return new RuntimeApiError("AUTH_REQUIRED", { gatewayStatus: res.status }, rawMessage);
  }
  if (res.status === 408 || res.status === 504 || res.status === 524) {
    return new RuntimeApiError("GATEWAY_TIMEOUT", { gatewayStatus: res.status, path }, rawMessage);
  }
  if (res.status === 400) {
    return new RuntimeApiError("VALIDATION_ERROR", { gatewayStatus: res.status }, rawMessage);
  }
  return new RuntimeApiError("GATEWAY_UNAVAILABLE", { gatewayStatus: res.status, path }, rawMessage);
}

/**
 * Build the customer-facing JSON error response. The raw error (stack,
 * code, details) is logged first — the customer only receives code + message.
 */
export function runtimeErrorResponse(
  err: unknown,
  deploymentId: string | number | undefined
): Response {
  let code: RuntimeErrorCode;
  let httpStatus: number;
  let customerMessage: string;
  let details: Record<string, unknown> | undefined;

  if (err instanceof RuntimeApiError) {
    code = err.code;
    httpStatus = err.httpStatus;
    customerMessage = err.customerMessage;
    details = err.details;
  } else {
    code = "UNEXPECTED_ERROR";
    httpStatus = 500;
    customerMessage = CATALOG.UNEXPECTED_ERROR.message;
  }

  // Developer log: full fidelity. Customer payload: never.
  console.error(
    JSON.stringify({
      level: "error",
      deploymentId,
      code,
      error: err instanceof Error ? err.stack ?? err.message : String(err),
      details: details ?? null,
    })
  );

  const errorBody: { code: string; message: string; details?: Record<string, unknown> } = {
    code,
    message: customerMessage,
  };
  if (details && typeof details === "object") {
    // Only structured, non-sensitive details (counts, limits, timestamps).
    const safe: Record<string, unknown> = {};
    for (const key of [
      "usedTokens",
      "capTokens",
      "limit",
      "resetsAt",
      "tokenUsed",
      "tokenAllowance",
      "gatewayStatus",
    ]) {
      if (key in details) safe[key] = details[key];
    }
    if (Object.keys(safe).length > 0) errorBody.details = safe;
  }
  const payload = { error: errorBody, requestId: crypto.randomUUID() };

  return new Response(JSON.stringify(payload), {
    status: httpStatus,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * The base partyserver fetch swallows thrown errors and responds
 * `new Response(err.stack, { status: 500 })` — no content-type, body is the
 * raw stack. Detect that shape and convert it back to structured,
 * customer-safe JSON (recovering the code from the `[CODE]` message prefix
 * when present). The full stack is logged for developers.
 */
export function runtimeErrorFromStackText(
  text: string,
  deploymentId: string | number | undefined,
  originalStatus: number
): Response {
  let code: RuntimeErrorCode = "UNEXPECTED_ERROR";
  const match = text.match(/RuntimeApiError:\s*\[([A-Z_]+)\]/);
  if (match && match[1] in RUNTIME_ERROR_CODES) {
    code = match[1] as RuntimeErrorCode;
  }
  const entry = CATALOG[code] ?? CATALOG.UNEXPECTED_ERROR;

  console.error(
    JSON.stringify({
      level: "error",
      deploymentId,
      code,
      error: text.slice(0, 4000),
    })
  );

  const payload = { error: { code, message: entry.message }, requestId: crypto.randomUUID() };
  return new Response(JSON.stringify(payload), {
    status: entry.status === 500 ? originalStatus : entry.status,
    headers: { "Content-Type": "application/json" },
  });
}
