import { type ChatInputCommandInteraction, SlashCommandBuilder } from 'discord.js';

export const data = new SlashCommandBuilder().setName('ping').setDescription('Replies with Pong!');

export async function execute(interaction: ChatInputCommandInteraction) {
  // How long the interaction took to travel Discord → gateway daemon → function.
  const latency = Date.now() - interaction.createdTimestamp;
  await interaction.reply(`Pong! This interaction reached a Vercel Function ${latency}ms after you sent it.`);
}
