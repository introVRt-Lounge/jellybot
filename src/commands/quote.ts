import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import { withTimeout } from "../autocomplete.ts";
import { AutocompleteSessionGuard, isUnknownInteractionError } from "../autocomplete-guard.ts";
import { beginEphemeralClipPreview, deliverClipPreview } from "../clip-preview/pipeline.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import { parseQuoteMatchToken } from "../subtitles/match-token.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { quoteSearchChoices } from "../subtitles/quote-autocomplete.ts";
import { formatTimestamp } from "../time.ts";

const quoteMatchAutocompleteGuard = new AutocompleteSessionGuard();
const QUOTE_AUTOCOMPLETE_TIMEOUT_MS = 2500;

export const quoteCommand = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Search indexed subtitles for a quote and clip that scene.")
  .addStringOption((option) =>
    option
      .setName("match")
      .setDescription("Search quote text, then pick a match from autocomplete")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("Clip length from the quote (default 15s)")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("padding")
      .setDescription("Seconds before the quote to include (default 2s)")
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("subtitles")
      .setDescription("Burn subtitles into the clip video")
      .setRequired(false),
  );

export async function handleQuoteAutocomplete(
  interaction: AutocompleteInteraction,
  _jellyfin: JellyfinClient,
  config: Pick<AppConfig, "subtitleDbPath">,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "match") {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim();
  if (query.length < 3) {
    await interaction.respond([]);
    return;
  }

  try {
    const isCurrent = quoteMatchAutocompleteGuard.begin(
      `${interaction.user.id}:${interaction.guildId ?? "dm"}:quote:match`,
    );
    const index = openSubtitleIndex(config.subtitleDbPath);
    try {
      const results = await withTimeout(
        Promise.resolve(index.searchQuotes(query, 25)),
        QUOTE_AUTOCOMPLETE_TIMEOUT_MS,
      );
      const choices = quoteSearchChoices(results);
      if (!isCurrent() || interaction.responded) {
        return;
      }
      await interaction.respond(choices);
    } finally {
      index.close();
    }
  } catch (error) {
    if (isUnknownInteractionError(error)) {
      return;
    }
    console.error(
      JSON.stringify({
        event: "quote.autocomplete_failed",
        query,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    if (!interaction.responded) {
      await interaction.respond([]);
    }
  }
}

export async function handleQuoteCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: Pick<
    AppConfig,
    "clipTempDir" | "subtitleDbPath" | "maxClipMb" | "maxClipSeconds" | "subtitleDefaultClipSeconds" | "subtitleQuotePaddingSeconds" | "audioLanguages" | "subtitleLanguages"
  >,
): Promise<void> {
  const matchRaw = interaction.options.getString("match", true);
  const durationRaw = interaction.options.getString("duration");
  const paddingRaw = interaction.options.getString("padding");
  const burnInSubtitles = interaction.options.getBoolean("subtitles") ?? false;

  const token = parseQuoteMatchToken(matchRaw);
  if (!token) {
    await interaction.reply({
      content: "Pick a quote from the autocomplete list. Free-typed text in `match` is not supported.",
      ephemeral: true,
    });
    return;
  }

  const index = openSubtitleIndex(config.subtitleDbPath);
  let match;
  try {
    match = index.getCueMatch(token.itemId, token.startMs, token.endMs);
  } finally {
    index.close();
  }

  if (!match) {
    await interaction.reply({
      content: "That quote match is no longer in the subtitle index. Run `make index-subtitles` and try again.",
      ephemeral: true,
    });
    return;
  }

  const planned = planQuoteClip({
    match,
    durationRaw,
    paddingRaw,
    maxClipSeconds: config.maxClipSeconds,
    defaultClipSeconds: config.subtitleDefaultClipSeconds,
    defaultPaddingSeconds: config.subtitleQuotePaddingSeconds,
  });

  if (!planned.ok) {
    await interaction.reply({ content: planned.message, ephemeral: true });
    return;
  }

  console.info(
    JSON.stringify({
      event: "quote.requested",
      command: "quote",
      userId: interaction.user.id,
      itemId: planned.plan.itemId,
      cueStartSeconds: planned.plan.cueStartSeconds,
      durationSeconds: planned.plan.durationSeconds,
    }),
  );

  await beginEphemeralClipPreview(interaction);

  const item = await jellyfin.getItem(planned.plan.itemId);
  const label = item ? jellyfin.formatItemLabel(item, planned.plan.kind) : "Quote clip";

  await deliverClipPreview({
    interaction,
    jellyfin,
    config,
    command: "quote",
    plan: planned.plan,
    previewLines: [
      `**${label}**`,
      `"${planned.plan.quoteText}" @ ${formatTimestamp(planned.plan.cueStartSeconds)}`,
    ],
    burnInSubtitles,
    quoteParams: {
      matchRaw,
      durationRaw,
      paddingRaw,
      burnInSubtitles,
    },
  });
}
