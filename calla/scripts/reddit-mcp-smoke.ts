/**
 * Reddit MCP sidecar smoke test.
 * ──────────────────────────────────────────────────────────────────────
 * Verifies the brain ↔ reddit-mcp-server wiring end-to-end:
 *   1. /health answers
 *   2. MCP connects, expected tools present
 *   3. test_reddit_mcp_server reports config (read source + write access)
 *   4. browse_subreddit returns posts (read path)
 *   5. get_my_overview — succeeds with user creds, clean error without
 *   6. (opt-in) create_post + reply_to_post in the smoke subreddit
 *
 * Usage:
 *   npx tsx scripts/reddit-mcp-smoke.ts
 *
 * Env:
 *   REDDIT_MCP_URL           sidecar endpoint (default http://127.0.0.1:3011/mcp)
 *   REDDIT_MCP_TOKEN         bearer token when the sidecar has OAUTH_ENABLED
 *   REDDIT_SMOKE_SUBREDDIT   subreddit for the read probe + write post (default "test")
 *   REDDIT_SMOKE_WRITE=1     OPT-IN: actually publishes a post + reply (safe to delete)
 */
import { getRedditMcp, RedditMcpError } from "../apps/brain/src/channels/social/reddit-mcp.js";

const URL = (process.env.REDDIT_MCP_URL ?? "http://127.0.0.1:3011/mcp").trim() || "http://127.0.0.1:3011/mcp";
const SUB = (process.env.REDDIT_SMOKE_SUBREDDIT ?? "test").replace(/^r\//i, "");
const WRITE = (process.env.REDDIT_SMOKE_WRITE ?? "").toLowerCase() === "1";
// The client singleton reads env at construction — export the resolved defaults.
process.env.REDDIT_MCP_URL = URL;
if (process.env.REDDIT_MCP_TOKEN?.trim()) process.env.REDDIT_MCP_TOKEN = process.env.REDDIT_MCP_TOKEN.trim();

let pass = 0;
let fail = 0;
function ok(name: string, detail = "") {
  pass++;
  console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
}
function bad(name: string, detail = "") {
  fail++;
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
}
function info(name: string, detail = "") {
  console.log(`  info  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log(`reddit-mcp smoke: ${URL} (subreddit: r/${SUB}, write: ${WRITE ? "ON" : "off"})`);

// 1. /health (token-free)
try {
  const base = URL.replace(/\/mcp\/?$/, "");
  const res = await fetch(`${base}/health`);
  const body = (await res.json()) as { status?: string };
  if (res.ok && body.status === "running") ok("/health", `status=${body.status}`);
  else bad("/health", `http ${res.status} ${JSON.stringify(body)}`);
} catch (err) {
  bad("/health", err instanceof Error ? err.message : String(err));
  console.log("\nSidecar unreachable — is it running?  docker compose -f docker-compose.reddit.yml up -d");
  process.exit(1);
}

const mcp = getRedditMcp();
if (!mcp.enabled) {
  bad("config", "REDDIT_MCP_URL not set on the running process");
  process.exit(1);
}

// 2. tools/list
const EXPECTED_TOOLS = [
  "test_reddit_mcp_server",
  "browse_subreddit",
  "search_reddit",
  "get_reddit_post",
  "get_post_comments",
  "get_my_overview",
  "create_post",
  "reply_to_post",
];
try {
  const names = await mcp.listToolNames();
  const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
  if (missing.length === 0) ok("tools/list", `${names.length} tools`);
  else bad("tools/list", `missing: ${missing.join(", ")}`);
} catch (err) {
  bad("tools/list", err instanceof Error ? err.message : String(err));
  console.log(`\n${fail} failed, ${pass} passed`);
  process.exit(1);
}

// 3. status report
let statusText = "";
try {
  statusText = await mcp.status();
  ok("test_reddit_mcp_server");
  for (const line of statusText.split("\n")) console.log(`         ${line.trimStart()}`);
} catch (err) {
  bad("test_reddit_mcp_server", err instanceof Error ? err.message : String(err));
}
const writeAccess = /Write Access: ✓/.test(statusText);
const keyless = /Keyless/.test(statusText);
if (!writeAccess) info("write access", "no REDDIT_USERNAME/PASSWORD on sidecar — writes will fail (read-only mode)");
if (keyless) info("read source", "keyless (RSS/Arctic Shift) — set REDDIT_CLIENT_ID/SECRET for live data");

// 4. read path
try {
  const text = await mcp.browseSubreddit({ subreddit: SUB, sort: "new", limit: 3 });
  if (text && !/No posts found/.test(text)) ok("browse_subreddit", `r/${SUB} new(3)`);
  else bad("browse_subreddit", "empty result");
} catch (err) {
  bad("browse_subreddit", err instanceof Error ? err.message : String(err));
}

// 5. get_my_overview (creds required)
try {
  const text = await mcp.getMyOverview({ limit: 3 });
  ok("get_my_overview", `${text.split("\n").length} lines`);
} catch (err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (!writeAccess) info("get_my_overview", `expected without user creds: ${msg.slice(0, 100)}`);
  else bad("get_my_overview", msg);
}

// 6. opt-in write path
if (WRITE) {
  const stamp = new Date().toISOString();
  try {
    const { permalink, postId } = await mcp.createPost({
      subreddit: SUB,
      title: `[calla smoke] reddit-mcp write check ${stamp}`,
      content: "Automated smoke-test post from the Calla outreach pipeline. Safe to delete.",
    });
    if (permalink && postId) ok("create_post", permalink);
    else bad("create_post", "no permalink in sidecar response");
    if (permalink && postId) {
      try {
        const { commentId } = await mcp.replyToPost({
          postId: `t3_${postId}`,
          content: "Smoke-test reply from the Calla outreach pipeline. Safe to delete.",
        });
        if (commentId) ok("reply_to_post", `comment ${commentId}`);
        else bad("reply_to_post", "no comment id in sidecar response");
      } catch (err) {
        bad("reply_to_post", err instanceof Error ? err.message : String(err));
      }
    }
  } catch (err) {
    bad("create_post", err instanceof RedditMcpError ? err.message : err instanceof Error ? err.message : String(err));
  }
} else {
  info("write path", "skipped (set REDDIT_SMOKE_WRITE=1 to publish a post + reply in r/" + SUB + ")");
}

console.log(`\n${fail === 0 ? "OK" : "FAILED"}: ${fail} failed, ${pass} passed`);
await mcp.close();
process.exit(fail === 0 ? 0 : 1);
