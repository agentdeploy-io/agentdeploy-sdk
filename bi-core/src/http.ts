// Global fetch timeout guard. The crawler talks to untrusted external
// websites and third-party registries; a peer can accept the TCP connection
// and then never respond, which hangs a `fetch` forever (no default timeout
// in the Node runtime). Wrapping the global once in server.ts covers every
// call site without touching each one.

const DEFAULT_TIMEOUT_MS = 30_000;

function combinedSignal(outer: AbortSignal | null | undefined, ctrl: AbortController): AbortSignal {
  if (!outer) return ctrl.signal;
  if (outer.aborted) {
    ctrl.abort(outer.reason);
    return ctrl.signal;
  }
  outer.addEventListener("abort", () => ctrl.abort(outer.reason), { once: true });
  return ctrl.signal;
}

export function installFetchTimeout(timeoutMs: number = DEFAULT_TIMEOUT_MS): void {
  const original = globalThis.fetch;
  if ((original as unknown as { __timeoutWrapped?: boolean })?.__timeoutWrapped) return;

  const wrapped = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => {
      ctrl.abort(new Error(`fetch timeout after ${timeoutMs}ms: ${typeof input === "string" ? input : input instanceof URL ? input.href : input.url}`));
    }, timeoutMs);
    try {
      return await original(input, { ...init, signal: combinedSignal(init?.signal, ctrl) });
    } finally {
      clearTimeout(timer);
    }
  };
  (wrapped as unknown as { __timeoutWrapped?: boolean }).__timeoutWrapped = true;
  globalThis.fetch = wrapped;
}
