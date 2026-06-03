import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { AutocompleteSessionGuard, isBenignAutocompleteError } from "../autocomplete-guard.ts";
import { searchClipMediaAutocompleteChoices } from "../clip-autocomplete.ts";
import { beginEphemeralClipPreview, deliverClipPreview } from "../clip-preview/pipeline.ts";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient, MediaKind } from "../jellyfin.ts";
import { planClipRequest } from "../services/clip-request.ts";
import { formatTimestamp } from "../time.ts";

export const KIND_AUTOCOMPLETE_CHOICES = [
  { name: "Movie", value: "movie" },
  { name: "TV episode", value: "tv" },
] as const;

const clipMediaAutocompleteGuard = new AutocompleteSessionGuard();
const CLIP_MEDIA_AUTOCOMPLETE_KEY = (interaction: AutocompleteInteraction) =>
  `${interaction.user.id}:${interaction.guildId ?? "dm"}:clip:media`;

export const clipCommand = new SlashCommandBuilder()
  .setName("clip")
  .setDescription("Clip a scene from Jellyfin and post it in this channel.")
  .addStringOption((option) =>
    option
      .setName("kind")
      .setDescription("Movie or TV episode")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("media")
      .setDescription("Search your Jellyfin library")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("start")
      .setDescription("Start time (examples: 90, 1:30, 01:02:03)")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("end")
      .setDescription("End time. Use this or duration, not both.")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("Clip length from start. Use this or end, not both.")
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("subtitles")
      .setDescription("Burn subtitles into the clip video")
      .setRequired(false),
  );

export async function handleClipAutocomplete(
  interaction: AutocompleteInteraction,
  jellyfin: JellyfinClient,
): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (focused.name === "kind") {
    const query = focused.value.trim().toLowerCase();
    const choices = KIND_AUTOCOMPLETE_CHOICES.filter((choice) => {
      if (!query) return true;
      return choice.name.toLowerCase().includes(query) || choice.value.includes(query);
    });
    console.info(
      JSON.stringify({
        event: "clip.autocomplete",
        field: "kind",
        query,
        resultCount: choices.length,
      }),
    );
    await interaction.respond([...choices]);
    return;
  }

  if (focused.name !== "media") {
    await interaction.respond([]);
    return;
  }

  const kind = interaction.options.getString("kind") as MediaKind | null;
  if (!kind || (kind !== "movie" && kind !== "tv")) {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  try {
    const { isCurrent, signal } = clipMediaAutocompleteGuard.beginCancellable(
      CLIP_MEDIA_AUTOCOMPLETE_KEY(interaction),
    );
    const choices = await searchClipMediaAutocompleteChoices(jellyfin, query, kind, signal);
    console.info(
      JSON.stringify({
        event: "clip.autocomplete",
        field: "media",
        kind,
        query,
        resultCount: choices.length,
      }),
    );
    if (!isCurrent() || interaction.responded) {
      return;
    }
    await interaction.respond(choices);
  } catch (error) {
    if (isBenignAutocompleteError(error)) {
      return;
    }
    console.error(
      JSON.stringify({
        event: "clip.autocomplete_failed",
        kind,
        query,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    if (!interaction.responded) {
      await interaction.respond([]).catch(() => undefined);
    }
  }
}

function formatDurationOption(seconds: number): string {
  if (Number.isInteger(seconds) && seconds < 120) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  if (mins === 0) return `${secs}s`;
  if (secs === 0) return `${mins}:00`;
  return `${mins}:${String(secs).padStart(2, "0")}`;
}

export async function handleClipCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: Pick<
    AppConfig,
    "clipTempDir" | "maxClipMb" | "maxClipSeconds" | "audioLanguages" | "subtitleLanguages" | "subtitleDbPath"
  >,
): Promise<void> {
  const startRaw = interaction.options.getString("start");
  const endRaw = interaction.options.getString("end");
  const durationRaw = interaction.options.getString("duration");
  const kind = interaction.options.getString("kind", true) as MediaKind;
  const itemId = interaction.options.getString("media", true);
  const burnInSubtitles = interaction.options.getBoolean("subtitles") ?? false;

  const planned = planClipRequest({
    kind,
    itemId,
    startRaw,
    endRaw,
    durationRaw,
    maxClipSeconds: config.maxClipSeconds,
  });

  if (!planned.ok) {
    console.warn(
      JSON.stringify({
        event: "clip.rejected",
        command: "clip",
        userId: interaction.user.id,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        reason: planned.message,
        kind,
        media: itemId,
      }),
    );
    await interaction.reply({ content: planned.message, ephemeral: true });
    return;
  }

  console.info(
    JSON.stringify({
      event: "clip.requested",
      command: "clip",
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      kind: planned.plan.kind,
      itemId: planned.plan.itemId,
      durationSeconds: planned.plan.durationSeconds,
    }),
  );

  await beginEphemeralClipPreview(interaction);

  const item = await jellyfin.getItem(planned.plan.itemId);
  const label = item ? jellyfin.formatItemLabel(item, planned.plan.kind) : "Clip";

  await deliverClipPreview({
    interaction,
    jellyfin,
    config,
    command: "clip",
    plan: planned.plan,
    previewLines: [
      `**${label}**`,
      `Clip: ${formatTimestamp(planned.plan.startSeconds)} -> ${formatTimestamp(planned.plan.endSeconds)} (${Math.round(planned.plan.durationSeconds)}s)`,
    ],
    burnInSubtitles,
    clipParams: {
      kind,
      itemId,
      startRaw: startRaw!,
      endRaw,
      durationRaw: durationRaw ?? formatDurationOption(planned.plan.durationSeconds),
      burnInSubtitles,
    },
  });
}
