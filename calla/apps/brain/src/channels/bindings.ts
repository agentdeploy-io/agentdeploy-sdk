/**
 * Bindings — map a Telegram/WhatsApp chat to Calla using ONLY the existing
 * CallaStore cache (cacheGet/cacheSet). The CallaStore interface is NOT
 * extended. Because the cache has no scan/list, we maintain our own index at
 * "chan:index" so listBindings() can enumerate every live binding.
 *
 * Cache keys (all under the fixed agentId "channels"):
 *   chan:code:<code>            -> { platform?, createdAt }   TTL 10 min
 *   chan:bind:<platform>:<chat> -> Binding                    no TTL
 *   chan:index                  -> { platform, chatId }[]     no TTL
 */
import type { CallaStore } from "../store/types.js";
import type { Binding, BindingStore, ChannelPlatform } from "./types.js";
import { randomCode } from "./util.js";

/** All channel cache rows share this agentId (the cache PK is (key, agentId)). */
export const CHANNELS_CACHE_AGENT = "channels";

const CODE_PREFIX = "chan:code:";
const BIND_PREFIX = "chan:bind:";
const INDEX_KEY = "chan:index";

const CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const CODE_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
const CODE_LENGTH = 6;

interface CodeRecord {
  platform: ChannelPlatform | null;
  createdAt: string;
}

interface IndexEntry {
  platform: ChannelPlatform;
  chatId: string;
}

function bindKey(platform: ChannelPlatform, chatId: string): string {
  return `${BIND_PREFIX}${platform}:${chatId}`;
}

export class CacheBindingStore implements BindingStore {
  constructor(private readonly store: CallaStore) {}

  async createBindingCode(platform?: ChannelPlatform): Promise<string> {
    // Retry a few times on the (astronomically unlikely) code collision.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const code = randomCode(CODE_LENGTH, CODE_ALPHABET);
      const existing = await this.store
        .cacheGet<CodeRecord>(`${CODE_PREFIX}${code}`, CHANNELS_CACHE_AGENT)
        .catch(() => null);
      if (existing) continue;
      const record: CodeRecord = {
        platform: platform ?? null,
        createdAt: new Date().toISOString(),
      };
      await this.store.cacheSet(
        `${CODE_PREFIX}${code}`,
        CHANNELS_CACHE_AGENT,
        record,
        CODE_TTL_MS,
      );
      return code;
    }
    throw new Error("Could not allocate a unique binding code");
  }

  async redeemBindingCode(
    code: string,
    platform: ChannelPlatform,
    chatId: string,
    userId: string | null = null,
  ): Promise<Binding> {
    const normalized = String(code ?? "").trim().toUpperCase();
    const record = await this.store
      .cacheGet<CodeRecord>(`${CODE_PREFIX}${normalized}`, CHANNELS_CACHE_AGENT)
      .catch(() => null);
    if (!record) {
      throw new Error("Invalid or expired binding code. Request a fresh one and try again.");
    }
    if (record.platform && record.platform !== platform) {
      throw new Error(
        `That code was issued for ${record.platform}, but you are binding from ${platform}.`,
      );
    }

    const binding: Binding = {
      platform,
      chatId,
      userId: userId ?? null,
      boundAt: new Date().toISOString(),
      code: normalized,
    };
    await this.store.cacheSet(
      bindKey(platform, chatId),
      CHANNELS_CACHE_AGENT,
      binding,
      null,
    );
    // Single-use: expire the code immediately.
    await this.store
      .cacheSet(`${CODE_PREFIX}${normalized}`, CHANNELS_CACHE_AGENT, null, 1)
      .catch(() => {});
    await this.addToIndex(platform, chatId);
    return binding;
  }

  async isBound(platform: ChannelPlatform, chatId: string): Promise<boolean> {
    const binding = await this.getBinding(platform, chatId);
    return Boolean(binding);
  }

  async getBinding(
    platform: ChannelPlatform,
    chatId: string,
  ): Promise<Binding | null> {
    const binding = await this.store
      .cacheGet<Binding>(bindKey(platform, chatId), CHANNELS_CACHE_AGENT)
      .catch(() => null);
    return binding ?? null;
  }

  async listBindings(): Promise<Binding[]> {
    const index = await this.readIndex();
    const bindings: Binding[] = [];
    const live: IndexEntry[] = [];
    for (const entry of index) {
      const binding = await this.getBinding(entry.platform, entry.chatId);
      if (binding) {
        bindings.push(binding);
        live.push(entry);
      }
    }
    // Prune index entries whose binding has disappeared (best-effort).
    if (live.length !== index.length) {
      await this.writeIndex(live).catch(() => {});
    }
    return bindings;
  }

  async unbind(platform: ChannelPlatform, chatId: string): Promise<void> {
    await this.store
      .cacheSet(bindKey(platform, chatId), CHANNELS_CACHE_AGENT, null, 1)
      .catch(() => {});
    await this.removeFromIndex(platform, chatId);
  }

  // ─── Index maintenance ────────────────────────────────────────

  private async readIndex(): Promise<IndexEntry[]> {
    const raw = await this.store
      .cacheGet<IndexEntry[]>(INDEX_KEY, CHANNELS_CACHE_AGENT)
      .catch(() => null);
    return Array.isArray(raw) ? raw : [];
  }

  private async writeIndex(index: IndexEntry[]): Promise<void> {
    await this.store.cacheSet(INDEX_KEY, CHANNELS_CACHE_AGENT, index, null);
  }

  private async addToIndex(
    platform: ChannelPlatform,
    chatId: string,
  ): Promise<void> {
    const index = await this.readIndex();
    const exists = index.some(
      (e) => e.platform === platform && e.chatId === chatId,
    );
    if (exists) return;
    index.push({ platform, chatId });
    await this.writeIndex(index);
  }

  private async removeFromIndex(
    platform: ChannelPlatform,
    chatId: string,
  ): Promise<void> {
    const index = await this.readIndex();
    const next = index.filter(
      (e) => !(e.platform === platform && e.chatId === chatId),
    );
    if (next.length !== index.length) await this.writeIndex(next);
  }
}
