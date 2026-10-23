/**
 * End to end: fake Discord → real gateway daemon process → this bot's Hono
 * app (the same code Vercel deploys) → discord.js → fake Discord REST API.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { serve } from '@hono/node-server';
import { type WebSocket, WebSocketServer } from 'ws';

process.env.DISCORD_TOKEN = 'e2e-token';
const { client } = await import('../src/bot');
const { default: app } = await import('../src/index');

const BOT = { id: '900000000000000001', username: 'vercel-bot', discriminator: '0', global_name: null, avatar: null, bot: true };
const ALICE = { id: '800000000000000001', username: 'alice', discriminator: '0', global_name: 'Alice', avatar: null };
const GUILD_ID = '100000000000000001';
const CHANNEL_ID = '300000000000000001';
const member = (user: object) => ({ user, roles: [], joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 });
const GUILD = {
  id: GUILD_ID,
  name: 'E2E Server',
  icon: null,
  owner_id: ALICE.id,
  member_count: 42,
  features: [],
  channels: [
    { id: CHANNEL_ID, type: 0, name: 'general', position: 0, permission_overwrites: [] },
    { id: '300000000000000002', type: 0, name: 'random', position: 1, permission_overwrites: [] },
  ],
  threads: [],
  roles: [{ id: GUILD_ID, name: '@everyone', permissions: '1071698660929', position: 0, color: 0, hoist: false, managed: false, mentionable: false }],
  emojis: [],
  stickers: [],
  members: [member(BOT), member(ALICE)],
  presences: [],
  voice_states: [],
};

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function waitFor<T>(check: () => T | undefined, what: string, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('discord-on-vercel', () => {
  const rest: { method: string; path: string; body: any }[] = [];
  const identifies: any[] = [];
  let socket: WebSocket | undefined;
  let sequence = 0;
  let discord: Server;
  let gateway: WebSocketServer;
  let bot: ReturnType<typeof serve>;
  let daemon: ChildProcess;
  let logs = '';

  const dispatch = (t: string, d: unknown) => socket!.send(JSON.stringify({ op: 0, t, s: ++sequence, d }));
  const nextRest = (path: RegExp) => waitFor(() => rest.find((request) => path.test(request.path)), `REST ${path}`);

  before(async () => {
    gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(gateway, 'listening');
    const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    gateway.on('connection', (ws) => {
      socket = ws;
      ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 30_000 } }));
      ws.on('message', (raw) => {
        const message = JSON.parse(String(raw));
        if (message.op !== 2) return;
        identifies.push(message.d);
        dispatch('READY', {
          v: 10,
          user: BOT,
          guilds: [{ id: GUILD_ID, unavailable: true }],
          session_id: 'e2e-session',
          resume_gateway_url: gatewayUrl,
          application: { id: BOT.id, flags: 0 },
        });
        dispatch('GUILD_CREATE', GUILD);
      });
    });

    discord = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      const body = raw ? JSON.parse(raw) : undefined;
      rest.push({ method: req.method!, path: req.url!, body });
      const json = (data: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(data));
      if (req.url === '/api/v10/gateway/bot') {
        return json({ url: gatewayUrl, shards: 1, session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 } });
      }
      if (req.url!.includes('/callback')) return res.writeHead(204).end();
      json({ ...body, id: '510000000000000001', channel_id: CHANNEL_ID, author: BOT, timestamp: new Date().toISOString(), type: 19, attachments: [], embeds: [], mentions: [] });
    });
    const discordPort = await listen(discord);
    client.rest.options.api = `http://127.0.0.1:${discordPort}/api`;

    bot = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' });
    await once(bot, 'listening');
    const botPort = (bot.address() as AddressInfo).port;

    daemon = spawn(process.execPath, ['src/index.ts'], {
      cwd: new URL('../../gateway/', import.meta.url),
      env: {
        PATH: process.env.PATH,
        DISCORD_TOKEN: 'e2e-token',
        DISCORD_API_URL: `http://127.0.0.1:${discordPort}/api`,
        DISCORD_RELAY_URL: `http://127.0.0.1:${botPort}/api/gateway`,
      },
    });
    daemon.stdout!.on('data', (chunk) => (logs += chunk));
    daemon.stderr!.on('data', (chunk) => (logs += chunk));
  });

  after(async () => {
    daemon.kill('SIGTERM');
    await once(daemon, 'exit');
    gateway.close();
    discord.close();
    bot.close();
  });

  test('the gateway identifies with the intents declared in src/bot.ts', async () => {
    const identify = await waitFor(() => identifies[0], 'identify');
    assert.equal(identify.intents, Number(client.options.intents.bitfield));
    await waitFor(() => (logs.includes('bot listens to') ? true : undefined), 'config log');
    assert.match(logs, /bot listens to INTERACTION_CREATE, MESSAGE_CREATE/);
  });

  test('replies when mentioned', async () => {
    dispatch('MESSAGE_CREATE', {
      id: '500000000000000001',
      channel_id: CHANNEL_ID,
      guild_id: GUILD_ID,
      author: ALICE,
      member: { roles: [], joined_at: '2024-01-01T00:00:00.000Z', deaf: false, mute: false, flags: 0 },
      content: `<@${BOT.id}> hello`,
      timestamp: new Date().toISOString(),
      edited_timestamp: null,
      tts: false,
      mention_everyone: false,
      mentions: [BOT],
      mention_roles: [],
      attachments: [],
      embeds: [],
      pinned: false,
      type: 0,
    });
    const reply = await nextRest(/\/channels\/300000000000000001\/messages$/);
    assert.equal(reply.method, 'POST');
    assert.match(reply.body.content, /^Hi <@800000000000000001>! I'm running on Vercel/);
    assert.equal(reply.body.message_reference.message_id, '500000000000000001');
  });

  test('runs slash commands against the cached guild', async () => {
    dispatch('INTERACTION_CREATE', {
      id: '600000000000000001',
      application_id: BOT.id,
      type: 2,
      data: { id: '700000000000000001', name: 'server', type: 1 },
      guild_id: GUILD_ID,
      channel_id: CHANNEL_ID,
      channel: { id: CHANNEL_ID, type: 0, name: 'general', guild_id: GUILD_ID },
      member: { ...member(ALICE), permissions: '1071698660929' },
      token: 'server-token',
      version: 1,
      app_permissions: '1071698660929',
      locale: 'en-US',
      guild_locale: 'en-US',
      entitlements: [],
      authorizing_integration_owners: { 0: GUILD_ID },
      context: 0,
    });
    const callback = await nextRest(/\/interactions\/600000000000000001\/server-token\/callback/);
    const [embed] = callback.body.data.embeds;
    assert.equal(embed.title, 'E2E Server');
    assert.deepEqual(
      Object.fromEntries(embed.fields.slice(0, 3).map((field: any) => [field.name, field.value])),
      { Members: '42', Channels: '2', Roles: '1' },
    );
  });
});
