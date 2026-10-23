/**
 * Runs a discord.js `Client` without a gateway connection.
 *
 * The client never logs in. Instead, each relayed dispatch is replayed through
 * discord.js' own packet handlers, after the guild it belongs to has been
 * loaded from a gateway snapshot. Your listeners receive the same `Message`,
 * `Interaction`, `GuildMember`, … objects a connected bot would, and their
 * methods (`reply`, `react`, `fetch`, …) go through `client.rest` as usual.
 *
 * Guilds stay loaded between invocations on the same (Fluid compute)
 * instance, keyed by the revision the gateway assigned them, so most events
 * only cost the replay itself.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import {
  PROTOCOL_VERSION,
  type RelayBatch,
  type RelayConfig,
  type RelayEvent,
  snapshotKey,
} from '@discord-on-vercel/gateway/protocol';
import { type Client, Partials, WebSocketShard } from 'discord.js';
import { forwardedDispatches } from './events.ts';

/** The discord.js internals the runtime drives. They're private in the typings, but stable across v14. */
interface CachedGuild {
  memberCount: number;
  channels: { cache: Map<string, unknown> };
}
interface ClientInternals {
  user: { _patch(data: unknown): void } | null;
  guilds: { cache: Map<string, CachedGuild>; _add(data: unknown): unknown };
  channels: {
    cache: Map<string, unknown>;
    _add(data: unknown, guild?: CachedGuild): unknown;
  };
  presence: { _parse(data: unknown): RelayConfig['presence'] };
  ws: {
    shards: Map<number, WebSocketShard>;
    handlePacket(packet: unknown, shard: WebSocketShard): boolean;
    triggerClientReady(): void;
  };
}

export interface RuntimeOptions {
  /**
   * Guilds kept loaded per function instance before the least recently used
   * is dropped. A guild with 25 channels and 15 roles takes about 40 KB. Keep
   * every guild that sends you events regularly loaded: past this limit,
   * batches keep missing snapshots.
   */
  maxGuilds?: number;
}

const ALL_PARTIALS = Object.values(Partials).filter((value) => typeof value === 'number');
const DEDUPE_WINDOW = 10_000;
const SWEEP_INTERVAL_MS = 60_000;
const MESSAGE_LIFETIME_MS = 60_000;

/** Collects the promises returned by listeners for one batch, so the function can wait for them. */
class DispatchScope {
  readonly #pending = new Set<Promise<void>>();

  track(event: string, result: unknown): void {
    if (!isPromiseLike(result)) return;
    const promise: Promise<void> = Promise.resolve(result)
      .then(
        () => {},
        (error) => reportListenerError(event, error),
      )
      .finally(() => this.#pending.delete(promise));
    this.#pending.add(promise);
  }

  async settled(): Promise<void> {
    // Listeners can emit further events (and start more work) while we wait.
    while (this.#pending.size > 0) await Promise.all(this.#pending);
  }
}

const scopes = new AsyncLocalStorage<DispatchScope>();

export class RelayRuntime {
  readonly client: Client;
  readonly #internals: ClientInternals;
  readonly #maxGuilds: number;
  /** Loaded guilds and the revision they were loaded at, least recently used first. */
  readonly #revisions = new Map<string, number>();
  readonly #seen = new Set<string>();
  #ready = false;

  constructor(client: Client, { maxGuilds = 5_000 }: RuntimeOptions = {}) {
    this.client = client;
    this.#internals = client as unknown as ClientInternals;
    this.#maxGuilds = maxGuilds;

    // Each event may land on a different instance, so discord.js must be willing
    // to emit events for structures it hasn't cached (reactions on old messages, etc.).
    client.options.partials = [...new Set([...(client.options.partials ?? []), ...ALL_PARTIALS])];
    // `login()` would open a second gateway connection from inside a function.
    client.login = async () => {
      console.warn('[relay] client.login() does nothing here: the gateway daemon holds the connection.');
      return client.token ?? '';
    };
    trackListeners(client);
    // A Fluid instance can live for hours; keep the caches that grow with traffic in check.
    setInterval(() => this.#sweep(), SWEEP_INTERVAL_MS).unref();
  }

  setToken(token: string): void {
    this.client.token = token;
    this.client.rest.setToken(token);
  }

  /** What the gateway should identify with and forward, derived from the client's options and listeners. */
  config(): RelayConfig {
    const { options } = this.client;
    return {
      v: PROTOCOL_VERSION,
      intents: Number(options.intents.bitfield),
      events: forwardedDispatches(this.client),
      presence: options.presence ? this.#internals.presence._parse(options.presence) : undefined,
    };
  }

  /**
   * Snapshot keys the batch needs that this instance doesn't have loaded. A
   * batch that already carries snapshots is never refused, so a guild the
   * gateway can't supply anymore doesn't bounce forever.
   */
  missingSnapshots(batch: RelayBatch): string[] {
    if (batch.snapshots) return [];
    const missing = new Set<string>();
    for (const { guild } of batch.events) {
      if (guild && 'rev' in guild && this.#revisions.get(guild.id) !== guild.rev) {
        missing.add(snapshotKey(guild.id, guild.rev));
      }
    }
    return [...missing];
  }

  /** Replays a batch in order. Resolves when every listener it triggered has finished. */
  dispatch(batch: RelayBatch): Promise<void> {
    const scope = new DispatchScope();
    scopes.run(scope, () => {
      for (const event of batch.events) {
        if (this.#isDuplicate(event.id)) continue;
        try {
          const shard = this.#shard(event.shard, batch);
          this.#load(event, batch, shard.id);
          this.client.emit('raw', event.packet, shard.id);
          this.#internals.ws.handlePacket(event.packet, shard);
        } catch (error) {
          console.error(`[relay] failed to replay ${event.packet.t} (${event.id})`, error);
        }
      }
    });
    return scope.settled();
  }

  #shard(id: number, { bot }: RelayBatch): WebSocketShard {
    const { ws } = this.#internals;
    let shard = ws.shards.get(id);
    if (!shard) {
      shard = new (WebSocketShard as unknown as new (manager: unknown, id: number) => WebSocketShard)(ws, id);
      // Nothing to wait for: guilds arrive with the events instead of at startup.
      (shard as unknown as { expectedGuilds: Set<string> }).expectedGuilds = new Set();
      ws.shards.set(id, shard);
      // discord.js' own READY handler sets client.user and client.application.
      ws.handlePacket({ op: 0, t: 'READY', s: 0, d: { ...bot, guilds: [] } }, shard);
    } else {
      this.#internals.user?._patch(bot.user);
    }

    if (!this.#ready) {
      this.#ready = true;
      // Emits `clientReady` once per function instance.
      ws.triggerClientReady();
    }
    return shard;
  }

  /** Makes sure the event's guild (and thread) is loaded as the gateway saw it before the event. */
  #load({ guild: ref, thread }: RelayEvent, { snapshots }: RelayBatch, shardId: number): void {
    const { guilds, channels } = this.#internals;
    if (ref && 'unavailable' in ref) {
      this.#replace(ref.id, { id: ref.id, unavailable: true, shardId });
    } else if (ref) {
      const snapshot = snapshots?.[snapshotKey(ref.id, ref.rev)];
      if (snapshot && this.#revisions.get(ref.id) !== ref.rev) {
        this.#replace(ref.id, { ...snapshot, shardId });
        this.#revisions.set(ref.id, ref.rev);
      }
      if (this.#revisions.has(ref.id)) {
        // Mark as most recently used.
        this.#revisions.delete(ref.id);
        this.#revisions.set(ref.id, ref.rev);
      }
      const guild = guilds.cache.get(ref.id);
      if (guild && ref.memberCount !== undefined) guild.memberCount = ref.memberCount;
      while (this.#revisions.size > this.#maxGuilds) this.#unload(this.#revisions.keys().next().value!);
    }
    if (thread) channels._add(thread, guilds.cache.get(thread.guild_id as string));
  }

  /** Swaps in a fresh copy of the guild rather than patching one that may be stale. */
  #replace(id: string, data: Record<string, unknown>): void {
    this.#unload(id);
    this.#internals.guilds._add(data);
  }

  #unload(id: string): void {
    const { guilds, channels } = this.#internals;
    for (const channelId of guilds.cache.get(id)?.channels.cache.keys() ?? []) channels.cache.delete(channelId);
    guilds.cache.delete(id);
    this.#revisions.delete(id);
  }

  /** Users, members and messages accumulate with traffic; guild structure is bounded by `maxGuilds`. */
  #sweep(): void {
    const self = this.client.user?.id;
    const cutoff = Date.now() - MESSAGE_LIFETIME_MS;
    this.client.sweepers.sweepMessages((message) => (message.editedTimestamp ?? message.createdTimestamp) < cutoff);
    this.client.sweepers.sweepGuildMembers((member) => member.id !== self);
    this.client.sweepers.sweepUsers((user) => user.id !== self);
  }

  /** The gateway retries failed deliveries; skip events this instance has already handled. */
  #isDuplicate(id: string): boolean {
    if (this.#seen.has(id)) return true;
    this.#seen.add(id);
    if (this.#seen.size > DEDUPE_WINDOW) this.#seen.delete(this.#seen.values().next().value!);
    return false;
  }
}

/**
 * Wraps `client.emit` so that, while a batch is being replayed, the promises
 * returned by async listeners are collected instead of dropped.
 */
function trackListeners(client: Client): void {
  const emit = client.emit;
  client.emit = function (this: Client, event: string | symbol, ...args: unknown[]): boolean {
    const scope = scopes.getStore();
    if (!scope) return Reflect.apply(emit, this, [event, ...args]);

    const listeners = this.rawListeners(event);
    if (listeners.length === 0) {
      if (event === 'error') throw args[0];
      return false;
    }
    for (const listener of listeners) {
      try {
        scope.track(String(event), Reflect.apply(listener, this, args));
      } catch (error) {
        reportListenerError(String(event), error);
      }
    }
    return true;
  } as Client['emit'];
}

function reportListenerError(event: string, error: unknown): void {
  console.error(`[relay] "${event}" listener threw:`, error);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as PromiseLike<unknown> | undefined)?.then === 'function';
}
