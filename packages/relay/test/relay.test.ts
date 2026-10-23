import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, test } from 'node:test';
import { deriveRelayKey, snapshotKey } from '@discord-on-vercel/gateway/protocol';
import { Client, Events, GatewayIntentBits, type Message, PermissionFlagsBits } from 'discord.js';
import { createRelayHandler } from '../src/index.ts';
import {
  ALICE,
  BOT,
  batch,
  CHANNEL_ID,
  chatInputInteraction,
  event,
  GUILD_ID,
  GUILD_REF,
  guildSnapshot,
  message,
  REV,
  ROLE_ID,
  relayRequest,
  startDiscordApi,
  TOKEN,
} from './fixtures.ts';

const SNAPSHOT = { [snapshotKey(GUILD_ID, REV)]: guildSnapshot() };

describe('createRelayHandler', () => {
  let api: Awaited<ReturnType<typeof startDiscordApi>>;
  let client: Client;
  let relay: (request: Request) => Promise<Response>;
  const pending: Promise<unknown>[] = [];

  /** Sends one batch through the handler and waits for its listeners. */
  async function deliver(...args: Parameters<typeof relayRequest>) {
    const response = await relay(relayRequest(...args));
    await Promise.all(pending.splice(0));
    return response;
  }

  function setup(options: { maxGuilds?: number } = {}) {
    client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
      presence: { status: 'idle' },
      rest: { api: `${api.url}/api` },
    });
    relay = createRelayHandler(client, { token: TOKEN, waitUntil: (promise) => pending.push(promise), ...options });
  }

  before(async () => {
    api = await startDiscordApi();
  });
  beforeEach(() => setup());
  after(() => api.close());

  test('rejects unsigned and wrongly signed requests', async () => {
    const unsigned = await relay(new Request('http://bot.test/api/gateway', { method: 'POST', body: '{}' }));
    assert.equal(unsigned.status, 401);
    const wrongKey = await relay(relayRequest(batch([event('MESSAGE_CREATE', message('hi'))]), { key: deriveRelayKey('nope') }));
    assert.equal(wrongKey.status, 401);
  });

  test('GET returns intents, presence and the dispatches the client listens to', async () => {
    client.on(Events.MessageCreate, () => {});
    client.on(Events.GuildRoleUpdate, () => {});
    const response = await relay(relayRequest(undefined));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      v: 2,
      intents: GatewayIntentBits.Guilds | GatewayIntentBits.GuildMessages,
      events: ['GUILD_ROLE_UPDATE', 'MESSAGE_CREATE'],
      presence: { activities: [], afk: false, since: null, status: 'idle' },
    });
  });

  test('asks for a snapshot it does not have, then replays MESSAGE_CREATE as a hydrated Message', async () => {
    let received: Message | undefined;
    let ready = 0;
    client.once(Events.ClientReady, () => ready++);
    client.once(Events.MessageCreate, async (msg) => {
      received = msg;
      await msg.reply('pong');
    });

    const events = [event('MESSAGE_CREATE', message('ping'), { guild: GUILD_REF })];
    const cold = await deliver(batch(events));
    assert.equal(cold.status, 409);
    assert.deepEqual(await cold.json(), { missing: [snapshotKey(GUILD_ID, REV)] });
    assert.equal(api.requests.length, 0, 'nothing is replayed until the snapshot arrives');

    const response = await deliver(batch(events, SNAPSHOT), { gzip: true });
    assert.equal(response.status, 202);
    assert.equal(ready, 1);
    assert.ok(received);
    assert.equal(received.content, 'ping');
    assert.equal(received.author.id, ALICE.id);
    assert.equal(received.guild?.name, 'Relay Test Server');
    assert.equal(received.guild?.memberCount, 42, 'the ref carries the live member count');
    assert.equal(received.guild?.channels.cache.size, 2);
    assert.equal(received.guild?.members.me?.id, BOT.id);
    assert.equal(received.client.user.id, BOT.id);
    assert.equal(received.channel.id, CHANNEL_ID);
    assert.equal(received.member?.roles.cache.has(ROLE_ID), true);
    // Computed locally from roles and overwrites in the snapshot.
    assert.equal(received.member?.permissions.has(PermissionFlagsBits.Administrator), true);

    const sent = api.requests.at(-1)!;
    assert.equal(sent.method, 'POST');
    assert.equal(sent.path, `/api/v10/channels/${CHANNEL_ID}/messages`);
    assert.equal(sent.body.content, 'pong');
    assert.equal(sent.body.message_reference.message_id, '500000000000000001');
  });

  test('keeps guilds loaded across invocations, and replays batches in order', async () => {
    await deliver(batch([event('TYPING_START', { channel_id: CHANNEL_ID, guild_id: GUILD_ID }, { guild: GUILD_REF })], SNAPSHOT));

    const seen: string[] = [];
    client.on(Events.MessageCreate, (msg) => {
      seen.push(`${msg.guild?.name}: ${msg.content}`);
    });
    const warm = await deliver(
      batch(
        ['one', 'two', 'three'].map((content, i) =>
          event('MESSAGE_CREATE', message(content, { id: `50000000000000010${i}` }), { guild: GUILD_REF }),
        ),
      ),
    );
    assert.equal(warm.status, 202);
    assert.deepEqual(seen, ['Relay Test Server: one', 'Relay Test Server: two', 'Relay Test Server: three']);
  });

  test('replays INTERACTION_CREATE as a ChatInputCommandInteraction', async () => {
    client.once(Events.InteractionCreate, async (interaction) => {
      assert.ok(interaction.isChatInputCommand());
      assert.equal(interaction.commandName, 'ping');
      assert.ok(interaction.inCachedGuild());
      await interaction.reply({ content: `pong from ${interaction.guild.name}` });
    });

    const response = await deliver(batch([event('INTERACTION_CREATE', chatInputInteraction('ping'), { guild: GUILD_REF })], SNAPSHOT));
    assert.equal(response.status, 202);
    const callback = api.requests.at(-1)!;
    assert.match(callback.path, /^\/api\/v10\/interactions\/600000000000000001\/interaction-token\/callback/);
    assert.deepEqual(callback.body.data.content, 'pong from Relay Test Server');
  });

  test('passes old and new state on updates, then asks for the new revision', async () => {
    const updated = new Promise<[string, string]>((resolve) =>
      client.once(Events.GuildRoleUpdate, (oldRole, newRole) => resolve([oldRole.name, newRole.name])),
    );
    const role = { ...guildSnapshot().roles[1], name: 'Admins' };
    await deliver(batch([event('GUILD_ROLE_UPDATE', { guild_id: GUILD_ID, role }, { guild: GUILD_REF })], SNAPSHOT));
    assert.deepEqual(await updated, ['Moderators', 'Admins']);

    const next = await deliver(batch([event('MESSAGE_CREATE', message('after'), { guild: { ...GUILD_REF, rev: REV + 1 } })]));
    assert.equal(next.status, 409);
    assert.deepEqual(await next.json(), { missing: [snapshotKey(GUILD_ID, REV + 1)] });
  });

  test('loads the thread an event happened in', async () => {
    const thread = { id: '310000000000000001', type: 11, name: 'a thread', parent_id: CHANNEL_ID, guild_id: GUILD_ID, thread_metadata: { archived: false } };
    const received = new Promise<Message>((resolve) => client.once(Events.MessageCreate, resolve));
    await deliver(
      batch([event('MESSAGE_CREATE', message('in a thread', { channel_id: thread.id }), { guild: GUILD_REF, thread })], SNAPSHOT),
    );
    const msg = await received;
    assert.ok(msg.channel.isThread());
    assert.equal(msg.channel.name, 'a thread');
    assert.equal(msg.channel.parent?.name, 'general');
  });

  test('emits partials for uncached messages instead of dropping the event', async () => {
    const reacted = new Promise<boolean>((resolve) =>
      client.once(Events.MessageReactionAdd, (reaction) => resolve(reaction.message.partial)),
    );
    await deliver(
      batch(
        [
          event(
            'MESSAGE_REACTION_ADD',
            {
              user_id: ALICE.id,
              channel_id: CHANNEL_ID,
              message_id: '500000000000000123',
              guild_id: GUILD_ID,
              emoji: { id: null, name: '👍' },
              type: 0,
              burst: false,
            },
            { guild: GUILD_REF },
          ),
        ],
        SNAPSHOT,
      ),
    );
    assert.equal(await reacted, true);
  });

  test('tells joins (guildCreate) apart from guilds becoming available (guildAvailable)', async () => {
    const seen: string[] = [];
    client.on(Events.GuildCreate, (guild) => seen.push(`create:${guild.name}`));
    client.on(Events.GuildAvailable, (guild) => seen.push(`available:${guild.name}`));

    const joined = guildSnapshot({ id: '100000000000000002', name: 'New Server' });
    await deliver(batch([event('GUILD_CREATE', joined), event('GUILD_CREATE', guildSnapshot(), { guild: { id: GUILD_ID, unavailable: true } })]));
    assert.deepEqual(seen, ['create:New Server', 'available:Relay Test Server']);
  });

  test('ignores redelivered events', async () => {
    let count = 0;
    client.on(Events.TypingStart, () => count++);
    const typing = event(
      'TYPING_START',
      { channel_id: CHANNEL_ID, guild_id: GUILD_ID, user_id: ALICE.id, timestamp: Math.floor(Date.now() / 1000) },
      { guild: GUILD_REF },
    );
    assert.equal((await deliver(batch([typing, typing], SNAPSHOT))).status, 202);
    assert.equal((await deliver(batch([typing]))).status, 202);
    assert.equal(count, 1);
  });

  test('waits for async listeners, and one failing event does not stop the rest of the batch', async () => {
    const finished: string[] = [];
    client.on(Events.MessageCreate, async (msg) => {
      if (msg.content === 'boom') throw new Error('listener bug');
      await new Promise((resolve) => setTimeout(resolve, 20));
      finished.push(msg.content);
    });

    const response = await deliver(
      batch(
        [
          event('MESSAGE_CREATE', message('slow', { id: '500000000000000201' }), { guild: GUILD_REF }),
          event('MESSAGE_CREATE', message('boom', { id: '500000000000000202' }), { guild: GUILD_REF }),
          event('MESSAGE_CREATE', message('after', { id: '500000000000000203' }), { guild: GUILD_REF }),
        ],
        SNAPSHOT,
      ),
    );
    assert.equal(response.status, 202);
    assert.deepEqual(finished.sort(), ['after', 'slow']);
  });

  test('unloads the least recently used guild past maxGuilds', async () => {
    setup({ maxGuilds: 1 });
    const other = { id: '100000000000000002', rev: 7, memberCount: 1 };
    const typing = (guild: typeof other) => event('TYPING_START', { channel_id: CHANNEL_ID, guild_id: guild.id }, { guild });

    assert.equal((await deliver(batch([typing(GUILD_REF)], SNAPSHOT))).status, 202);
    const otherSnapshot = { [snapshotKey(other.id, other.rev)]: guildSnapshot({ id: other.id, name: 'Other' }) };
    assert.equal((await deliver(batch([typing(other)], otherSnapshot))).status, 202);
    assert.equal(client.guilds.cache.has(GUILD_ID), false);

    const evicted = await deliver(batch([typing(GUILD_REF)]));
    assert.equal(evicted.status, 409);
  });

  test('login() does not open a gateway connection', async () => {
    assert.equal(await client.login('ignored'), '');
    await deliver(batch([event('TYPING_START', { channel_id: CHANNEL_ID, guild_id: GUILD_ID }, { guild: GUILD_REF })], SNAPSHOT));
    assert.equal(await client.login('ignored'), TOKEN);
    assert.equal(client.ws.shards.size, 1);
  });
});
