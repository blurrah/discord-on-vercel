/**
 * Registers the slash commands in `src/commands` with Discord.
 *
 *   pnpm commands:register                       # globally
 *   DISCORD_GUILD_ID=123 pnpm commands:register  # one server, updates instantly (good for testing)
 */
import { type APIApplication, PermissionFlagsBits, REST, Routes } from 'discord.js';
import { commands } from '../src/commands';

const token = process.env.DISCORD_TOKEN;
if (!token) {
  console.error('DISCORD_TOKEN is not set. Run `vercel env pull` in the repository root, or add it to .env.local.');
  process.exit(1);
}

const rest = new REST().setToken(token);
const application = (await rest.get(Routes.currentApplication())) as APIApplication;
const guildId = process.env.DISCORD_GUILD_ID;
const body = commands.map((command) => command.data.toJSON());

await rest.put(
  guildId ? Routes.applicationGuildCommands(application.id, guildId) : Routes.applicationCommands(application.id),
  { body },
);
const names = commands.map((command) => `/${command.data.name}`).join(', ');
console.log(`Registered ${names} for ${application.name} ${guildId ? `in guild ${guildId}` : 'globally'}.`);
console.log(
  `Invite the bot: https://discord.com/oauth2/authorize?client_id=${application.id}&scope=bot+applications.commands&permissions=${PermissionFlagsBits.SendMessages | PermissionFlagsBits.ViewChannel}`,
);
