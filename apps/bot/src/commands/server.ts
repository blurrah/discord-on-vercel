import {
  type ChatInputCommandInteraction,
  EmbedBuilder,
  InteractionContextType,
  SlashCommandBuilder,
  time,
} from 'discord.js';

export const data = new SlashCommandBuilder()
  .setName('server')
  .setDescription('Shows information about this server')
  .setContexts(InteractionContextType.Guild);

export async function execute(interaction: ChatInputCommandInteraction) {
  if (!interaction.inCachedGuild()) {
    await interaction.reply('This command only works in a server.');
    return;
  }

  // The guild, its channels and roles come from the gateway's cache snapshot,
  // so none of this costs an API request.
  const { guild } = interaction;
  const embed = new EmbedBuilder()
    .setTitle(guild.name)
    .setThumbnail(guild.iconURL())
    .addFields(
      { name: 'Members', value: String(guild.memberCount), inline: true },
      { name: 'Channels', value: String(guild.channels.cache.size), inline: true },
      { name: 'Roles', value: String(guild.roles.cache.size), inline: true },
      { name: 'Created', value: time(guild.createdAt, 'R'), inline: true },
    );
  await interaction.reply({ embeds: [embed] });
}
