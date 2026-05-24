import {
  AttachmentBuilder,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import { formatDiscordUploadLimit, maxClipMbForDiscordUpload } from "../discord-upload.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import {
  buildClipArtifact,
  renderClip,
  validateClipItem,
} from "../services/clip-service.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import { parseQuoteMatchToken } from "../subtitles/match-token.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { quoteSearchChoices } from "../subtitles/quote-autocomplete.ts";
import { enrichQuoteSearchResults } from "../subtitles/enrich-quote-results.ts";
import { cleanup } from "../ffmpeg.ts";
import { formatTimestamp } from "../time.ts";

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
  );

export async function handleQuoteAutocomplete(
  interaction: AutocompleteInteraction,
  jellyfin: JellyfinClient,
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
    const index = openSubtitleIndex(config.subtitleDbPath);
    try {
      const results = index.searchQuotes(query, 25);
      const enriched = await enrichQuoteSearchResults(jellyfin, results);
      const choices = quoteSearchChoices(enriched);
      await interaction.respond(choices);
    } finally {
      index.close();
    }
  } catch (error) {
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
    "subtitleDbPath" | "maxClipMb" | "maxClipSeconds" | "subtitleDefaultClipSeconds" | "subtitleQuotePaddingSeconds"
  >,
): Promise<void> {
  const matchRaw = interaction.options.getString("match", true);
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
    durationRaw: interaction.options.getString("duration"),
    paddingRaw: interaction.options.getString("padding"),
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

  await interaction.deferReply();

  const maxClipMb = maxClipMbForDiscordUpload(interaction.attachmentSizeLimit, config.maxClipMb);
  const item = await jellyfin.getItem(planned.plan.itemId);
  const validated = validateClipItem(item, planned.plan);
  if (!validated.ok) {
    await interaction.editReply(validated.message);
    return;
  }

  const artifact = buildClipArtifact(
    validated.item,
    planned.plan,
    interaction.id,
    jellyfin.formatItemLabel.bind(jellyfin),
  );

  const rendered = await renderClip({
    jellyfin,
    item: validated.item,
    plan: planned.plan,
    outputPath: artifact.outputPath,
    maxClipMb,
  });

  if (!rendered.ok) {
    console.error(
      JSON.stringify({
        event: "quote.failed",
        command: "quote",
        userId: interaction.user.id,
        itemId: planned.plan.itemId,
        reason: rendered.message,
      }),
    );
    await interaction.editReply(rendered.message);
    return;
  }

  try {
    const attachment = new AttachmentBuilder(artifact.outputPath, {
      name: artifact.attachmentName,
    });

    await interaction.editReply({
      content: [
        `**${artifact.label}**`,
        `"${planned.plan.quoteText}" @ ${formatTimestamp(planned.plan.cueStartSeconds)}`,
        `Requested by ${interaction.user}`,
      ].join("\n"),
      files: [attachment],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("entity too large") || message.includes("413")) {
      await interaction.editReply(
        `Clip rendered but Discord rejected the upload for this server (limit ${formatDiscordUploadLimit(interaction.attachmentSizeLimit)}). Try a shorter duration.`,
      );
      return;
    }

    throw error;
  } finally {
    await cleanup(artifact.outputPath);
  }

  console.info(
    JSON.stringify({
      event: "quote.completed",
      command: "quote",
      userId: interaction.user.id,
      itemId: planned.plan.itemId,
      durationSeconds: planned.plan.durationSeconds,
    }),
  );
}
