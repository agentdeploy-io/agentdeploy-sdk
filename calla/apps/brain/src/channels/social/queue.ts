/**
 * Shared per-platform sequential send queue.
 *
 * Instagram enforces roughly ~2 sends/sec per account; bursting risks throttling
 * or a temporary send block. We therefore serialize outbound sends PER PLATFORM
 * and space consecutive deliveries by `spacingMs` (default 600ms → ~1.6/sec,
 * comfortably under the cap). Both the engine's auto-send path and the
 * decisions.ts approved-send path funnel through this so the rate limit is
 * honored regardless of who initiates the send.
 *
 * The queue never rejects the chain on a task failure: each platform keeps an
 * independent promise chain, and a failing task is swallowed into the chain link
 * (the caller still receives the rejection from the returned promise) so one
 * error cannot wedge subsequent sends.
 */
import { sleep } from "../util.js";

export const DEFAULT_SEND_SPACING_MS = 600;

export class SendQueue {
  private readonly chains = new Map<string, Promise<unknown>>();
  private readonly lastAt = new Map<string, number>();

  constructor(private readonly spacingMs: number = DEFAULT_SEND_SPACING_MS) {}

  /**
   * Run `task` after every previously-enqueued task for the same key, waiting
   * out the remaining spacing first. Resolves/rejects with the task's result.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(async () => {
      const now = Date.now();
      const last = this.lastAt.get(key) ?? 0;
      const wait = this.spacingMs - (now - last);
      if (wait > 0) await sleep(wait);
      this.lastAt.set(key, Date.now());
      return task();
    });
    // Keep the chain alive even if this task throws.
    this.chains.set(
      key,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }
}

/** Process-wide queue shared by every social send. */
export const socialSendQueue = new SendQueue();

/** Convenience wrapper over the shared queue. */
export function enqueueSocialSend<T>(
  platform: string,
  task: () => Promise<T>,
): Promise<T> {
  return socialSendQueue.enqueue(platform, task);
}
