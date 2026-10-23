/**
 * Runs the real gateway process against a fake Discord (REST + gateway
 * WebSocket) and a fake relay endpoint that behaves like a cold function
 * instance: it asks for every guild snapshot it hasn't seen.
 */
import assert from 'node:assert/strict';
import { type ChildProcess, spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { PresenceUpdateStatus } from 'discord-api-types/v10';
import { type WebSocket, WebSocketServer } from 'ws';
import {
  deriveRelayKey,
  ENCODING_HEADER,
  type RelayBatch,
  type RelayConfig,
  type RelayEvent,
  snapshotKey,
  verifyRelayRequest,
} from '../src/protocol.ts';

const TOKEN = 'gateway-test-token';
const KEY = deriveRelayKey(TOKEN);
const BOT = { id: '900000000000000001', username: 'relay-bot', discriminator: '0', bot: true };
const GUILD = {
  id: '100000000000000001',
  name: 'Gateway Test Server',
  member_count: 3,
  channels: [{ id: '300000000000000001', type: 0, name: 'general', position: 0, permission_overwrites: [] }],
  threads: [{ id: '310000000000000001', type: 11, name: 'a thread', parent_id: '300000000000000001', guild_id: '100000000000000001' }],
  roles: [{ id: '100000000000000001', name: '@everyone', permissions: '0', position: 0 }],
  emojis: [],
  stickers: [],
  members: [
    { user: BOT, roles: [] },
    { user: { id: '800000000000000001', username: 'alice' }, roles: [] },
  ],
  presences: [{ user: { id: '800000000000000001' }, status: 'online' }],
};
const CONFIG: RelayConfig = {
  v: 2,
  intents: 513,
  events: ['GUILD_AVAILABLE', 'MESSAGE_CREATE'],
  presence: { status: PresenceUpdateStatus.Idle, activities: [], afk: false, since: null },
};

interface GatewayMessage {
  op: number;
  d: any;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

async function waitFor<T>(check: () => T | undefined, what: string, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

const message = (id: string, content: string, channelId = '300000000000000001') => ({
  id,
  channel_id: channelId,
  guild_id: GUILD.id,
  author: { id: '800000000000000001', username: 'alice' },
  content,
});

describe('gateway daemon', () => {
  const received: GatewayMessage[] = [];
  const connections: { socket: WebSocket; url: string; closeCode?: number }[] = [];
  const delivered: RelayEvent[] = [];
  const batches: RelayBatch[] = [];
  const conflicts: string[][] = [];
  const loaded = new Set<string>();
  let configRequests = 0;
  let sequence = 0;
  let api: Server;
  let relay: Server;
  let gateway: WebSocketServer;
  let daemon: ChildProcess;
  let logs = '';

  const dispatch = (t: string, d: unknown) => connections.at(-1)!.socket.send(JSON.stringify({ op: 0, t, s: ++sequence, d }));

  before(async () => {
    gateway = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    await once(gateway, 'listening');
    const gatewayUrl = `ws://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
    gateway.on('connection', (socket, request) => {
      const connection: (typeof connections)[number] = { socket, url: request.url! };
      connections.push(connection);
      socket.on('close', (code) => (connection.closeCode = code));
      socket.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 250 } }));
      socket.on('message', (raw) => {
        const msg = JSON.parse(String(raw)) as GatewayMessage;
        received.push(msg);
        if (msg.op === 1) socket.send(JSON.stringify({ op: 11 }));
        if (msg.op === 2) {
          dispatch('READY', {
            v: 10,
            user: BOT,
            guilds: [{ id: GUILD.id, unavailable: true }],
            session_id: 'session-1',
            resume_gateway_url: `${gatewayUrl}/resume`,
            application: { id: BOT.id, flags: 0 },
          });
          dispatch('GUILD_CREATE', GUILD);
        }
        if (msg.op === 6) dispatch('RESUMED', {});
      });
    });

    api = createServer((req, res) => {
      assert.equal(req.headers.authorization, `Bot ${TOKEN}`);
      res.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          url: gatewayUrl,
          shards: 1,
          session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
        }),
      );
    });
    const apiPort = await listen(api);

    relay = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      const headers = new Headers(req.headers as Record<string, string>);
      if (!verifyRelayRequest(KEY, headers, body)) return res.writeHead(401).end();
      if (req.method === 'GET') {
        configRequests++;
        return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(CONFIG));
      }
      const batch = JSON.parse(String(headers.get(ENCODING_HEADER) === 'gzip' ? gunzipSync(body) : body)) as RelayBatch;
      for (const key of Object.keys(batch.snapshots ?? {})) loaded.add(key);
      const missing = [
        ...new Set(
          batch.events.flatMap((event) =>
            event.guild && 'rev' in event.guild ? [snapshotKey(event.guild.id, event.guild.rev)] : [],
          ),
        ),
      ].filter((key) => !loaded.has(key));
      if (missing.length > 0 && !batch.snapshots) {
        conflicts.push(missing);
        return res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ missing }));
      }
      batches.push(batch);
      delivered.push(...batch.events);
      res.writeHead(202).end();
    });
    const relayPort = await listen(relay);

    daemon = spawn(process.execPath, ['src/index.ts'], {
      cwd: new URL('..', import.meta.url),
      env: {
        PATH: process.env.PATH,
        DISCORD_TOKEN: TOKEN,
        DISCORD_API_URL: `http://127.0.0.1:${apiPort}/api`,
        DISCORD_RELAY_URL: `http://127.0.0.1:${relayPort}/api/gateway`,
        GATEWAY_BATCH_LINGER_MS: '50',
      },
    });
    daemon.stdout!.on('data', (chunk) => (logs += chunk));
    daemon.stderr!.on('data', (chunk) => (logs += chunk));
  });

  after(() => {
    daemon.kill('SIGKILL');
    gateway.close();
    api.close();
    relay.close();
  });

  test('identifies with the intents and presence the function asked for', async () => {
    const identify = await waitFor(() => received.find((msg) => msg.op === 2), 'identify');
    assert.equal(configRequests, 1);
    assert.equal(identify.d.token, TOKEN);
    assert.equal(identify.d.intents, 513);
    assert.deepEqual(identify.d.shard, [0, 1]);
    assert.deepEqual(identify.d.presence, CONFIG.presence);
    assert.equal(identify.d.properties.browser, 'discord-on-vercel');
  });

  test('forwards a guild becoming available, trimmed', async () => {
    const available = await waitFor(() => delivered.find((e) => e.packet.t === 'GUILD_CREATE'), 'GUILD_CREATE');
    assert.deepEqual(available.guild, { id: GUILD.id, unavailable: true });
    assert.equal(available.packet.d.presences, undefined);
    assert.deepEqual(
      available.packet.d.members.map((member: any) => member.user.id),
      [BOT.id],
    );
    assert.equal(delivered.filter((e) => e.packet.t === 'READY').length, 0);
  });

  test('batches events, sends snapshots only when asked, and only forwards what the bot listens to', async () => {
    dispatch('TYPING_START', { channel_id: '300000000000000001', guild_id: GUILD.id });
    for (let i = 0; i < 5; i++) dispatch('MESSAGE_CREATE', message(`50000000000000000${i}`, `hello ${i}`));
    dispatch('MESSAGE_CREATE', message('500000000000000009', 'in a thread', '310000000000000001'));

    await waitFor(() => delivered.filter((e) => e.packet.t === 'MESSAGE_CREATE').length === 6, '6 messages');
    const messages = delivered.filter((e) => e.packet.t === 'MESSAGE_CREATE');
    assert.equal(delivered.filter((e) => e.packet.t === 'TYPING_START').length, 0);
    assert.deepEqual(
      messages.map((e) => e.packet.d.content),
      ['hello 0', 'hello 1', 'hello 2', 'hello 3', 'hello 4', 'in a thread'],
    );

    const batch = batches.find((b) => b.events.some((e) => e.packet.t === 'MESSAGE_CREATE'))!;
    assert.equal(batch.events.length, 6, 'one batch within the linger window');
    assert.deepEqual(batch.bot.user, BOT);
    assert.equal(batch.shardCount, 1);

    const ref = messages[0]!.guild!;
    assert.ok('rev' in ref);
    assert.equal(ref.memberCount, 3);
    assert.deepEqual(conflicts.at(-1), [snapshotKey(GUILD.id, ref.rev)], 'the cold relay asked for the guild once');
    const snapshot = batch.snapshots![snapshotKey(GUILD.id, ref.rev)]!;
    assert.equal(snapshot.name, GUILD.name);
    assert.deepEqual(snapshot.channels, GUILD.channels);
    assert.deepEqual(snapshot.roles, GUILD.roles);
    assert.deepEqual(
      snapshot.members!.map((member) => member.user!.id),
      [BOT.id],
    );
    assert.deepEqual(messages.at(-1)!.thread, GUILD.threads[0]);
    assert.equal(new Set(delivered.map((e) => e.id)).size, delivered.length, 'event ids are unique');
  });

  test('sends warm batches without snapshots', async () => {
    const before = conflicts.length;
    dispatch('MESSAGE_CREATE', message('500000000000000010', 'warm'));
    const warm = await waitFor(() => batches.find((b) => b.events.some((e) => e.packet.d.content === 'warm')), 'warm batch');
    assert.equal(warm.snapshots, undefined);
    assert.equal(conflicts.length, before);
  });

  test('heartbeats with the last sequence number', async () => {
    const heartbeat = await waitFor(() => received.findLast((msg) => msg.op === 1 && msg.d !== null), 'heartbeat');
    assert.equal(typeof heartbeat.d, 'number');
  });

  test('resumes the session when Discord asks it to reconnect', async () => {
    const before = connections.length;
    const lastSequence = sequence;
    connections.at(-1)!.socket.send(JSON.stringify({ op: 7, d: null }));
    const resume = await waitFor(() => received.find((msg) => msg.op === 6), 'resume', 8_000);
    assert.equal(connections.length, before + 1);
    assert.match(connections.at(-1)!.url, /^\/resume/);
    assert.equal(resume.d.session_id, 'session-1');
    assert.equal(resume.d.seq, lastSequence);
  });

  test('closes the connection with 1000 and exits cleanly on SIGTERM', async () => {
    daemon.kill('SIGTERM');
    const [code] = await once(daemon, 'exit');
    assert.equal(code, 0, logs);
    await waitFor(() => connections.at(-1)!.closeCode, 'close');
    assert.equal(connections.at(-1)!.closeCode, 1000);
  });
});
