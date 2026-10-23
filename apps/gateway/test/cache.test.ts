import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GatewayCache } from '../src/cache.ts';
import type { DispatchPacket, GuildRef } from '../src/protocol.ts';

const BOT = { id: '9', username: 'bot' };
let s = 0;
const packet = (t: string, d: any): DispatchPacket => ({ op: 0, t, s: ++s, d });
const guild = (id: string, extra: object = {}) => ({
  id,
  name: `guild ${id}`,
  member_count: 2,
  channels: [{ id: `${id}-general`, type: 0, name: 'general' }],
  threads: [],
  roles: [{ id, name: '@everyone', permissions: '0' }],
  emojis: [],
  stickers: [],
  members: [{ user: BOT, roles: [] }, { user: { id: '7' }, roles: [] }],
  presences: [{ user: { id: '7' } }],
  ...extra,
});

function connected(guildIds: string[]): GatewayCache {
  const cache = new GatewayCache();
  cache.apply(packet('READY', { user: BOT, application: { id: BOT.id }, guilds: guildIds.map((id) => ({ id })) }), 0);
  return cache;
}

function rev(ref: GuildRef | undefined): number {
  assert.ok(ref && 'rev' in ref, 'expected a revisioned ref');
  return ref.rev;
}

const messageIn = (guildId: string, channelId = `${guildId}-general`) =>
  packet('MESSAGE_CREATE', { id: 'm', guild_id: guildId, channel_id: channelId });

test('classifies GUILD_CREATE like discord.js: available on startup, create on join, nothing on re-identify', () => {
  const cache = connected(['1']);
  const startup = packet('GUILD_CREATE', guild('1'));
  assert.equal(cache.kindOf(startup), 'GUILD_AVAILABLE');
  assert.deepEqual(cache.refFor(startup), { id: '1', unavailable: true });
  cache.apply(startup, 0);

  const join = packet('GUILD_CREATE', guild('2'));
  assert.equal(cache.kindOf(join), 'GUILD_CREATE');
  assert.equal(cache.refFor(join), undefined);
  cache.apply(join, 0);

  // A fresh session re-sends GUILD_CREATE for guilds we already have.
  cache.apply(packet('READY', { user: BOT, application: { id: BOT.id }, guilds: [{ id: '1' }, { id: '2' }] }), 0);
  assert.equal(cache.kindOf(packet('GUILD_CREATE', guild('1'))), null);
  assert.equal(cache.guildCount, 2);
});

test('an outage makes the guild unavailable, then available again', () => {
  const cache = connected(['1']);
  cache.apply(packet('GUILD_CREATE', guild('1')), 0);
  cache.apply(packet('GUILD_DELETE', { id: '1', unavailable: true }), 0);
  assert.deepEqual(cache.refFor(messageIn('1')), { id: '1', unavailable: true });
  assert.equal(cache.kindOf(packet('GUILD_CREATE', guild('1'))), 'GUILD_AVAILABLE');
});

test('READY drops guilds the bot left while disconnected', () => {
  const cache = connected(['1', '2']);
  cache.apply(packet('GUILD_CREATE', guild('1')), 0);
  cache.apply(packet('GUILD_CREATE', guild('2')), 0);
  cache.apply(packet('READY', { user: BOT, application: { id: BOT.id }, guilds: [{ id: '1' }] }), 0);
  assert.equal(cache.guildCount, 1);
});

test('structure changes bump the revision; messages and member counts do not', () => {
  const cache = connected(['1']);
  cache.apply(packet('GUILD_CREATE', guild('1')), 0);
  const first = rev(cache.refFor(messageIn('1')));

  cache.apply(messageIn('1'), 0);
  cache.apply(packet('GUILD_MEMBER_ADD', { guild_id: '1', user: { id: '8' } }), 0);
  cache.apply(packet('THREAD_CREATE', { id: 't', guild_id: '1', parent_id: '1-general' }), 0);
  assert.deepEqual(cache.refFor(messageIn('1')), { id: '1', rev: first, memberCount: 3 });

  cache.apply(packet('GUILD_ROLE_CREATE', { guild_id: '1', role: { id: 'r', name: 'mods' } }), 0);
  assert.ok(rev(cache.refFor(messageIn('1'))) > first);
});

test('snapshots reflect channel, role and member changes, and never leak presences or other members', () => {
  const cache = connected(['1']);
  cache.apply(packet('GUILD_CREATE', guild('1')), 0);
  cache.apply(packet('CHANNEL_CREATE', { id: '1-news', guild_id: '1', type: 5, name: 'news' }), 0);
  cache.apply(packet('CHANNEL_DELETE', { id: '1-general', guild_id: '1', type: 0 }), 0);
  cache.apply(packet('GUILD_ROLE_CREATE', { guild_id: '1', role: { id: 'r', name: 'mods' } }), 0);
  cache.apply(packet('GUILD_MEMBER_UPDATE', { guild_id: '1', user: BOT, roles: ['r'], nick: 'botty' }), 0);
  cache.apply(packet('GUILD_UPDATE', { id: '1', name: 'renamed', roles: [{ id: 'r', name: 'mods' }] }), 0);

  const snapshot = cache.snapshot('1', rev(cache.refFor(messageIn('1'))))!;
  assert.equal(snapshot.name, 'renamed');
  assert.equal(snapshot.member_count, 2);
  assert.deepEqual((snapshot.channels as any[]).map((channel) => channel.id), ['1-news']);
  assert.deepEqual((snapshot.roles as any[]).map((role) => role.id), ['r']);
  assert.deepEqual(snapshot.members!.map((member) => member.nick), ['botty']);
  assert.equal(snapshot.presences, undefined);
});

test('keeps earlier revisions so in-flight batches get the state their events were sent against', () => {
  const cache = connected(['1']);
  cache.apply(packet('GUILD_CREATE', guild('1')), 0);
  const before = rev(cache.refFor(messageIn('1')));
  const oldSnapshot = cache.snapshot('1', before)!;

  cache.apply(packet('CHANNEL_UPDATE', { id: '1-general', guild_id: '1', type: 0, name: 'renamed' }), 0);
  const after = rev(cache.refFor(messageIn('1')));

  assert.equal((cache.snapshot('1', before)!.channels as any[])[0].name, 'general');
  assert.equal((cache.snapshot('1', after)!.channels as any[])[0].name, 'renamed');
  assert.equal((oldSnapshot.channels as any[])[0].name, 'general', 'snapshots handed out are never mutated');

  for (let i = 0; i < 10; i++) cache.apply(packet('GUILD_ROLE_CREATE', { guild_id: '1', role: { id: `r${i}` } }), 0);
  assert.equal(cache.snapshot('1', before)!.name, 'guild 1', 'falls back to the current state once a revision ages out');
});

test('sends the thread an event happened in, as it was before the event', () => {
  const cache = connected(['1']);
  cache.apply(
    packet('GUILD_CREATE', guild('1', { threads: [{ id: 't1', parent_id: 'a', name: 'old' }, { id: 't2', parent_id: 'b' }] })),
    0,
  );
  assert.deepEqual(cache.threadFor(messageIn('1', 't1')), { id: 't1', parent_id: 'a', name: 'old' });
  assert.equal(cache.threadFor(messageIn('1')), undefined);

  const update = packet('THREAD_UPDATE', { id: 't1', guild_id: '1', parent_id: 'a', name: 'new' });
  assert.equal(cache.threadFor(update)!.name, 'old');
  cache.apply(update, 0);
  assert.equal(cache.threadFor(messageIn('1', 't1'))!.name, 'new');

  cache.apply(packet('THREAD_LIST_SYNC', { guild_id: '1', channel_ids: ['a'], threads: [{ id: 't3', parent_id: 'a' }] }), 0);
  assert.equal(cache.threadFor(messageIn('1', 't1')), undefined);
  assert.ok(cache.threadFor(messageIn('1', 't2')));
  assert.ok(cache.threadFor(messageIn('1', 't3')));
});

test('trims GUILD_CREATE to the bot member and no presences', () => {
  const cache = connected(['1']);
  const trimmed = cache.trimGuildCreate(packet('GUILD_CREATE', guild('1')));
  assert.equal(trimmed.d.presences, undefined);
  assert.deepEqual(trimmed.d.members.map((member: any) => member.user.id), [BOT.id]);
});
