/**
 * Social-module store cache keys + TTLs (centralized so the engine, adapters,
 * and trigger store all agree). Everything is written under the fixed agentId
 * "social" — the cache primary key is (key, agentId), so this namespaces the
 * social module away from the "channels" bindings cache.
 */

/** agentId for every social-module cache row. */
export const SOCIAL_CACHE_AGENT = "social";

/** Persisted TriggersConfig (no TTL). */
export const SOCIAL_TRIGGERS_KEY = "social:triggers";

/** Instagram 24h reply-window markers: social:ig:window:<userId>. */
export const IG_WINDOW_PREFIX = "social:ig:window:";

/**
 * WhatsApp 24h customer-service window markers: social:wa:window:<phone>.
 * Same TTL as IG (the Cloud API window is also 24h from the last inbound
 * customer message); outside it auto-send is blocked → approval path.
 */
export const WA_WINDOW_PREFIX = "social:wa:window:";

/** 24h in ms — Instagram's standard messaging reply window. */
export const IG_WINDOW_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * 24h in ms — WhatsApp Cloud API customer-service window (same duration as
 * IG; separate cache prefix so the platforms never collide).
 */
export const WA_WINDOW_TTL_MS = IG_WINDOW_TTL_MS;

/** Dedupe guard so one webhook delivery isn't processed twice. */
export const SOCIAL_SEEN_PREFIX = "social:seen:";
export const SOCIAL_SEEN_TTL_MS = 60 * 60 * 1000;

/**
 * Reddit poller dedupe: social:reddit:seen:<sha1(postId:author:body)>.
 * The sidecar's formatted comment text carries no comment id, so the
 * (post, author, body) hash is the stable identity of one thread reply.
 */
export const REDDIT_SEEN_PREFIX = "social:reddit:seen:";
/** 30 days — long enough that a re-polled thread never re-triggers a reply. */
export const REDDIT_SEEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Capture-by-default per-lead state: social:lead:<leadKey> (NO TTL).
 * Value shape: { firstCapturedAt, lastSeenAt, messageCount, emailCaptured,
 * syncedStage:"raw", firstMessage, firstKind } — see SocialLeadState in engine.ts.
 * Tracks whether a social identity has already been synced to the engine so a
 * re-contact PATCHes (never full-re-syncs, which would clobber stage/status).
 */
export const SOCIAL_LEAD_PREFIX = "social:lead:";

/** Rapid-fire debounce: repeat contacts within this window only bump the count. */
export const SOCIAL_LEAD_DEDUPE_MS = 60 * 1000;

/** Engine sync/patch retry delay (one retry after a failure). */
export const SOCIAL_LEAD_RETRY_MS = 2 * 1000;
