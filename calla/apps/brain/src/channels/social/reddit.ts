/**
 * Reddit channel adapter + inbound poller (WAVE-3 outreach).
 * ──────────────────────────────────────────────────────────────────────────
 * Outbound: replies go through the reddit-mcp-server sidecar (reddit-mcp.ts)
 * — the adapter maps the SocialAdapter contract onto `reply_to_post`. For
 * reddit both `externalUserId` and `commentId` carry the PARENT thing id
 * (`t3_<postId>` for a thread reply, `t1_<commentId>` for a nested one), so
 * `sendText` and `sendPrivateReply` are the same call.
 *
 * Inbound: Reddit has no webhook — `pollRedditInbound` runs on an interval
 * (REDDIT_POLL_MINUTES, default 20, min 5):
 *   1. get_my_overview → my recent posts (needs user creds on the sidecar)
 *   2. get_post_comments per post (max 5 per cycle)
 *   3. new non-OP comments → SocialInbound {platform:"reddit", kind:"comment"}
 *      → handleSocialInbound (triggers, lead capture, persona, HITL gate)
 *
 * The sidecar returns FORMATTED MARKDOWN, not JSON — the parsers below
 * extract the minimal structured bits (post ids, comment author/body) and
 * the LLM-facing text stays in `SocialInbound.text` untouched. v1 limitation
 * (documented): a comment body containing a line that is exactly `---`
 * truncates that comment's parsed body; nested replies are normalized to the
 * post-level thread (the formatted text carries no comment ids).
 */
import { createHash } from "node:crypto";
import { handleSocialInbound } from "./engine.js";
import { getRedditMcp } from "./reddit-mcp.js";
import { REDDIT_SEEN_PREFIX, REDDIT_SEEN_TTL_MS, SOCIAL_CACHE_AGENT } from "./keys.js";
import type { RedditConfig, SocialAdapter, SocialDeps, SocialInbound } from "./types.js";

/** Max own posts scanned per poll cycle (each = 1 API call on the sidecar). */
const MAX_POSTS_PER_CYCLE = 5;
/** Max comments parsed per post per cycle. */
const MAX_COMMENTS_PER_POST = 50;
/** Cooldown for repeated poller failure warnings (ms). */
const POLL_WARN_COOLDOWN_MS = 15 * 60 * 1000;

let lastPollWarnAt = 0;
function pollWarn(message: string): void {
  const now = Date.now();
  if (now - lastPollWarnAt < POLL_WARN_COOLDOWN_MS) return;
  lastPollWarnAt = now;
  console.warn("[channels:social:reddit]", message);
}

/** One of the account's own recent posts (from get_my_overview). */
export interface RedditOwnPost {
  /** Base36 post id (the /comments/<id>/ permalink segment). */
  postId: string;
  /** Subreddit without the r/ prefix. */
  subreddit: string;
  /** https://reddit.com/r/<sub>/comments/<id>/… */
  url: string;
}

/** One parsed thread comment (from get_post_comments). */
export interface RedditThreadComment {
  author: string;
  body: string;
  /** 0 = top-level, 1+ = nested (depth is informational only in v1). */
  depth: number;
  /** True when the commenter is the post's author (OP). */
  isOP: boolean;
}

/**
 * Parse `formatUserContent` "## Posts (N)" lines:
 *   `1. <title> — r/<sub>, score 12 — https://reddit.com/r/<sub>/comments/<id>/…`
 * Scoped to the Posts section — comment permalinks in the "## Comments"
 * section also contain /comments/<id>/ and must not be treated as posts.
 */
export function parseMyPosts(overviewText: string): RedditOwnPost[] {
  const out: RedditOwnPost[] = [];
  const urlRe = /https:\/\/reddit\.com\/r\/([^/\s]+)\/comments\/([a-z0-9]+)/i;
  let inPosts = false;
  for (const line of overviewText.split("\n")) {
    if (/^##\s+/.test(line)) {
      inPosts = /^##\s+Posts\b/i.test(line);
      continue;
    }
    if (!inPosts || !/^\s*\d+\.\s/.test(line)) continue;
    const m = line.match(urlRe);
    if (m) out.push({ subreddit: m[1], postId: m[2], url: m[0] });
  }
  return out;
}

/**
 * Parse `get_post_comments` thread text. A comment block is:
 *   `(└─)* **u/<author>**[ **[OP]**][ *(edited)*] (N points)`
 *   followed by the body, terminated by a line that is exactly `---`.
 */
export function parseThreadComments(threadText: string): RedditThreadComment[] {
  const headerRe =
    /^(?:└─)*\s*\*\*u\/([^*\n]+)\*\*(?: \*\*\[OP\]\*\*)?(?: \*\(edited\)\*)? \([\d,]+ points\)$/;
  const out: RedditThreadComment[] = [];
  const lines = threadText.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(headerRe);
    if (!m) {
      i++;
      continue;
    }
    const depth = Math.floor(lines[i].indexOf("**") / 2);
    const isOP = lines[i].includes("**[OP]**");
    const author = m[1].trim();
    i++;
    while (i < lines.length && lines[i].trim() === "") i++;
    const body: string[] = [];
    while (i < lines.length && lines[i].trim() !== "---") {
      body.push(lines[i]);
      i++;
    }
    i++; // skip the --- separator
    const text = body.join("\n").trim();
    if (text) out.push({ author, body: text, depth, isOP });
    if (out.length >= MAX_COMMENTS_PER_POST) break;
  }
  return out;
}

/** The Reddit SocialAdapter — replies are `reply_to_post` on the sidecar. */
export class RedditAdapter implements SocialAdapter {
  readonly platform = "reddit" as const;
  readonly enabled: boolean;

  constructor(cfg: RedditConfig) {
    this.enabled = cfg.enabled;
  }

  async sendText(target: string, text: string): Promise<void> {
    await getRedditMcp().replyToPost({ postId: target, content: text });
  }

  async sendPrivateReply(commentId: string, text: string): Promise<void> {
    await getRedditMcp().replyToPost({ postId: commentId, content: text });
  }

  /** Reddit has no webhook — inbound is poller-driven (pollRedditInbound). */
  parseWebhook(): SocialInbound[] {
    return [];
  }
}

/**
 * One poller cycle: find new non-OP replies on my recent posts and funnel
 * each through handleSocialInbound (deduped in the store cache).
 */
export async function pollRedditInbound(deps: SocialDeps): Promise<void> {
  const mcp = getRedditMcp();
  if (!mcp.enabled) return;

  let overview: string;
  try {
    overview = await mcp.getMyOverview({ limit: 25 });
  } catch (err) {
    pollWarn(
      `get_my_overview failed (Reddit user creds missing on the sidecar, or sidecar down): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return;
  }

  const posts = parseMyPosts(overview).slice(0, MAX_POSTS_PER_CYCLE);
  for (const post of posts) {
    let threadText: string;
    try {
      threadText = await mcp.getPostComments({
        subreddit: post.subreddit,
        postId: post.postId,
        sort: "new",
        limit: MAX_COMMENTS_PER_POST,
      });
    } catch (err) {
      pollWarn(`get_post_comments ${post.postId} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    for (const comment of parseThreadComments(threadText)) {
      if (comment.isOP) continue;
      const seenKey = `${REDDIT_SEEN_PREFIX}${createHash("sha1")
        .update(`${post.postId}:${comment.author}:${comment.body}`)
        .digest("hex")}`;
      const seen = await deps.store.cacheGet(seenKey, SOCIAL_CACHE_AGENT).catch(() => null);
      if (seen) continue;
      await deps.store
        .cacheSet(seenKey, SOCIAL_CACHE_AGENT, Date.now(), REDDIT_SEEN_TTL_MS)
        .catch(() => {});

      const msg: SocialInbound = {
        platform: "reddit",
        kind: "comment",
        externalUserId: `t3_${post.postId}`,
        username: comment.author,
        text: comment.body,
        commentId: `t3_${post.postId}`,
        raw: { postId: post.postId, permalink: post.url, depth: comment.depth },
      };
      await handleSocialInbound(msg, deps);
    }
  }
}

/**
 * Start the reddit poller. Returns the stop function (called by
 * stopChannels). Safe to run with an unreachable sidecar / no credentials —
 * each cycle degrades to a rate-limited warning.
 */
export function startRedditPolling(deps: SocialDeps, pollMinutes: number): () => void {
  let stopped = false;
  let inFlight = false;
  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await pollRedditInbound(deps);
    } catch (err) {
      pollWarn(`poll cycle failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      inFlight = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), pollMinutes * 60 * 1000);
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
