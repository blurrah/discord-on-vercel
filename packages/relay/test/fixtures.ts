import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { gzipSync } from 'node:zlib';
import {
  deriveRelayKey,
  ENCODING_HEADER,
  type GuildRef,
  PROTOCOL_VERSION,
  type RelayBatch,
  type RelayEvent,
  signRelayRequest,
} from '@discord-on-vercel/gateway/protocol';

export const TOKEN = 'test-token';
export const KEY = deriveRelayKey(TOKEN);

export const BOT = { id: '900000000000000001', username: 'relay-bot', discriminator: '0', global_name: null, avatar: null, bot: true };
export const ALICE = { id: '800000000000000001', username: 'alice', discriminator: '0', global_name: 'Alice', avatar: null };
export const GUILD_ID = '100000000000000001';
export const CHANNEL_ID = '300000000000000001';
export const ROLE_ID = '400000000000000001';

const member = (user: object, roles: string[] = []) => ({
  user,
  roles,
  joined_at: '2024-01-01T00:00:00.000Z',
  deaf: false,
  mute: false,
  flags: 0,
});

export function guildSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    id: GUILD_ID,
    name: 'Relay Test Server',
    icon: null,
    owner_id: ALICE.id,
    member_count: 40,
    features: [],
    verification_level: 0,
    default_message_notifications: 0,
    explicit_content_filter: 0,
    mfa_level: 0,
    premium_tier: 0,
    nsfw_level: 0,
    preferred_locale: 'en-US',
    system_channel_flags: 0,
    afk_timeout: 300,
    channels: [
      { id: CHANNEL_ID, type: 0, name: 'general', position: 0, permission_overwrites: [] },
      { id: '300000000000000002', type: 2, name: 'Voice', position: 1, permission_overwrites: [], bitrate: 64000 },
    ],
    threads: [],
    roles: [
      { id: GUILD_ID, name: '@everyone', permissions: '1071698660929', position: 0, color: 0, hoist: false, managed: false, mentionable: false, flags: 0 },
      { id: ROLE_ID, name: 'Moderators', permissions: '8', position: 1, color: 0, hoist: true, managed: false, mentionable: true, flags: 0 },
    ],
    emojis: [],
    stickers: [],
    members: [member(BOT)],
    ...overrides,
  };
}

export function message(content: string, overrides: Record<string, unknown> = {}) {
  return {
    id: '500000000000000001',
    channel_id: CHANNEL_ID,
    guild_id: GUILD_ID,
    author: ALICE,
    member: { roles: [ROLE_ID], joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 },
    content,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    type: 0,
    ...overrides,
  };
}

export function chatInputInteraction(name: string) {
  return {
    id: '600000000000000001',
    application_id: BOT.id,
    type: 2,
    data: { id: '700000000000000001', name, type: 1 },
    guild_id: GUILD_ID,
    channel_id: CHANNEL_ID,
    channel: { id: CHANNEL_ID, type: 0, name: 'general', guild_id: GUILD_ID, permissions: '1071698660929' },
    member: { ...member(ALICE, [ROLE_ID]), permissions: '8' },
    token: 'interaction-token',
    version: 1,
    app_permissions: '1071698660929',
    locale: 'en-US',
    guild_locale: 'en-US',
    entitlements: [],
    authorizing_integration_owners: { 0: GUILD_ID },
    context: 0,
  };
}

/** The revision the fixture guild is at. */
export const REV = 1;
export const GUILD_REF = { id: GUILD_ID, rev: REV, memberCount: 42 };

let sequence = 0;
/** Fixtures are hand-written JSON, so they aren't checked against discord-api-types. */
export function event(t: string, d: unknown, extra: { guild?: GuildRef; thread?: object } = {}): RelayEvent {
  sequence++;
  return { id: `0:session:${sequence}`, shard: 0, ...extra, packet: { op: 0, t, s: sequence, d } } as RelayEvent;
}

export function batch(events: RelayEvent[], snapshots?: Record<string, object>): RelayBatch {
  return {
    v: PROTOCOL_VERSION,
    shardCount: 1,
    bot: { user: BOT, application: { id: BOT.id, flags: 0 } },
    events,
    snapshots: snapshots as RelayBatch['snapshots'],
  };
}

export function relayRequest(body: RelayBatch | undefined, { key = KEY, gzip = false } = {}): Request {
  if (!body) return new Request('http://bot.test/api/gateway', { headers: signRelayRequest(key, new Uint8Array()) });
  const json = Buffer.from(JSON.stringify(body));
  const payload = gzip ? gzipSync(json) : json;
  const headers: Record<string, string> = { ...signRelayRequest(key, payload) };
  if (gzip) headers[ENCODING_HEADER] = 'gzip';
  return new Request('http://bot.test/api/gateway', { method: 'POST', headers, body: payload });
}

export interface RecordedRequest {
  method: string;
  path: string;
  body: any;
}

/** A stand-in for discord.com/api that records what the bot sends. */
export async function startDiscordApi() {
  const requests: RecordedRequest[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ method: req.method!, path: req.url!, body });
    if (req.url!.includes('/callback')) return res.writeHead(204).end();
    const sent = message(body?.content ?? '', { id: '510000000000000001', author: BOT, member: undefined });
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(sent));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, requests, close: () => server.close() };
}
