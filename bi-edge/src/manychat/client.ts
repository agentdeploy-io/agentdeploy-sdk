/// <reference types="@cloudflare/workers-types" />

/**
 * Minimal ManyChat public-API client (Page API).
 *
 * Base: https://api.manychat.com   Auth: Authorization: Bearer <api_key>
 * (api_key format "<account_id>:<secret>"; confirmed via the live swagger at
 *  https://api.manychat.com/swagger). The classic /api/v1/* base no longer
 * exists — the live routes are /fb/page/*, /fb/sending/*, /fb/subscriber/*.
 *
 * NOTE: the public API is a paid-plan feature. On the Free tier the key
 * returns 401 {"status":"error","message":"Wrong token"}.
 */

export const MANYCHAT_BASE = "https://api.manychat.com";

export class ManyChatError extends Error {
  status: number;
  apiMessage: string;
  constructor(status: number, apiMessage: string, path: string) {
    super(`Manychat ${status} on ${path}: ${apiMessage}`);
    this.name = "ManyChatError";
    this.status = status;
    this.apiMessage = apiMessage;
  }
}

export interface ManyChatPage {
  id: number;
  name: string;
  category: string;
  avatar_link: string;
  username: string;
  about: string;
  description: string;
  is_pro: boolean;
  timezone: string;
}

export interface ManyChatTag {
  id: number;
  name: string;
}

export interface ManyChatSubscriber {
  id: string;
  page_id: string;
  user_refs: Array<{ user_ref: string; opted_in: string }>;
  first_name: string;
  last_name: string;
  name: string;
  gender: string;
  profile_pic: string;
  locale: string;
  language: string;
  timezone: string;
  email: string;
  phone: string;
  ig_username: string;
  ig_id: string;
  whatsapp_phone: string;
  subscribed: boolean;
  last_interaction: string;
  last_seen: string;
  custom_fields: Record<string, unknown>;
  tags: Array<{ id: number; name: string }>;
  [k: string]: unknown;
}

async function request<T>(
  path: string,
  opts: { method?: string; body?: unknown } = {},
  env: Record<string, unknown>,
): Promise<T> {
  const key = String(env.MANYCHAT_API_KEY ?? "").trim();
  if (!key) {
    throw new ManyChatError(0, "MANYCHAT_API_KEY is not configured", path);
  }
  const res = await fetch(MANYCHAT_BASE + path, {
    method: opts.method ?? (opts.body === undefined ? "GET" : "POST"),
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg =
      (json && (json.message ?? json.error)) ||
      (typeof json === "string" ? json : "") ||
      res.statusText ||
      "request failed";
    throw new ManyChatError(res.status, String(msg), path);
  }
  return (json ?? {}) as T;
}

/** Connectivity + account check. Throws ManyChatError on auth failure. */
export async function manychatPageInfo(env: Record<string, unknown>): Promise<ManyChatPage> {
  const r = await request<{ status: string; data: ManyChatPage }>(
    "/fb/page/getInfo",
    {},
    env,
  );
  return r.data;
}

export async function manychatSubscriberInfo(
  subscriberId: number | string,
  env: Record<string, unknown>,
): Promise<ManyChatSubscriber> {
  const r = await request<{ status: string; data: ManyChatSubscriber }>(
    `/fb/subscriber/getInfo?subscriber_id=${encodeURIComponent(String(subscriberId))}`,
    {},
    env,
  );
  return r.data;
}

export interface CreateSubscriberInput {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  whatsapp_phone?: string;
  gender?: string;
  has_opt_in_sms?: boolean;
  has_opt_in_email?: boolean;
  has_opt_in_whatsapp?: boolean;
  custom_fields?: Record<string, unknown>;
  tags?: number[];
}

export async function manychatCreateSubscriber(
  input: CreateSubscriberInput,
  env: Record<string, unknown>,
): Promise<ManyChatSubscriber> {
  const r = await request<{ status: string; data: ManyChatSubscriber }>(
    "/fb/subscriber/createSubscriber",
    { body: input },
    env,
  );
  return r.data;
}

export interface SendContentInput {
  /** Dynamic-block v2 payload. most callers should use manychatSendText(). */
  data: Record<string, unknown>;
  /** Messenger message tag, required after 2020-03-04 for most sends. */
  message_tag?: string;
  otn_topic_name?: string;
}

export async function manychatSendContent(
  subscriberId: number | string,
  input: SendContentInput,
  env: Record<string, unknown>,
): Promise<void> {
  await request(
    "/fb/sending/sendContent",
    {
      body: {
        subscriber_id: Number(subscriberId),
        data: input.data,
        ...(input.message_tag ? { message_tag: input.message_tag } : {}),
        ...(input.otn_topic_name ? { otn_topic_name: input.otn_topic_name } : {}),
      },
    },
    env,
  );
}

/** Send a plain text message (dynamic block v2). */
export async function manychatSendText(
  subscriberId: number | string,
  text: string,
  env: Record<string, unknown>,
): Promise<void> {
  await manychatSendContent(
    subscriberId,
    {
      data: {
        version: "v2",
        content: {
          messages: [{ type: "text", text }],
          actions: [],
          quick_replies: [],
        },
      },
    },
    env,
  );
}

export async function manychatGetTags(env: Record<string, unknown>): Promise<ManyChatTag[]> {
  const r = await request<{ status: string; data: ManyChatTag[] }>("/fb/page/getTags", {}, env);
  return r.data;
}

export async function manychatCreateTag(name: string, env: Record<string, unknown>): Promise<ManyChatTag> {
  const r = await request<{ status: string; data: { tag: ManyChatTag } }>(
    "/fb/page/createTag",
    { body: { name } },
    env,
  );
  return r.data.tag;
}

export async function manychatAddTagToSubscriber(
  subscriberId: number | string,
  tagName: string,
  env: Record<string, unknown>,
): Promise<void> {
  await request(
    "/fb/subscriber/addTagByName",
    { body: { subscriber_id: Number(subscriberId), tag_name: tagName } },
    env,
  );
}
