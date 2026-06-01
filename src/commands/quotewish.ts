import {
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import { QuoteRequestStore } from "../quote-requests/store.ts";

export const QUOTE_WISH_COMMAND_NAME = "quotewish";
const MAX_PENDING_PER_USER = 10;
const MAX_QUOTE_LENGTH = 500;
const MAX_MOVIE_LENGTH = 200;

export const quoteWishCommand = new SlashCommandBuilder()
  .setName(QUOTE_WISH_COMMAND_NAME)
  .setDescription("Submit a quote you wish the bot had. We'll ping you when it shows up.")
  .addStringOption((option) =>
    option
      .setName("movie")
      .setDescription("Movie or show title (free text). Best guess is fine.")
      .setRequired(true)
      .setMaxLength(MAX_MOVIE_LENGTH),
  )
  .addStringOption((option) =>
    option
      .setName("quote")
      .setDescription("The line you want, as best as you remember it.")
      .setRequired(true)
      .setMaxLength(MAX_QUOTE_LENGTH),
  );

export async function handleQuoteWishCommand(
  interaction: ChatInputCommandInteraction,
  config: Pick<AppConfig, "botStateDbPath">,
): Promise<void> {
  const guildId = interaction.guildId;
  const channelId = interaction.channelId;
  if (!guildId || !channelId) {
    await interaction.reply({
      content: "Use `/quotewish` inside a server channel.",
      ephemeral: true,
    });
    return;
  }

  const movie = interaction.options.getString("movie", true).trim();
  const quote = interaction.options.getString("quote", true).trim();
  if (!movie || !quote) {
    await interaction.reply({
      content: "Both `movie` and `quote` are required.",
      ephemeral: true,
    });
    return;
  }

  const store = new QuoteRequestStore(config.botStateDbPath);
  try {
    const pending = store.countPendingForRequester(interaction.user.id);
    if (pending >= MAX_PENDING_PER_USER) {
      await interaction.reply({
        content: `You already have ${pending} pending quote requests (max ${MAX_PENDING_PER_USER}). Wait for a few to land before adding more.`,
        ephemeral: true,
      });
      return;
    }

    const row = store.insert({
      requesterDiscordId: interaction.user.id,
      requesterName: interaction.user.displayName || interaction.user.username,
      guildId,
      channelId,
      movieText: movie,
      quoteText: quote,
    });

    console.info(
      JSON.stringify({
        event: "quotewish.created",
        requestId: row.id,
        userId: interaction.user.id,
        guildId,
        channelId,
        movieLen: movie.length,
        quoteLen: quote.length,
      }),
    );

    await interaction.reply({
      content:
        `Got it. I'll watch for **${truncate(movie, 80)}** with the line ` +
        `_"${truncate(quote, 120)}"_ and ping you here when it shows up.`,
      ephemeral: true,
    });
  } finally {
    store.close();
  }
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}
