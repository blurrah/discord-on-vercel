/**
 * The gateway daemon.
 *
 * Holds the Discord gateway connection (which a Vercel Function can't) and
 * relays every dispatch your bot listens to, in batches, to the bot's Vercel
 * Function. It contains no bot logic: intents, presence and the set of
 * forwarded events all come from the discord.js client in `apps/bot`.
 */
import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import { DiscordAPIError, REST } from '@discordjs/rest';
import { WebSocketManager, WebSocketShardEvents } from '@discordjs/ws';
import { GatewayCache } from './cache.ts';
import { errorMessage, log } from './log.ts';
import { DEFAULT_RELAY_PATH, type DispatchPacket, deriveRelayKey } from './protocol.ts';
import { Relay } from './relay.ts';

/** Gateway lifecycle events that only matter to the connection itself. */
const NEVER_FORWARDED = new Set(['READY', 'RESUMED']);
const STATS_INTERVAL_MS = 10 * 60_000;

/** Close codes after which @discordjs/ws gives up, with what to do about them. */
const FATAL_CLOSE_HINTS: Record<number, string> = {
  4004: 'Discord rejected DISCORD_TOKEN.',
  4010: 'Invalid shard.',
  4011: 'Sharding required. Unset DISCORD_SHARD_COUNT to use the recommended count, or raise it.',
  4012: 'Invalid API version.',
  4013: 'Invalid intents.',
  4014: 'Disallowed intents. Enable the privileged intents your client requests in the Discord Developer Portal (Bot → Privileged Gateway Intents).',
};

const shutdown = new AbortController();
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    log.info(`received ${signal}, shutting down`);
    shutdown.abort();
  });
}

const token = required('DISCORD_TOKEN').replace(/^Bot\s+/i, '');
const rest = new REST({ api: process.env.DISCORD_API_URL ?? 'https://discord.com/api' }).setToken(token);
const cache = new GatewayCache();
let shardCount = 1;
const relay = new Relay({
  url: relayUrl(),
  key: deriveRelayKey(process.env.DISCORD_RELAY_SECRET || token),
  header: () => ({ shardCount, bot: { user: cache.user!, application: cache.application! } }),
  snapshot: (key) => {
    const at = key.lastIndexOf('@');
    return cache.snapshot(key.slice(0, at), Number(key.slice(at + 1)));
  },
  batchSize: Number(process.env.GATEWAY_BATCH_SIZE) || undefined,
  lingerMs: Number(process.env.GATEWAY_BATCH_LINGER_MS) || undefined,
});

try {
  await run();
} catch (error) {
  if (!shutdown.signal.aborted) throw error;
}
process.exit(0);

async function run(): Promise<void> {
  log.info(`relaying to ${relay.url}`);
  const config = await relay.fetchConfig(shutdown.signal);
  const forward = config.events === '*' ? null : new Set(config.events);
  log.info(
    `bot listens to ${forward ? [...forward].join(', ') || 'nothing' : 'all events'} (intents ${config.intents})`,
  );

  const sessions = new Map<number, string>();
  const stats = { received: 0, forwarded: 0 };
  const manager = new WebSocketManager({
    token,
    rest,
    intents: config.intents,
    initialPresence: config.presence ?? null,
    shardCount: Number(process.env.DISCORD_SHARD_COUNT) || null,
    identifyProperties: { os: process.platform, browser: 'discord-on-vercel', device: 'discord-on-vercel' },
  });

  manager.on(WebSocketShardEvents.Dispatch, (payload, shardId) => {
    const packet = payload as DispatchPacket;
    stats.received++;
    try {
      if (packet.t === 'READY') {
        sessions.set(shardId, packet.d.session_id);
        log.info(`shard ${shardId}: ready as ${packet.d.user.username} (${packet.d.guilds.length} guilds)`);
      }
      const kind = cache.kindOf(packet);
      const wanted = kind !== null && !NEVER_FORWARDED.has(kind) && (!forward || forward.has(kind));
      if (wanted && cache.user && cache.application) {
        stats.forwarded++;
        // Refs and threads are taken before the cache is updated, so update
        // and delete events carry the state from before the event.
        relay.send({
          id: `${shardId}:${sessions.get(shardId)}:${packet.s}`,
          shard: shardId,
          guild: cache.refFor(packet),
          thread: cache.threadFor(packet),
          packet: packet.t === 'GUILD_CREATE' ? cache.trimGuildCreate(packet) : packet,
        });
      }
      cache.apply(packet, shardId);
    } catch (error) {
      log.error(`failed to handle ${packet.t}`, error);
    }
  });
  manager.on(WebSocketShardEvents.Resumed, (shardId) => log.info(`shard ${shardId}: resumed`));
  manager.on(WebSocketShardEvents.Closed, (code, shardId) => {
    const hint = FATAL_CLOSE_HINTS[code];
    if (hint) log.error(`shard ${shardId}: gateway closed with ${code}. ${hint} Fix it and redeploy; the gateway stays idle until then.`);
    else log.warn(`shard ${shardId}: connection closed (${code})`);
  });
  manager.on(WebSocketShardEvents.Error, (error, shardId) => log.error(`shard ${shardId}: ${errorMessage(error)}`));
  manager.on(WebSocketShardEvents.Debug, (message, shardId) => log.debug(`shard ${shardId}: ${message}`));

  // Also keeps the process alive if every shard gives up on a fatal close code.
  const reportStats = setInterval(() => {
    const { batches, delivered, failed, dropped, snapshots } = relay.stats;
    log.info(
      `stats: ${stats.received} received, ${stats.forwarded} forwarded, ${delivered} delivered in ${batches} batches, ` +
        `${snapshots} snapshots sent, ${failed} failed, ${dropped} dropped, ${relay.pending} pending, ` +
        `${cache.guildCount} guilds, rss ${Math.round(process.memoryUsage.rss() / 1e6)}MB`,
    );
  }, STATS_INTERVAL_MS);

  if (await connect(manager)) {
    shardCount = await manager.getShardCount();
    log.info(`started ${shardCount} shard${shardCount === 1 ? '' : 's'}`);
  }

  await once(shutdown.signal, 'abort');
  clearInterval(reportStats);
  // Close first so Discord stops sending to this instance, then finish deliveries in flight.
  await manager.destroy({ code: 1000, reason: 'shutting down' });
  await relay.drain(10_000);
  log.info(`stopped with ${relay.pending} undelivered events`);
}

/**
 * Connects, retrying network errors. Returns false when Discord rejects the
 * token: exiting would make Vercel restart the daemon in a loop, and repeated
 * failed logins can get the IP rate limited, so the gateway idles instead.
 */
async function connect(manager: WebSocketManager): Promise<boolean> {
  for (let attempt = 0; ; attempt++) {
    try {
      await manager.connect();
      return true;
    } catch (error) {
      if (shutdown.signal.aborted) return false;
      if (error instanceof DiscordAPIError && error.status === 401) {
        log.error('Discord rejected DISCORD_TOKEN (401). Fix it and redeploy; the gateway stays idle until then.');
        return false;
      }
      log.warn(`failed to connect: ${errorMessage(error)}`);
    }
    await sleep(Math.min(1_000 * 2 ** attempt, 60_000), undefined, { signal: shutdown.signal });
  }
}

function relayUrl(): string {
  if (process.env.DISCORD_RELAY_URL) return process.env.DISCORD_RELAY_URL;
  const host = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (host) return `https://${host}${DEFAULT_RELAY_PATH}`;
  log.error('Set DISCORD_RELAY_URL to the URL of the relay route, e.g. https://your-bot.vercel.app/api/gateway');
  process.exit(1);
}

function required(name: string): string {
  const value = process.env[name];
  if (value) return value;
  log.error(`${name} is not set`);
  process.exit(1);
}
