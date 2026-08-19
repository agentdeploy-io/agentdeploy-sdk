/**
 * useAsync Hook
 * ──────────────
 * Generic async data fetching hook with proper loading/error states.
 *
 * Features:
 *   - Automatic execution on mount (configurable)
 *   - Manual re-fetch via refetch()
 *   - Loading state (idle → loading → success/error)
 *   - Error integration with errorHandler
 *   - AbortController for cleanup
 *   - Stale request handling (only latest result is used)
 *
 * Usage:
 *   const { data, status, error, refetch } = useAsync(
 *     () => fetchAgentConfig(agentId),
 *     { deps: [agentId] }
 *   )
 */

import { useState, useEffect, useCallback, useRef } from "react";
import { errorHandler } from "../errors/errorHandler";
import { ErrorCode } from "../constants/errors";
import type { LoadingState } from "../types/ui";

export interface UseAsyncResult<T> {
  data: T | null;
  status: LoadingState;
  error: string | null;
  refetch: () => Promise<T | null>;
}

export interface UseAsyncOptions {
  deps?: unknown[];
  immediate?: boolean;
  showErrorToast?: boolean;
}

export function useAsync<T>(
  asyncFn: () => Promise<T>,
  options: UseAsyncOptions = {},
): UseAsyncResult<T> {
  const { deps = [], immediate = true, showErrorToast = true } = options;

  const [data, setData] = useState<T | null>(null);
  const [status, setStatus] = useState<LoadingState>("idle");
  const [error, setError] = useState<string | null>(null);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  const asyncFnRef = useRef(asyncFn);
  asyncFnRef.current = asyncFn;

  const execute = useCallback(async (): Promise<T | null> => {
    const currentRequestId = ++requestIdRef.current;
    setStatus("loading");
    setError(null);

    try {
      const result = await asyncFnRef.current();

      // Only update if this is the latest request and component is mounted
      if (currentRequestId === requestIdRef.current && mountedRef.current) {
        setData(result);
        setStatus("success");
        return result;
      }
      return null;
    } catch (err) {
      if (currentRequestId === requestIdRef.current && mountedRef.current) {
        const message =
          err instanceof Error ? err.message : "Failed to load data";
        setError(message);
        setStatus("error");
        errorHandler.handleError(err, {
          code: ErrorCode.DATA_LOAD_FAILED,
          showToast: showErrorToast,
        });
      }
      return null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showErrorToast]);

  useEffect(() => {
    mountedRef.current = true;

    if (immediate) {
      execute();
    }

    return () => {
      mountedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { data, status, error, refetch: execute };
}
