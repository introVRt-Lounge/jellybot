import {
  AttachmentBuilder,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { AutocompleteSessionGuard, isAbortError, isUnknownInteractionError } from "../autocomplete-guard.ts";
import { searchClipMediaAutocompleteChoices } from "../clip-autocomplete.ts";
import type { AppConfig } from "../config.ts";
import { formatDiscordUploadLimit, maxClipMbForDiscordUpload } from "../discord-upload.ts";
import type { JellyfinClient, MediaKind } from "../jellyfin.ts";
import {
  buildClipArtifact,
  renderClip,
  validateClipItem,
} from "../services/clip-service.ts";
import { planClipRequest } from "../services/clip-request.ts";
import { cleanup } from "../ffmpeg.ts";

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
    if (isUnknownInteractionError(error) || isAbortError(error)) {
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
      await interaction.respond([]);
    }
  }
}

export async function handleClipCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: Pick<AppConfig, "clipTempDir" | "maxClipMb" | "maxClipSeconds" | "audioLanguages">,
): Promise<void> {
  const planned = planClipRequest({
    kind: interaction.options.getString("kind", true) as MediaKind,
    itemId: interaction.options.getString("media", true),
    startRaw: interaction.options.getString("start"),
    endRaw: interaction.options.getString("end"),
    durationRaw: interaction.options.getString("duration"),
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
        kind: interaction.options.getString("kind"),
        media: interaction.options.getString("media"),
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

  await interaction.deferReply();

  const maxClipMb = maxClipMbForDiscordUpload(interaction.attachmentSizeLimit, config.maxClipMb);

  const item = await jellyfin.getItem(planned.plan.itemId);
  const validated = validateClipItem(item, planned.plan);
  if (!validated.ok) {
    console.warn(
      JSON.stringify({
        event: "clip.rejected",
        command: "clip",
        userId: interaction.user.id,
        itemId: planned.plan.itemId,
        reason: validated.message,
      }),
    );
    await interaction.editReply(validated.message);
    return;
  }

  const artifact = buildClipArtifact(
    validated.item,
    planned.plan,
    interaction.id,
    config.clipTempDir,
    jellyfin.formatItemLabel.bind(jellyfin),
  );

  const rendered = await renderClip({
    jellyfin,
    item: validated.item,
    plan: planned.plan,
    outputPath: artifact.outputPath,
    maxClipMb,
    preferredAudioLanguages: config.audioLanguages,
  });

  if (!rendered.ok) {
    console.error(
      JSON.stringify({
        event: "clip.failed",
        command: "clip",
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
      content: [`**${artifact.label}**`, artifact.summaryLine, `Requested by ${interaction.user}`].join("\n"),
      files: [attachment],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("entity too large") || message.includes("413")) {
      await interaction.editReply(
        `Clip rendered but Discord rejected the upload for this server (limit ${formatDiscordUploadLimit(interaction.attachmentSizeLimit)}). Try a shorter clip.`,
      );
      return;
    }

    throw error;
  } finally {
    await cleanup(artifact.outputPath);
  }

  console.info(
    JSON.stringify({
      event: "clip.completed",
      command: "clip",
      userId: interaction.user.id,
      itemId: planned.plan.itemId,
      durationSeconds: planned.plan.durationSeconds,
      audioStreamIndex: rendered.ok ? rendered.audioStreamIndex : undefined,
      audioLanguage: rendered.ok ? rendered.audioLanguage : undefined,
    }),
  );
}
