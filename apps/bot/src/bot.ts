import { Client, Events, GatewayIntentBits, MessageFlags } from 'discord.js';
import { commands } from './commands';

/**
 * Your bot: a regular discord.js client. Add intents and listeners as you
 * would in any discord.js project, with two differences:
 *
 * - Don't call `client.login()`. The gateway daemon (`apps/gateway`) holds
 *   the connection and relays each event to a Vercel Function, which replays
 *   it into this client.
 * - Each event may run on a different function instance, so keep state in a
 *   database rather than in memory.
 *
 * The gateway identifies with these intents and only forwards the events you
 * have listeners for. Change them, deploy, and the daemon picks them up.
 */
export const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
});

client.once(Events.ClientReady, (readyClient) => {
  // Runs once per function instance, not once per gateway connection.
  console.log(`Handling events for ${readyClient.user.tag}`);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand()) return;
  const command = commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(`/${interaction.commandName} failed`, error);
    const reply = { content: 'Something went wrong running that command.', flags: MessageFlags.Ephemeral } as const;
    if (interaction.replied || interaction.deferred) await interaction.followUp(reply);
    else await interaction.reply(reply);
  }
});

// Mentions are delivered with their content even without the privileged
// MessageContent intent. Add GatewayIntentBits.MessageContent (and enable it in
// the Developer Portal) to read every message.
client.on(Events.MessageCreate, async (message) => {
  if (message.author.bot || !message.mentions.users.has(client.user!.id)) return;
  await message.reply(`Hi ${message.author}! I'm running on Vercel. Try \`/ping\` or \`/server\`.`);
});
