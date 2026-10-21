/**
 * ws-registry — ref-counted WsLifecycleManager singletons
 * ────────────────────────────────────────────────────────
 * Multiple hook instances that want the SAME socket (e.g. the console shell's
 * events provider AND useApprovals both subscribing to /events) acquire a
 * manager by key. Same key → same manager, refCount++.
 *
 * release() decrements; at refCount 0 the manager is closed and evicted after
 * a 2-second grace period. The grace window absorbs React StrictMode's
 * mount → unmount → remount cycle (and fast provider swaps) WITHOUT dropping
 * the socket: a re-acquire inside the window cancels the pending close.
 *
 * Keys must be stable and token-free (the auth token is applied per attempt
 * inside the manager's url provider, so it must never leak into the key).
 */

import { WsLifecycleManager, type WsLifecycleOptions } from "@/lib/ws-lifecycle";

/** StrictMode remount window before an unreferenced manager is closed. */
const RELEASE_GRACE_MS = 2_000;

interface RegistryEntry {
  manager: WsLifecycleManager;
  refCount: number;
  releaseTimer: ReturnType<typeof setTimeout> | null;
}

const registry = new Map<string, RegistryEntry>();

export interface AcquiredManager {
  manager: WsLifecycleManager;
  /** Decrement the ref count; idempotent per acquire() call. */
  release: () => void;
}

/**
 * Acquire the shared manager for `key`, creating it from `factory` on first
 * use. The factory runs exactly once per manager lifetime — later acquirers
 * attach via manager.addListener() instead of re-specifying options.
 */
export function acquireManager(
  key: string,
  factory: () => WsLifecycleOptions,
): AcquiredManager {
  let entry = registry.get(key);
  if (entry) {
    if (entry.releaseTimer !== null) {
      clearTimeout(entry.releaseTimer);
      entry.releaseTimer = null;
    }
    entry.refCount += 1;
  } else {
    entry = {
      manager: new WsLifecycleManager(factory()),
      refCount: 1,
      releaseTimer: null,
    };
    registry.set(key, entry);
  }

  const owned = entry;
  let released = false;
  return {
    manager: owned.manager,
    release: () => {
      if (released) return;
      released = true;
      owned.refCount -= 1;
      if (owned.refCount > 0 || owned.releaseTimer !== null) return;
      owned.releaseTimer = setTimeout(() => {
        owned.releaseTimer = null;
        if (owned.refCount > 0) return; // re-acquired during the grace window
        owned.manager.close();
        if (registry.get(key) === owned) registry.delete(key);
      }, RELEASE_GRACE_MS);
      // Never hold the Node.js event loop open for the grace timer (tests/SSR).
      const maybeUnref = owned.releaseTimer as unknown as { unref?: () => void };
      maybeUnref.unref?.();
    },
  };
}

/** Number of live managers (diagnostics/tests). */
export function wsRegistrySize(): number {
  return registry.size;
}

/** Close and evict every manager. Tests only. */
export function resetWsRegistry(): void {
  for (const entry of registry.values()) {
    if (entry.releaseTimer !== null) clearTimeout(entry.releaseTimer);
    entry.releaseTimer = null;
    entry.refCount = 0;
    entry.manager.close();
  }
  registry.clear();
}
