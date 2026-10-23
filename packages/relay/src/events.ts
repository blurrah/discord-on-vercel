import { GUILD_AVAILABLE } from '@discord-on-vercel/gateway/protocol';
import type { Client } from 'discord.js';

/**
 * Which gateway dispatches can emit each discord.js client event. The gateway
 * only forwards dispatches the client has listeners for, so a bot that only
 * handles slash commands isn't invoked for every message.
 */
const DISPATCHES_BY_EVENT: Record<string, readonly string[]> = {
  applicationCommandPermissionsUpdate: ['APPLICATION_COMMAND_PERMISSIONS_UPDATE'],
  autoModerationActionExecution: ['AUTO_MODERATION_ACTION_EXECUTION'],
  autoModerationRuleCreate: ['AUTO_MODERATION_RULE_CREATE'],
  autoModerationRuleDelete: ['AUTO_MODERATION_RULE_DELETE'],
  autoModerationRuleUpdate: ['AUTO_MODERATION_RULE_UPDATE'],
  channelCreate: ['CHANNEL_CREATE'],
  channelDelete: ['CHANNEL_DELETE'],
  channelPinsUpdate: ['CHANNEL_PINS_UPDATE'],
  channelUpdate: ['CHANNEL_UPDATE'],
  emojiCreate: ['GUILD_EMOJIS_UPDATE'],
  emojiDelete: ['GUILD_EMOJIS_UPDATE'],
  emojiUpdate: ['GUILD_EMOJIS_UPDATE'],
  entitlementCreate: ['ENTITLEMENT_CREATE'],
  entitlementDelete: ['ENTITLEMENT_DELETE'],
  entitlementUpdate: ['ENTITLEMENT_UPDATE'],
  guildAuditLogEntryCreate: ['GUILD_AUDIT_LOG_ENTRY_CREATE'],
  guildAvailable: [GUILD_AVAILABLE],
  guildBanAdd: ['GUILD_BAN_ADD'],
  guildBanRemove: ['GUILD_BAN_REMOVE'],
  guildCreate: ['GUILD_CREATE'],
  guildDelete: ['GUILD_DELETE'],
  guildIntegrationsUpdate: ['GUILD_INTEGRATIONS_UPDATE'],
  guildMemberAdd: ['GUILD_MEMBER_ADD'],
  guildMemberAvailable: ['GUILD_MEMBER_UPDATE', 'PRESENCE_UPDATE'],
  guildMemberRemove: ['GUILD_MEMBER_REMOVE'],
  guildMembersChunk: ['GUILD_MEMBERS_CHUNK'],
  guildMemberUpdate: ['GUILD_MEMBER_UPDATE', 'USER_UPDATE'],
  guildScheduledEventCreate: ['GUILD_SCHEDULED_EVENT_CREATE'],
  guildScheduledEventDelete: ['GUILD_SCHEDULED_EVENT_DELETE'],
  guildScheduledEventUpdate: ['GUILD_SCHEDULED_EVENT_UPDATE'],
  guildScheduledEventUserAdd: ['GUILD_SCHEDULED_EVENT_USER_ADD'],
  guildScheduledEventUserRemove: ['GUILD_SCHEDULED_EVENT_USER_REMOVE'],
  guildSoundboardSoundCreate: ['GUILD_SOUNDBOARD_SOUND_CREATE'],
  guildSoundboardSoundDelete: ['GUILD_SOUNDBOARD_SOUND_DELETE'],
  guildSoundboardSoundsUpdate: ['GUILD_SOUNDBOARD_SOUNDS_UPDATE'],
  guildSoundboardSoundUpdate: ['GUILD_SOUNDBOARD_SOUND_UPDATE'],
  guildUnavailable: ['GUILD_DELETE'],
  guildUpdate: ['GUILD_UPDATE'],
  interactionCreate: ['INTERACTION_CREATE'],
  inviteCreate: ['INVITE_CREATE'],
  inviteDelete: ['INVITE_DELETE'],
  messageCreate: ['MESSAGE_CREATE'],
  messageDelete: ['MESSAGE_DELETE'],
  messageDeleteBulk: ['MESSAGE_DELETE_BULK'],
  messagePollVoteAdd: ['MESSAGE_POLL_VOTE_ADD'],
  messagePollVoteRemove: ['MESSAGE_POLL_VOTE_REMOVE'],
  messageReactionAdd: ['MESSAGE_REACTION_ADD'],
  messageReactionRemove: ['MESSAGE_REACTION_REMOVE'],
  messageReactionRemoveAll: ['MESSAGE_REACTION_REMOVE_ALL'],
  messageReactionRemoveEmoji: ['MESSAGE_REACTION_REMOVE_EMOJI'],
  messageUpdate: ['MESSAGE_UPDATE'],
  presenceUpdate: ['PRESENCE_UPDATE', 'USER_UPDATE'],
  roleCreate: ['GUILD_ROLE_CREATE'],
  roleDelete: ['GUILD_ROLE_DELETE'],
  roleUpdate: ['GUILD_ROLE_UPDATE'],
  soundboardSounds: ['SOUNDBOARD_SOUNDS'],
  stageInstanceCreate: ['STAGE_INSTANCE_CREATE'],
  stageInstanceDelete: ['STAGE_INSTANCE_DELETE'],
  stageInstanceUpdate: ['STAGE_INSTANCE_UPDATE'],
  stickerCreate: ['GUILD_STICKERS_UPDATE'],
  stickerDelete: ['GUILD_STICKERS_UPDATE'],
  stickerUpdate: ['GUILD_STICKERS_UPDATE'],
  subscriptionCreate: ['SUBSCRIPTION_CREATE'],
  subscriptionDelete: ['SUBSCRIPTION_DELETE'],
  subscriptionUpdate: ['SUBSCRIPTION_UPDATE'],
  threadCreate: ['THREAD_CREATE'],
  threadDelete: ['THREAD_DELETE'],
  threadListSync: ['THREAD_LIST_SYNC'],
  threadMembersUpdate: ['THREAD_MEMBERS_UPDATE'],
  threadMemberUpdate: ['THREAD_MEMBER_UPDATE'],
  threadUpdate: ['THREAD_UPDATE'],
  typingStart: ['TYPING_START'],
  userUpdate: ['USER_UPDATE'],
  voiceChannelEffectSend: ['VOICE_CHANNEL_EFFECT_SEND'],
  voiceServerUpdate: ['VOICE_SERVER_UPDATE'],
  voiceStateUpdate: ['VOICE_STATE_UPDATE'],
  webhooksUpdate: ['WEBHOOKS_UPDATE'],
};

/** Client events that aren't caused by a dispatch, so they don't need any forwarded. */
const LOCAL_EVENTS = new Set([
  'cacheSweep',
  'clientReady',
  'debug',
  'error',
  'invalidated',
  'ready',
  'shardDisconnect',
  'shardError',
  'shardReady',
  'shardReconnecting',
  'shardResume',
  'warn',
]);

/**
 * The dispatch types the gateway should forward for the client's current
 * listeners, or `'*'` when a listener needs everything (`raw`, or an event this
 * table doesn't know, such as one added in a newer discord.js).
 */
export function forwardedDispatches(client: Client): string[] | '*' {
  const dispatches = new Set<string>();
  for (const event of client.eventNames()) {
    if (typeof event !== 'string' || LOCAL_EVENTS.has(event)) continue;
    const mapped = DISPATCHES_BY_EVENT[event];
    if (!mapped) return '*';
    for (const dispatch of mapped) dispatches.add(dispatch);
  }
  return [...dispatches].sort();
}
