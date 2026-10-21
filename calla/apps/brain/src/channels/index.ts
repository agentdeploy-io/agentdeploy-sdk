/**
 * Messaging-channels module barrel.
 *
 * The integrator only needs two entry points from server.ts:
 *   import { createChannelsApp, startChannels, stopChannels } from "./channels/app.js";
 *   import { buildChannelsDeps } from "./channels/config.js";
 * Everything else is re-exported here for convenience/testing.
 */
export * from "./types.js";
export * from "./util.js";
export * from "./decisions.js";
export * from "./bindings.js";
export * from "./commands.js";
export * from "./config.js";
export * from "./telegram.js";
export * from "./whatsapp.js";
export * from "./facebook.js";
export * from "./notifier.js";
export * from "./app.js";

// ── Social (Instagram + TikTok + WhatsApp customers) ─────────────
export * from "./social/types.js";
export * from "./social/keys.js";
export * from "./social/config.js";
export * from "./social/queue.js";
export * from "./social/senders.js";
export * from "./social/instagram.js";
export * from "./social/tiktok.js";
export * from "./social/whatsapp.js";
export * from "./social/engine.js";
