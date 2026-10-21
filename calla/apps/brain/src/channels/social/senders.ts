/**
 * Social sender registry — the decoupling seam between channels/decisions.ts
 * and the social adapters.
 *
 * WHY A SEPARATE MODULE: when an operator approves a social reply from an
 * EXISTING Telegram/WhatsApp approval card, decisions.executeDecision() must
 * deliver it via the right Instagram/TikTok adapter. decisions.ts lives in the
 * channels core and must NOT import the social engine (the engine imports
 * decisions.ts for rowToApprovalRequest → that would be a cycle). This tiny
 * module owns a platform → sender map: app.ts registers the live adapters at
 * boot, decisions.ts looks them up at decision time. It imports nothing from
 * decisions.ts or engine.ts, so both directions stay acyclic.
 */
import type { SocialPlatform } from "./types.js";

/** Deliver an approved social reply (DM, or an IG comment private reply). */
export interface SocialSender {
  /**
   * @param target     external user id (DM recipient).
   * @param text        the approved draft.
   * @param commentId   when present, send as an IG comment private reply.
   */
  send(target: string, text: string, commentId?: string): Promise<void>;
}

const senders = new Map<SocialPlatform, SocialSender>();

/** Register (or replace) the sender for a platform. Called once at boot. */
export function registerSocialSender(
  platform: SocialPlatform,
  sender: SocialSender,
): void {
  senders.set(platform, sender);
}

/** Look up the sender for a platform (undefined when disabled/unwired). */
export function getSocialSender(platform: SocialPlatform): SocialSender | undefined {
  return senders.get(platform);
}

/** Test helper: drop every registered sender. */
export function clearSocialSenders(): void {
  senders.clear();
}
