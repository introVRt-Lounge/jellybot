import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { toAutocompleteChoices } from "../autocomplete.ts";
import { isBenignAutocompleteError } from "../autocomplete-guard.ts";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient, JellyfinItem } from "../jellyfin.ts";
import { isJellyfinItemId } from "../jellyfin.ts";
import {
  buildLibrarySubtitleCoverage,
  buildMovieSubtitleCoverage,
  buildSeriesSubtitleCoverage,
  formatSubtitleCoverageMessage,
} from "../services/subtitle-coverage.ts";
import { openSubtitleIndex, type SubtitleIndexStats } from "../subtitles/index-db.ts";

export const SUBCOVERAGE_KIND_CHOICES = [
  { name: "Library (movies + episodes)", value: "library" },
  { name: "Movie", value: "movie" },
  { name: "TV series", value: "series" },
] as const;

export type SubcoverageKind = (typeof SUBCOVERAGE_KIND_CHOICES)[number]["value"];

export const subcoverageCommand = new SlashCommandBuilder()
  .setName("subcoverage")
  .setDescription("Report Jellyfin subtitle coverage for your library or a title.")
  .addStringOption((option) =>
    option
      .setName("kind")
      .setDescription("Library-wide, a movie, or a TV series")
      .setRequired(false)
      .addChoices(...SUBCOVERAGE_KIND_CHOICES),
  )
  .addStringOption((option) =>
    option
      .setName("media")
      .setDescription("Movie or series to check (required for movie/series)")
      .setRequired(false)
      .setAutocomplete(true),
  );

function readQuoteIndexStats(config: AppConfig): SubtitleIndexStats | null {
  try {
    const index = openSubtitleIndex(config.subtitleDbPath);
    try {
      return index.getStats();
    } finally {
      index.close();
    }
  } catch {
    return null;
  }
}

function resolveKind(interaction: ChatInputCommandInteraction): SubcoverageKind {
  const raw = interaction.options.getString("kind");
  if (raw === "movie" || raw === "series") return raw;
  return "library";
}

export async function handleSubcoverageAutocomplete(
  interaction: AutocompleteInteraction,
  jellyfin: JellyfinClient,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  if (focused.name !== "media") {
    await interaction.respond([]);
    return;
  }

  const kind = (interaction.options.getString("kind") ?? "library") as SubcoverageKind;
  if (kind === "library") {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  try {
    const mediaKind = kind === "movie" ? "movie" : "tv";
    const items =
      kind === "movie"
        ? await jellyfin.search(query, "movie", 25)
        : await jellyfin.searchSeries(query, 25);
    const choices = toAutocompleteChoices(items, mediaKind, jellyfin.formatItemLabel.bind(jellyfin));
    console.info(
      JSON.stringify({
        event: "subcoverage.autocomplete",
        kind,
        query,
        resultCount: choices.length,
      }),
    );
    await interaction.respond(choices);
  } catch (error) {
    if (!isBenignAutocompleteError(error)) {
      console.error(
        JSON.stringify({
          event: "subcoverage.autocomplete.error",
          kind,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}

async function resolveMediaItem(
  jellyfin: JellyfinClient,
  kind: "movie" | "series",
  mediaId: string,
): Promise<JellyfinItem | null> {
  if (!isJellyfinItemId(mediaId)) {
    return null;
  }
  const item = await jellyfin.getItem(mediaId);
  if (!item) return null;
  if (kind === "movie" && item.type !== "Movie") return null;
  if (kind === "series" && item.type !== "Series") return null;
  return item;
}

export async function handleSubcoverageCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: AppConfig,
): Promise<void> {
  // Issue #142: ack first, work later. The validation reply for missing
  // `media` previously raced the 3-second ack budget; defer immediately
  // so all responses use the 15-min editReply window.
  await interaction.deferReply();

  const kind = resolveKind(interaction);
  const mediaId = interaction.options.getString("media")?.trim();

  if (kind !== "library" && !mediaId) {
    await interaction.editReply(
      "Pick a movie or series from autocomplete when checking a single title.",
    );
    return;
  }

  try {
    if (kind === "library") {
      console.info(JSON.stringify({ event: "subcoverage.requested", kind }));
      const report = await buildLibrarySubtitleCoverage(jellyfin, readQuoteIndexStats(config));
      await interaction.editReply(formatSubtitleCoverageMessage(report));
      return;
    }

    const item = await resolveMediaItem(jellyfin, kind, mediaId!);
    if (!item) {
      await interaction.editReply("That media item was not found or does not match the selected kind.");
      return;
    }

    const report =
      kind === "movie"
        ? await buildMovieSubtitleCoverage(jellyfin, item)
        : await buildSeriesSubtitleCoverage(jellyfin, item);
    await interaction.editReply(formatSubtitleCoverageMessage(report));
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "subcoverage.error",
        kind,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    await interaction.editReply("Could not load subtitle coverage from Jellyfin right now.");
  }
}
