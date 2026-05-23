import {
  AttachmentBuilder,
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
} from "discord.js";
import { searchAutocompleteChoices } from "../autocomplete.ts";
import type { AppConfig } from "../config.ts";
import type { JellyfinClient, MediaKind } from "../jellyfin.ts";
import {
  buildClipArtifact,
  renderClip,
  validateClipItem,
} from "../services/clip-service.ts";
import { planClipRequest } from "../services/clip-request.ts";
import { cleanup } from "../ffmpeg.ts";

export const clipCommand = new SlashCommandBuilder()
  .setName("clip")
  .setDescription("Clip a scene from Jellyfin and post it in this channel.")
  .addStringOption((option) =>
    option
      .setName("kind")
      .setDescription("Movie or TV episode")
      .setRequired(true)
      .addChoices(
        { name: "Movie", value: "movie" },
        { name: "TV episode", value: "tv" },
      ),
  )
  .addStringOption((option) =>
    option
      .setName("media")
      .setDescription("Search your Jellyfin library")
      .setRequired(true)
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
  if (focused.name !== "media") {
    await interaction.respond([]);
    return;
  }

  const kind = interaction.options.getString("kind") as MediaKind | null;
  if (!kind) {
    await interaction.respond([]);
    return;
  }

  const query = focused.value.trim();
  if (query.length < 2) {
    await interaction.respond([]);
    return;
  }

  try {
    const choices = await searchAutocompleteChoices(jellyfin, query, kind);
    await interaction.respond(choices);
  } catch (error) {
    console.error("Autocomplete search failed:", error);
    if (!interaction.responded) {
      await interaction.respond([]);
    }
  }
}

export async function handleClipCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: Pick<AppConfig, "maxClipMb" | "maxClipSeconds">,
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
    maxClipMb: config.maxClipMb,
  });

  if (!rendered.ok) {
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
    }),
  );
}
