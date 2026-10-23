/**
 * A cache of raw guild structure: channels, roles, emojis, stickers and the
 * bot's own member, which is what discord.js needs to build `Message`,
 * `Interaction` and friends with `guild`, `channel` and permissions filled in.
 *
 * Each guild's structure is an immutable state with a revision number. A
 * change creates a new state, and the previous few are kept, so the gateway
 * can hand a function the snapshot an event was sent against even after
 * the guild has changed again.
 */
import type { APIGuildMember, APIUser } from 'discord-api-types/v10';
import { type DispatchPacket, GUILD_AVAILABLE, type GuildRef, type GuildSnapshot } from './protocol.ts';

type Raw = Record<string, any>;

interface GuildState {
  readonly rev: number;
  readonly base: Raw;
  readonly channels: ReadonlyMap<string, Raw>;
  readonly roles: ReadonlyMap<string, Raw>;
  readonly emojis: readonly Raw[];
  readonly stickers: readonly Raw[];
  readonly me: Raw | undefined;
}

interface GuildEntry {
  shardId: number;
  state: GuildState;
  /** Earlier states, newest first. */
  history: GuildState[];
  /**
   * Active threads. They're sent with the events that happen in them rather
   * than in snapshots, so busy threads don't churn the guild's revision.
   */
  threads: Map<string, Raw>;
  /** Sent with every event rather than revisioned, since joins and leaves are frequent. */
  memberCount: number | undefined;
}

/** How many superseded states to keep per guild for in-flight batches. */
const HISTORY = 4;

/** GUILD_CREATE keys that are cached separately, or not at all. */
const COLLECTION_KEYS = new Set([
  'channels',
  'threads',
  'roles',
  'emojis',
  'stickers',
  'members',
  'presences',
  'voice_states',
  'stage_instances',
  'guild_scheduled_events',
  'soundboard_sounds',
  'member_count',
]);

export class GatewayCache {
  user: APIUser | undefined;
  application: { id: string; flags?: number } | undefined;

  readonly #guilds = new Map<string, GuildEntry>();
  /** Guilds we know about that are waiting for (or lost) their GUILD_CREATE. */
  readonly #unavailable = new Set<string>();
  /** Seeded from the clock so revisions stay unique across gateway restarts. */
  #rev = Date.now() * 1000;

  get guildCount(): number {
    return this.#guilds.size;
  }

  /**
   * The dispatch type to filter on, or `null` for packets that must never be
   * forwarded. Mirrors discord.js: a GUILD_CREATE is only `guildCreate` when
   * the bot joins a guild it didn't know about.
   */
  kindOf(packet: DispatchPacket): string | null {
    if (packet.t !== 'GUILD_CREATE') return packet.t;
    if (packet.d.unavailable) return null;
    if (this.#unavailable.has(packet.d.id)) return GUILD_AVAILABLE;
    return this.#guilds.has(packet.d.id) ? null : 'GUILD_CREATE';
  }

  /** The guild an event belongs to, as of before the event. Call before `apply()`. */
  refFor(packet: DispatchPacket): GuildRef | undefined {
    const id = packet.t === 'GUILD_CREATE' || packet.t === 'GUILD_UPDATE' || packet.t === 'GUILD_DELETE' ? packet.d.id : packet.d.guild_id;
    if (typeof id !== 'string') return undefined;
    if (this.#unavailable.has(id)) return { id, unavailable: true };
    if (packet.t === 'GUILD_CREATE') return undefined;
    const entry = this.#guilds.get(id);
    return entry && { id, rev: entry.state.rev, memberCount: entry.memberCount };
  }

  /** The cached thread an event happened in, if any. Call before `apply()`. */
  threadFor(packet: DispatchPacket): Raw | undefined {
    const threads = this.#guilds.get(packet.d.guild_id)?.threads;
    if (!threads?.size) return undefined;
    for (const id of [packet.d.channel_id, packet.d.channel?.id, packet.t.startsWith('THREAD_') && packet.d.id]) {
      const thread = typeof id === 'string' ? threads.get(id) : undefined;
      if (thread) return thread;
    }
    return undefined;
  }

  /**
   * The guild at revision `rev`, or its current state if that revision has
   * aged out of the history (then the event sees slightly newer state).
   */
  snapshot(guildId: string, rev: number): GuildSnapshot | undefined {
    const entry = this.#guilds.get(guildId);
    if (!entry) return undefined;
    const state = [entry.state, ...entry.history].find((candidate) => candidate.rev === rev) ?? entry.state;
    return {
      ...state.base,
      id: guildId,
      member_count: entry.memberCount,
      channels: [...state.channels.values()],
      threads: [],
      roles: [...state.roles.values()],
      emojis: state.emojis,
      stickers: state.stickers,
      members: state.me ? [state.me as APIGuildMember] : [],
    };
  }

  /** Strips a GUILD_CREATE down to what a function needs, so large guilds stay small on the wire. */
  trimGuildCreate(packet: DispatchPacket): DispatchPacket {
    const { presences: _presences, members = [], ...d } = packet.d;
    return { ...packet, d: { ...d, members: members.filter((member: Raw) => member.user?.id === this.user?.id) } };
  }

  /** Updates the cache. Never mutates objects already handed out in refs, threads or snapshots. */
  apply(packet: DispatchPacket, shardId: number): void {
    const d = packet.d;
    switch (packet.t) {
      case 'READY': {
        this.user = d.user;
        this.application = d.application;
        const ids = new Set<string>(d.guilds.map((guild: Raw) => guild.id));
        for (const [id, guild] of this.#guilds) {
          if (guild.shardId === shardId && !ids.has(id)) this.#guilds.delete(id);
        }
        for (const id of ids) {
          if (!this.#guilds.has(id) || this.#unavailable.has(id)) this.#unavailable.add(id);
        }
        break;
      }
      case 'USER_UPDATE':
        if (d.id === this.user?.id) this.user = d;
        break;

      case 'GUILD_CREATE':
        if (d.unavailable) {
          this.#unavailable.add(d.id);
          break;
        }
        this.#unavailable.delete(d.id);
        this.#guilds.set(d.id, {
          shardId,
          state: {
            rev: ++this.#rev,
            base: withoutCollections(d),
            channels: byId(d.channels),
            roles: byId(d.roles),
            emojis: d.emojis ?? [],
            stickers: d.stickers ?? [],
            me: d.members?.find((member: Raw) => member.user?.id === this.user?.id),
          },
          history: [],
          threads: byId(d.threads),
          memberCount: d.member_count,
        });
        break;
      case 'GUILD_UPDATE':
        this.#update(d.id, (state) => ({
          base: { ...state.base, ...withoutCollections(d) },
          ...(d.roles && { roles: byId(d.roles) }),
          ...(d.emojis && { emojis: d.emojis }),
          ...(d.stickers && { stickers: d.stickers }),
        }));
        break;
      case 'GUILD_DELETE':
        if (d.unavailable) {
          this.#unavailable.add(d.id);
        } else {
          this.#guilds.delete(d.id);
          this.#unavailable.delete(d.id);
        }
        break;

      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE':
        this.#update(d.guild_id, (state) => ({ channels: new Map(state.channels).set(d.id, d) }));
        break;
      case 'CHANNEL_DELETE':
        this.#update(d.guild_id, (state) => ({ channels: without(state.channels, d.id) }));
        break;

      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE':
        this.#update(d.guild_id, (state) => ({ roles: new Map(state.roles).set(d.role.id, d.role) }));
        break;
      case 'GUILD_ROLE_DELETE':
        this.#update(d.guild_id, (state) => ({ roles: without(state.roles, d.role_id) }));
        break;
      case 'GUILD_EMOJIS_UPDATE':
        this.#update(d.guild_id, () => ({ emojis: d.emojis }));
        break;
      case 'GUILD_STICKERS_UPDATE':
        this.#update(d.guild_id, () => ({ stickers: d.stickers }));
        break;
      case 'GUILD_MEMBER_UPDATE':
        if (d.user?.id === this.user?.id) this.#update(d.guild_id, (state) => ({ me: { ...state.me, ...d } }));
        break;

      case 'GUILD_MEMBER_ADD':
      case 'GUILD_MEMBER_REMOVE': {
        const entry = this.#guilds.get(d.guild_id);
        if (entry?.memberCount !== undefined) entry.memberCount += packet.t === 'GUILD_MEMBER_ADD' ? 1 : -1;
        break;
      }

      case 'THREAD_CREATE':
      case 'THREAD_UPDATE':
        this.#guilds.get(d.guild_id)?.threads.set(d.id, d);
        break;
      case 'THREAD_DELETE':
        this.#guilds.get(d.guild_id)?.threads.delete(d.id);
        break;
      case 'THREAD_LIST_SYNC': {
        const entry = this.#guilds.get(d.guild_id);
        if (!entry) break;
        const parents = d.channel_ids ? new Set<string>(d.channel_ids) : undefined;
        for (const [id, thread] of entry.threads) {
          if (!parents || parents.has(thread.parent_id)) entry.threads.delete(id);
        }
        for (const thread of d.threads) entry.threads.set(thread.id, thread);
        break;
      }
    }
  }

  #update(guildId: string, change: (state: GuildState) => Partial<GuildState>): void {
    const entry = this.#guilds.get(guildId);
    if (!entry) return;
    entry.history = [entry.state, ...entry.history].slice(0, HISTORY);
    entry.state = { ...entry.state, ...change(entry.state), rev: ++this.#rev };
  }
}

function withoutCollections(guild: Raw): Raw {
  return Object.fromEntries(Object.entries(guild).filter(([key]) => !COLLECTION_KEYS.has(key)));
}

function byId(items: Raw[] | undefined): Map<string, Raw> {
  return new Map((items ?? []).map((item) => [item.id, item]));
}

function without<V>(map: ReadonlyMap<string, V>, id: string): Map<string, V> {
  const copy = new Map(map);
  copy.delete(id);
  return copy;
}
