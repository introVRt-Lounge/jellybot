import {
  AttachmentBuilder,
  type ButtonInteraction,
  type ModalSubmitInteraction,
  type TextChannel,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import { formatDiscordUploadLimit, maxClipMbForDiscordUpload } from "../discord-upload.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { cleanup } from "../ffmpeg.ts";
import { formatTimestamp } from "../time.ts";
import { openSubtitleIndexForResolver } from "../services/clip-item-resolver.ts";
import {
  buildClipArtifact,
  renderClip,
  resolveAndValidateClipItem,
} from "../services/clip-service.ts";
import { planClipRequest } from "../services/clip-request.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import { parseQuoteMatchToken } from "../subtitles/match-token.ts";
import { buildClipRetryModal, buildPreviewActionRows, buildQuoteRetryModal } from "./components.ts";
import { parsePreviewButtonCustomId, parsePreviewModalCustomId } from "./custom-id.ts";
import type { PreviewReplyTarget } from "./pipeline.ts";
import { showClipPreview } from "./pipeline.ts";
import { applyPreviewAction } from "./state-machine.ts";
import { clipPreviewStore } from "./store.ts";

type PreviewConfig = Pick<
  AppConfig,
  | "clipTempDir"
  | "maxClipMb"
  | "maxClipSeconds"
  | "audioLanguages"
  | "subtitleLanguages"
  | "subtitleDbPath"
  | "subtitleDefaultClipSeconds"
  | "subtitleQuotePaddingSeconds"
>;

async function replyPreviewError(
  interaction: ButtonInteraction | ModalSubmitInteraction,
  message: string,
): Promise<void> {
  if (interaction.deferred || interaction.replied) {
    await interaction.followUp({ content: message, ephemeral: true }).catch(() => undefined);
    return;
  }
  await interaction.reply({ content: message, ephemeral: true }).catch(() => undefined);
}

function formatDurationRaw(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return formatTimestamp(seconds);
}

export async function handleClipPreviewButton(
  interaction: ButtonInteraction,
  jellyfin: JellyfinClient,
  config: PreviewConfig,
): Promise<void> {
  const parsed = parsePreviewButtonCustomId(interaction.customId);
  if (!parsed) return;

  const session = clipPreviewStore.get(parsed.sessionId);
  if (!session) {
    await replyPreviewError(interaction, "That preview expired. Run the command again.");
    return;
  }

  if (session.ownerUserId !== interaction.user.id) {
    await replyPreviewError(interaction, "Only the person who requested this clip can use these buttons.");
    return;
  }

  const transition = applyPreviewAction(session.state, parsed.action);
  if (!transition.ok) {
    await replyPreviewError(interaction, transition.message);
    return;
  }

  if (parsed.action === "retry") {
    if (session.command === "clip" && session.clipParams) {
      const durationField =
        session.clipParams.durationRaw ??
        session.clipParams.endRaw ??
        formatDurationRaw(config.maxClipSeconds > 30 ? 30 : config.maxClipSeconds);
      await interaction.showModal(
        buildClipRetryModal(session.id, session.clipParams.startRaw, durationField),
      );
      return;
    }

    if (session.command === "quote" && session.quoteParams) {
      await interaction.showModal(
        buildQuoteRetryModal(
          session.id,
          session.quoteParams.durationRaw ?? formatDurationRaw(config.subtitleDefaultClipSeconds),
          session.quoteParams.paddingRaw ?? formatDurationRaw(config.subtitleQuotePaddingSeconds),
        ),
      );
      return;
    }

    await replyPreviewError(interaction, "Could not reopen clip options for this preview.");
    return;
  }

  if (parsed.action === "cancel") {
    clipPreviewStore.updateState(session.id, transition.state);
    await cleanup(session.outputPath);
    clipPreviewStore.delete(session.id);
    await interaction.update({
      content: "Preview cancelled. Nothing was posted to the channel.",
      components: [],
      files: [],
    });
    console.info(
      JSON.stringify({
        event: `${session.command}.preview_cancelled`,
        command: session.command,
        userId: interaction.user.id,
        sessionId: session.id,
      }),
    );
    return;
  }

  await interaction.deferUpdate();

  const channel = interaction.channel;
  if (!channel || !channel.isTextBased()) {
    await interaction.editReply({
      content: "Could not post — channel is unavailable.",
      components: [],
      files: [],
    });
    return;
  }

  try {
    const attachment = new AttachmentBuilder(session.outputPath, {
      name: session.attachmentName,
    });

    const publicContent = [...session.previewLines, `-# Requested by <@${session.ownerUserId}>`].join("\n");

    await (channel as TextChannel).send({
      content: publicContent,
      files: [attachment],
    });

    clipPreviewStore.updateState(session.id, transition.state);
    await cleanup(session.outputPath);
    clipPreviewStore.delete(session.id);

    await interaction.editReply({
      content: "Posted to the channel.",
      components: [],
      files: [],
    });

    console.info(
      JSON.stringify({
        event: `${session.command}.preview_posted`,
        command: session.command,
        userId: interaction.user.id,
        sessionId: session.id,
        channelId: session.channelId,
      }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    if (message.includes("entity too large") || message.includes("413")) {
      await interaction.editReply({
        content: `Discord rejected the upload (limit ${formatDiscordUploadLimit(interaction.attachmentSizeLimit)}). Try a shorter clip with **Try again**.`,
        components: buildPreviewActionRows(session.id),
      });
      return;
    }

    await interaction.editReply({
      content: "Failed to post the clip to the channel.",
      components: buildPreviewActionRows(session.id),
    });
    console.error(
      JSON.stringify({
        event: `${session.command}.preview_post_failed`,
        command: session.command,
        userId: interaction.user.id,
        sessionId: session.id,
        error: message,
      }),
    );
  }
}

export async function handleClipPreviewModal(
  interaction: ModalSubmitInteraction,
  jellyfin: JellyfinClient,
  config: PreviewConfig,
): Promise<void> {
  const parsed = parsePreviewModalCustomId(interaction.customId);
  if (!parsed) return;

  const session = clipPreviewStore.get(parsed.sessionId);
  if (!session) {
    await replyPreviewError(interaction, "That preview expired. Run the command again.");
    return;
  }

  if (session.ownerUserId !== interaction.user.id) {
    await replyPreviewError(interaction, "Only the person who requested this clip can adjust it.");
    return;
  }

  if (session.state !== "awaiting_approval") {
    await replyPreviewError(interaction, "That preview is no longer editable.");
    return;
  }

  await interaction.deferUpdate();
  await interaction.editReply({
    content: "Re-rendering preview…",
    components: [],
    files: [],
  });

  const oldPath = session.outputPath;
  let plan;
  let previewLines: string[];
  let burnInSubtitles = false;
  let clipParams = session.clipParams;
  let quoteParams = session.quoteParams;

  if (session.command === "clip" && session.clipParams) {
    const startRaw = interaction.fields.getTextInputValue("start");
    const durationRaw = interaction.fields.getTextInputValue("duration");
    burnInSubtitles = session.clipParams.burnInSubtitles;
    clipParams = {
      ...session.clipParams,
      startRaw,
      endRaw: null,
      durationRaw,
    };

    const planned = planClipRequest({
      kind: clipParams.kind,
      itemId: clipParams.itemId,
      startRaw,
      endRaw: null,
      durationRaw,
      maxClipSeconds: config.maxClipSeconds,
    });

    if (!planned.ok) {
      await interaction.editReply({
        content: planned.message,
        components: buildPreviewActionRows(session.id),
      });
      return;
    }

    plan = planned.plan;
    previewLines = [
      `-# **${session.label}** | ${formatTimestamp(plan.startSeconds)} -> ${formatTimestamp(plan.endSeconds)} (${Math.round(plan.durationSeconds)}s)`,
    ];
  } else if (session.command === "quote" && session.quoteParams) {
    const durationRaw = interaction.fields.getTextInputValue("duration");
    const paddingRaw = interaction.fields.getTextInputValue("padding");
    burnInSubtitles = session.quoteParams.burnInSubtitles;
    quoteParams = {
      ...session.quoteParams,
      durationRaw,
      paddingRaw,
    };

    const token = parseQuoteMatchToken(quoteParams.matchRaw);
    if (!token) {
      await interaction.editReply({
        content: "Quote match is invalid. Run `/quote` again.",
        components: [],
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
      await interaction.editReply({
        content: "That quote match is no longer in the subtitle index.",
        components: [],
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
      await interaction.editReply({
        content: planned.message,
        components: buildPreviewActionRows(session.id),
      });
      return;
    }

    plan = planned.plan;
    previewLines = [
      `> ${planned.plan.quoteText}`,
      `-# **${session.label}** @ ${formatTimestamp(planned.plan.cueStartSeconds)}`,
    ];
  } else {
    await interaction.editReply({
      content: "Could not re-render this preview.",
      components: [],
    });
    return;
  }

  const maxClipMb = maxClipMbForDiscordUpload(interaction.attachmentSizeLimit, config.maxClipMb);
  const subtitleIndex = openSubtitleIndexForResolver(config.subtitleDbPath);
  const validated = await resolveAndValidateClipItem({ jellyfin, subtitleIndex, plan });
  if (!validated.ok) {
    await interaction.editReply({
      content: validated.message,
      components: buildPreviewActionRows(session.id),
    });
    return;
  }

  const artifact = buildClipArtifact(
    validated.item,
    plan,
    interaction.id,
    config.clipTempDir,
    jellyfin.formatItemLabel.bind(jellyfin),
  );

  const rendered = await renderClip({
    jellyfin,
    item: validated.item,
    plan,
    outputPath: artifact.outputPath,
    maxClipMb,
    preferredAudioLanguages: config.audioLanguages,
    burnInSubtitles,
    preferredSubtitleLanguages: config.subtitleLanguages,
    tempId: interaction.id,
  });

  await cleanup(oldPath);

  if (!rendered.ok) {
    await interaction.editReply({
      content: rendered.message,
      components: buildPreviewActionRows(session.id),
    });
    return;
  }

  await showClipPreview({
    interaction: interaction as PreviewReplyTarget,
    command: session.command,
    artifact,
    previewLines,
    clipParams,
    quoteParams,
    sessionId: session.id,
  });

  console.info(
    JSON.stringify({
      event: `${session.command}.preview_rerendered`,
      command: session.command,
      userId: interaction.user.id,
      sessionId: session.id,
      durationSeconds: plan.durationSeconds,
    }),
  );
}

export function isClipPreviewButton(interaction: ButtonInteraction): boolean {
  return parsePreviewButtonCustomId(interaction.customId) !== null;
}


export function isClipPreviewModal(interaction: ModalSubmitInteraction): boolean {
  return parsePreviewModalCustomId(interaction.customId) !== null;
}
