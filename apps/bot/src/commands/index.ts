import { type ChatInputCommandInteraction, Collection, type SlashCommandOptionsOnlyBuilder } from 'discord.js';
import * as ping from './ping';
import * as server from './server';

export interface Command {
  data: SlashCommandOptionsOnlyBuilder;
  execute(interaction: ChatInputCommandInteraction): Promise<unknown>;
}

/** Every slash command. Run `pnpm commands:register` after changing names, descriptions or options. */
export const commands = new Collection<string, Command>([ping, server].map((command) => [command.data.name, command]));
