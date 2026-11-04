/**
 * Reddit MCP client — brain-side consumer of the jordanburke/reddit-mcp-server
 * sidecar (streamable-HTTP mode).
 * ──────────────────────────────────────────────────────────────────────────
 * Mirrors the booking external-MCP client (src/booking/mcp-client.ts): the
 * sidecar is a separate long-lived process holding the Reddit OAuth + user
 * credentials (REDDIT_CLIENT_ID/SECRET/USERNAME/PASSWORD on the SERVER side),
 * and the brain talks to it over MCP with an optional bearer token. Keeping
 * the credentials out of the brain process is the point: the sidecar also
 * provides the anti-spam safety rails (safe-mode write pacing, duplicate +
 * cross-subreddit detection, bot-disclosure footer).
 *
 * Tool surface (jordanburke/reddit-mcp-server v2.x):
 *   reads  — test_reddit_mcp_server, browse_subreddit, search_reddit,
 *            get_reddit_post, get_post_comments, get_more_comments,
 *            get_my_overview, get_subreddit_info, get_subreddit_rules
 *   writes — create_post, reply_to_post, edit_post, edit_comment,
 *            delete_post, delete_comment, save_content, unsave_content
 *
 * NOTE: every tool returns FORMATTED MARKDOWN TEXT, not JSON — the reads are
 * written for LLM consumption, so the brain's agents get to use the raw text
 * directly. The two writes get light parsing so the posting pipeline can
 * record the published permalink / comment id for dedupe + audit.
 *
 * Disabled (enabled=false) when REDDIT_MCP_URL is unset — the social engine
 * then never enables the reddit platform. All tools are exact-name mapped
 * (pinned server version, no heuristic resolution).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export class RedditMcpError extends Error {
  constructor(
    message: string,
    /** 501 = not configured, 502 = sidecar/upstream failure. */
    readonly status: 501 | 502,
  ) {
    super(message);
    this.name = "RedditMcpError";
  }
}

export interface RedditMcpConfig {
  /** Streamable-HTTP MCP endpoint, e.g. http://127.0.0.1:3011/mcp */
  url?: string;
  /** Bearer token when the sidecar runs with OAUTH_ENABLED=true. */
  token?: string;
}

export function readRedditMcpConfig(): RedditMcpConfig {
  const env = process.env;
  const clean = (v: string | undefined): string | undefined => {
    const t = (v ?? "").trim();
    return t.length > 0 ? t : undefined;
  };
  return {
    url: clean(env.REDDIT_MCP_URL),
    token: clean(env.REDDIT_MCP_TOKEN),
  };
}

export type RedditSort = "hot" | "new" | "top" | "rising" | "controversial";
export type RedditTimeFilter = "hour" | "day" | "week" | "month" | "year" | "all";
export type RedditSearchSort = "relevance" | "hot" | "top" | "new" | "comments";
export type RedditCommentSort = "best" | "top" | "new" | "controversial" | "old" | "qa";

export interface BrowseSubredditInput {
  /** Subreddit without the r/ prefix; omit for the authenticated home feed. */
  subreddit?: string;
  sort?: RedditSort;
  timeFilter?: RedditTimeFilter;
  limit?: number;
  after?: string;
}

export interface SearchRedditInput {
  query: string;
  subreddit?: string;
  sort?: RedditSearchSort;
  timeFilter?: RedditTimeFilter;
  limit?: number;
  type?: "link" | "sr" | "user";
  after?: string;
}

export interface CreatePostInput {
  /** Subreddit without the r/ prefix. */
  subreddit: string;
  title: string;
  /** Self-post body (Reddit markdown) when isSelf; destination URL otherwise. */
  content: string;
  isSelf?: boolean;
  flairId?: string;
  flairText?: string;
}

/** A lazily-connected MCP client to the reddit-mcp-server sidecar. */
export class RedditMcp {
  private client: Client | null = null;
  private connectPromise: Promise<Client> | null = null;
  private toolNames: string[] | null = null;
  readonly enabled: boolean;

  constructor(private readonly cfg: RedditMcpConfig = readRedditMcpConfig()) {
    this.enabled = Boolean(cfg.url);
  }

  private async ensureClient(): Promise<Client> {
    if (this.client) return this.client;
    if (this.connectPromise) return this.connectPromise;
    if (!this.cfg.url) {
      throw new RedditMcpError("reddit MCP not configured (REDDIT_MCP_URL)", 501);
    }
    this.connectPromise = (async () => {
      const transport = new StreamableHTTPClientTransport(new URL(this.cfg.url!), {
        ...(this.cfg.token
          ? { requestInit: { headers: { authorization: `Bearer ${this.cfg.token}` } } }
          : {}),
      });
      const client = new Client({ name: "calla-social", version: "1.0.0" });
      await client.connect(transport);
      this.client = client;
      return client;
    })().finally(() => {
      this.connectPromise = null;
    });
    return this.connectPromise;
  }

  /** Discover tool names once (cached). */
  async listToolNames(): Promise<string[]> {
    if (this.toolNames) return this.toolNames;
    const client = await this.ensureClient();
    const res = await client.listTools();
    this.toolNames = (res.tools ?? []).map((t) => t.name);
    return this.toolNames;
  }

  /** Call a tool and return its text payload; throws RedditMcpError on failure. */
  async callText(tool: string, args: Record<string, unknown>): Promise<string> {
    let result: { content?: unknown; structuredContent?: unknown; isError?: boolean };
    try {
      const client = await this.ensureClient();
      result = (await client.callTool({ name: tool, arguments: args })) as typeof result;
    } catch (err) {
      throw new RedditMcpError(
        `reddit MCP "${tool}" failed: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    }
    const text =
      typeof result?.structuredContent === "string"
        ? result.structuredContent
        : Array.isArray(result?.content)
          ? (result.content as Array<{ type: string; text?: string }>)
              .find((b) => b?.type === "text" && typeof b.text === "string")
              ?.text
          : undefined;
    if (result?.isError || !text) {
      throw new RedditMcpError(
        `reddit MCP "${tool}" returned an error: ${text ?? "no content"}`,
        502,
      );
    }
    return text;
  }

  // ── Reads (formatted markdown for LLM consumption) ─────────────────

  /** Sidecar health/config report — no Reddit API calls. */
  async status(): Promise<string> {
    return this.callText("test_reddit_mcp_server", {});
  }

  /** Browse a subreddit feed (or the home feed without `subreddit`). */
  async browseSubreddit(input: BrowseSubredditInput = {}): Promise<string> {
    const args: Record<string, unknown> = {};
    if (input.subreddit) args.subreddit = input.subreddit;
    if (input.sort) args.sort = input.sort;
    if (input.timeFilter) args.time_filter = input.timeFilter;
    if (input.limit) args.limit = input.limit;
    if (input.after) args.after = input.after;
    return this.callText("browse_subreddit", args);
  }

  /** Keyword search across posts/subreddits/users. */
  async searchReddit(input: SearchRedditInput): Promise<string> {
    const args: Record<string, unknown> = { query: input.query };
    if (input.subreddit) args.subreddit = input.subreddit;
    if (input.sort) args.sort = input.sort;
    if (input.timeFilter) args.time_filter = input.timeFilter;
    if (input.limit) args.limit = input.limit;
    if (input.type) args.type = input.type;
    if (input.after) args.after = input.after;
    return this.callText("search_reddit", args);
  }

  /** A single post by subreddit + base36 id. */
  async getPost(input: { subreddit: string; postId: string }): Promise<string> {
    return this.callText("get_reddit_post", {
      subreddit: input.subreddit,
      post_id: input.postId,
    });
  }

  /** The threaded comment tree for a post. */
  async getPostComments(input: {
    subreddit: string;
    postId: string;
    sort?: RedditCommentSort;
    limit?: number;
  }): Promise<string> {
    const args: Record<string, unknown> = {
      subreddit: input.subreddit,
      post_id: input.postId,
    };
    if (input.sort) args.sort = input.sort;
    if (input.limit) args.limit = input.limit;
    return this.callText("get_post_comments", args);
  }

  /** The authenticated account's recent posts + comments (needs user creds). */
  async getMyOverview(input: { limit?: number; after?: string } = {}): Promise<string> {
    const args: Record<string, unknown> = {};
    if (input.limit) args.limit = input.limit;
    if (input.after) args.after = input.after;
    return this.callText("get_my_overview", args);
  }

  // ── Writes (need user creds on the sidecar; NOT idempotent) ─────────

  /**
   * Publish a post. Returns the sidecar's confirmation text plus the parsed
   * permalink and base36 post id (for the post log / reply polling).
   */
  async createPost(input: CreatePostInput): Promise<{
    text: string;
    permalink?: string;
    postId?: string;
  }> {
    const args: Record<string, unknown> = {
      subreddit: input.subreddit,
      title: input.title,
      content: input.content,
    };
    if (input.isSelf !== undefined) args.is_self = input.isSelf;
    if (input.flairId) args.flair_id = input.flairId;
    if (input.flairText) args.flair_text = input.flairText;
    const text = await this.callText("create_post", args);
    const permalink = text.match(/Link:\s*(https?:\/\/\S+)/)?.[1];
    const postId = permalink?.match(/comments\/([a-z0-9]+)/i)?.[1];
    return { text, ...(permalink ? { permalink, postId } : {}) };
  }

  /**
   * Reply under a post (`t3_<id>`) or comment (`t1_<id>`). Returns the
   * sidecar's confirmation text plus the parsed new comment id.
   */
  async replyToPost(input: { postId: string; content: string }): Promise<{
    text: string;
    commentId?: string;
  }> {
    const text = await this.callText("reply_to_post", {
      post_id: input.postId,
      content: input.content,
    });
    const commentId = text.match(/Comment ID:\s*(\S+)/)?.[1];
    return { text, ...(commentId ? { commentId } : {}) };
  }

  async close(): Promise<void> {
    try {
      await this.client?.close();
    } catch {
      /* ignore */
    }
    this.client = null;
    this.toolNames = null;
  }
}

/** Process-wide singleton (lazily created). */
let singleton: RedditMcp | null = null;
export function getRedditMcp(): RedditMcp {
  if (!singleton) singleton = new RedditMcp();
  return singleton;
}
