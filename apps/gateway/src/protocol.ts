/**
 * Wire protocol between the gateway daemon and the bot's Vercel Function.
 *
 * The gateway POSTs batches of raw dispatches. Each event names its guild by
 * id and revision instead of carrying the guild: a warm function instance
 * already has most guilds, and asks for the rest by answering 409 with the
 * snapshot keys it's missing. The gateway then resends the batch with those
 * snapshots attached.
 *
 * Shared by the gateway and `@discord-on-vercel/relay`. Keep it free of
 * runtime dependencies (type-only imports are erased).
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import type { APIGuildMember, APIUser, GatewayPresenceUpdateData } from 'discord-api-types/v10';

export const PROTOCOL_VERSION = 2;

/** Path the gateway posts to when it derives the relay URL itself. */
export const DEFAULT_RELAY_PATH = '/api/gateway';

export const SIGNATURE_HEADER = 'x-discord-relay-signature';
export const TIMESTAMP_HEADER = 'x-discord-relay-timestamp';
export const ENCODING_HEADER = 'x-discord-relay-encoding';

const MAX_CLOCK_SKEW_MS = 5 * 60_000;

/**
 * Pseudo dispatch type for a GUILD_CREATE that makes a known guild available
 * (on startup or after an outage), as opposed to the bot joining a new guild.
 */
export const GUILD_AVAILABLE = 'GUILD_AVAILABLE';

/** Returned by the function for `GET`: what the gateway should identify with and forward. */
export interface RelayConfig {
  v: typeof PROTOCOL_VERSION;
  intents: number;
  /** Dispatch types to forward, or `'*'` for all of them. */
  events: string[] | '*';
  presence?: GatewayPresenceUpdateData;
}

/** A raw gateway dispatch (opcode 0), exactly as Discord sent it. */
export interface DispatchPacket {
  op: 0;
  t: string;
  s: number;
  /** Shape depends on `t`; see discord-api-types' `GatewayDispatchPayload`. */
  d: any;
}

/** The guild an event belongs to, as it was before the event. */
export type GuildRef = { id: string; rev: number; memberCount?: number } | { id: string; unavailable: true };

/** A guild's structure, shaped like a trimmed GUILD_CREATE payload. */
export type GuildSnapshot = { id: string; members?: APIGuildMember[] } & Record<string, unknown>;

export interface RelayEvent {
  /** Unique per dispatch; retries reuse it. */
  id: string;
  shard: number;
  guild?: GuildRef;
  /** The thread the event happened in, as it was before the event. */
  thread?: Record<string, unknown>;
  packet: DispatchPacket;
}

export interface RelayBatch {
  v: typeof PROTOCOL_VERSION;
  shardCount: number;
  bot: { user: APIUser; application: { id: string; flags?: number } };
  events: RelayEvent[];
  /** Snapshots the function asked for, keyed by `snapshotKey()`. */
  snapshots?: Record<string, GuildSnapshot>;
}

/** Body of the function's 409 response. */
export interface MissingSnapshots {
  missing: string[];
}

export function snapshotKey(guildId: string, rev: number): string {
  return `${guildId}@${rev}`;
}

/**
 * Derives the HMAC key from `DISCORD_RELAY_SECRET`, or from the bot token
 * when no explicit secret is set. Both sides already hold the token, so the
 * default needs no extra configuration.
 */
export function deriveRelayKey(secret: string): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, '', 'discord-on-vercel/relay/v1', 32));
}

export function signRelayRequest(key: Buffer, body: Uint8Array, timestamp = Date.now()): Record<string, string> {
  return {
    [TIMESTAMP_HEADER]: String(timestamp),
    [SIGNATURE_HEADER]: `v1=${digest(key, timestamp, body)}`,
  };
}

export function verifyRelayRequest(key: Buffer, headers: Headers, body: Uint8Array, now = Date.now()): boolean {
  const timestamp = Number(headers.get(TIMESTAMP_HEADER));
  const signature = headers.get(SIGNATURE_HEADER);
  if (!Number.isSafeInteger(timestamp) || !signature?.startsWith('v1=')) return false;
  if (Math.abs(now - timestamp) > MAX_CLOCK_SKEW_MS) return false;

  const expected = Buffer.from(digest(key, timestamp, body), 'hex');
  const actual = Buffer.from(signature.slice(3), 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function digest(key: Buffer, timestamp: number, body: Uint8Array): string {
  return createHmac('sha256', key).update(`${timestamp}.`).update(body).digest('hex');
}
