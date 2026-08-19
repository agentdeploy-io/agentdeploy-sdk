/**
 * useLocalStorage Hook
 * ────────────────────
 * Persists state to localStorage with SSR safety, type safety,
 * and error handling (handles quota exceeded, parse errors, etc.)
 *
 * Features:
 *   - Type-safe generic storage
 *   - JSON serialization handled automatically
 *   - Graceful degradation when localStorage is unavailable
 *   - Cross-tab sync via storage event
 *   - Quota exceeded handling via errorHandler
 *
 * Usage:
 *   const [theme, setTheme] = useLocalStorage("edge-theme", "light")
 */

import { useState, useEffect, useCallback } from "react";
import { errorHandler } from "../errors/errorHandler";
import { ErrorCode } from "../constants/errors";

export function useLocalStorage<T>(
  key: string,
  initialValue: T,
): [T, (value: T | ((prev: T) => T)) => void] {
  const [storedValue, setStoredValue] = useState<T>(() => {
    if (typeof window === "undefined") return initialValue;

    try {
      const item = window.localStorage.getItem(key);
      if (item === null) return initialValue;
      return JSON.parse(item) as T;
    } catch (error) {
      errorHandler.handleError(error, {
        code: ErrorCode.STORAGE_QUOTA_EXCEEDED,
        showToast: false,
      });
      return initialValue;
    }
  });

  const setValue = useCallback(
    (value: T | ((prev: T) => T)) => {
      setStoredValue((prev) => {
        const nextValue = value instanceof Function ? value(prev) : value;

        try {
          window.localStorage.setItem(key, JSON.stringify(nextValue));
        } catch (error) {
          // Quota exceeded or storage disabled
          errorHandler.handleError(error, {
            code: ErrorCode.STORAGE_QUOTA_EXCEEDED,
            showToast: false,
          });
        }

        return nextValue;
      });
    },
    [key],
  );

  // Cross-tab sync
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return;

      try {
        setStoredValue(JSON.parse(e.newValue) as T);
      } catch {
        // Ignore parse errors from other tabs
      }
    };

    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [key]);

  return [storedValue, setValue];
}
