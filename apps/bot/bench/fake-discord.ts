/**
 * A stand-in for Discord, run as a child process by `throughput.ts` so its
 * CPU isn't counted against the bot. Serves the REST API and the gateway,
 * and on command fires MESSAGE_CREATE traffic spread over many guilds.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

const GUILDS = Number(process.env.GUILDS ?? 100);
const CHANNELS_PER_GUILD = 25;
const ROLES_PER_GUILD = 15;
const BOT = { id: '900000000000000001', username: 'bench-bot', discriminator: '0', global_name: null, avatar: null, bot: true };

const guildId = (i: number) => String(100000000000000000n + BigInt(i));
const channelId = (guild: number, channel: number) => String(300000000000000000n + BigInt(guild * 1000 + channel));
const userId = (i: number) => String(800000000000000000n + BigInt(i));

function guild(i: number) {
  const id = guildId(i);
  return {
    id,
    name: `Bench Server ${i}`,
    icon: null,
    owner_id: userId(0),
    member_count: 5000 + i,
    features: ['COMMUNITY'],
    verification_level: 1,
    default_message_notifications: 1,
    explicit_content_filter: 2,
    mfa_level: 0,
    premium_tier: 1,
    nsfw_level: 0,
    preferred_locale: 'en-US',
    system_channel_flags: 0,
    afk_timeout: 300,
    large: true,
    channels: Array.from({ length: CHANNELS_PER_GUILD }, (_, c) => ({
      id: channelId(i, c),
      type: 0,
      name: `channel-${c}`,
      position: c,
      topic: 'A channel used for benchmarking the relay',
      nsfw: false,
      rate_limit_per_user: 0,
      permission_overwrites: [{ id, type: 0, allow: '0', deny: '2048' }],
    })),
    threads: [],
    roles: Array.from({ length: ROLES_PER_GUILD }, (_, r) => ({
      id: r === 0 ? id : String(400000000000000000n + BigInt(i * 100 + r)),
      name: r === 0 ? '@everyone' : `role-${r}`,
      permissions: r === 0 ? '1071698660929' : '8',
      position: r,
      color: 0,
      hoist: false,
      managed: false,
      mentionable: false,
      flags: 0,
    })),
    emojis: [],
    stickers: [],
    members: [{ user: BOT, roles: [], joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 }],
    presences: [],
    voice_states: [],
  };
}

function message(seq: number) {
  const g = seq % GUILDS;
  const author = { id: userId(seq % 5000), username: `user${seq % 5000}`, discriminator: '0', global_name: null, avatar: null };
  return {
    id: String(500000000000000000n + BigInt(seq)),
    channel_id: channelId(g, seq % CHANNELS_PER_GUILD),
    guild_id: guildId(g),
    author,
    member: { roles: [], joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0, premium_since: null },
    content: `sent:${Date.now()} a perfectly ordinary chat message, about this long, number ${seq}`,
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
    flags: 0,
    components: [],
  };
}

let socket: WebSocket | undefined;
let sequence = 0;
const dispatch = (t: string, d: unknown) => socket!.send(JSON.stringify({ op: 0, t, s: ++sequence, d }));

const gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
gateway.on('connection', (ws) => {
  socket = ws;
  ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 41_250 } }));
  ws.on('message', (raw) => {
    const payload = JSON.parse(String(raw));
    if (payload.op === 1) ws.send(JSON.stringify({ op: 11 }));
    if (payload.op !== 2) return;
    dispatch('READY', {
      v: 10,
      user: BOT,
      guilds: Array.from({ length: GUILDS }, (_, i) => ({ id: guildId(i), unavailable: true })),
      session_id: 'bench-session',
      resume_gateway_url: `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`,
      application: { id: BOT.id, flags: 0 },
    });
    for (let i = 0; i < GUILDS; i++) dispatch('GUILD_CREATE', guild(i));
    process.send!({ type: 'connected' });
  });
});

const rest = createServer((req, res) => {
  if (req.url === '/api/v10/gateway/bot') {
    const { port } = gateway.address() as AddressInfo;
    res.writeHead(200, { 'content-type': 'application/json' }).end(
      JSON.stringify({
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      }),
    );
    return;
  }
  res.writeHead(204).end();
});
rest.listen(0, '127.0.0.1', () => process.send!({ type: 'listening', port: (rest.address() as AddressInfo).port }));

/** Sends `count` messages at `rate` per second (0 = as fast as the socket takes them). */
process.on('message', async ({ count, rate }: { count: number; rate: number }) => {
  const start = sequence;
  if (rate === 0) {
    for (let i = 0; i < count; i++) dispatch('MESSAGE_CREATE', message(start + i));
  } else {
    // Send in ticks of at least 10ms, catching up on whatever the timer was late by.
    const begin = Date.now();
    for (let sent = 0; sent < count; ) {
      const due = Math.min(count, Math.floor(((Date.now() - begin) / 1000) * rate) + 1);
      for (; sent < due; sent++) dispatch('MESSAGE_CREATE', message(start + sent));
      await new Promise((resolve) => setTimeout(resolve, Math.max(10, 1000 / rate)));
    }
  }
  process.send!({ type: 'sent', count });
});
