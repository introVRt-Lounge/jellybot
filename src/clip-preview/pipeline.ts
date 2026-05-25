import { randomUUID } from "node:crypto";
import { AttachmentBuilder, MessageFlags, type InteractionEditReplyOptions } from "discord.js";
import type { AppConfig } from "../config.ts";
import { formatDiscordUploadLimit, maxClipMbForDiscordUpload } from "../discord-upload.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import {
  buildClipArtifact,
  renderClip,
  validateClipItem,
  type ClipArtifact,
} from "../services/clip-service.ts";
import type { ClipPlan } from "../services/clip-request.ts";
import { buildPreviewActionRows } from "./components.ts";
import { clipPreviewStore, type ClipPreviewClipParams, type ClipPreviewCommand, type ClipPreviewQuoteParams } from "./store.ts";

const PREVIEW_FOOTER =
  "Only you can see this preview. Use **Post** to share it in the channel, **Cancel** to discard, or **Try again** to adjust timing.";

export type PreviewReplyTarget = {
  editReply: (options: InteractionEditReplyOptions | string) => Promise<unknown>;
  channelId: string | null;
  user: { id: string };
};

export type DeliverClipPreviewInput = {
  interaction: PreviewReplyTarget & { id: string; attachmentSizeLimit: number };
  jellyfin: JellyfinClient;
  config: Pick<AppConfig, "clipTempDir" | "maxClipMb" | "maxClipSeconds" | "audioLanguages" | "subtitleLanguages">;
  command: ClipPreviewCommand;
  plan: ClipPlan;
  previewLines: string[];
  burnInSubtitles: boolean;
  clipParams?: ClipPreviewClipParams;
  quoteParams?: ClipPreviewQuoteParams;
};

export async function deliverClipPreview(input: DeliverClipPreviewInput): Promise<void> {
  const { interaction, jellyfin, config, plan } = input;

  const maxClipMb = maxClipMbForDiscordUpload(interaction.attachmentSizeLimit, config.maxClipMb);
  const item = await jellyfin.getItem(plan.itemId);
  const validated = validateClipItem(item, plan);
  if (!validated.ok) {
    await interaction.editReply(validated.message);
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
    burnInSubtitles: input.burnInSubtitles,
    preferredSubtitleLanguages: config.subtitleLanguages,
    tempId: interaction.id,
  });

  if (!rendered.ok) {
    await interaction.editReply(rendered.message);
    return;
  }

  await showClipPreview({
    interaction,
    command: input.command,
    artifact,
    previewLines: input.previewLines,
    clipParams: input.clipParams,
    quoteParams: input.quoteParams,
  });

  console.info(
    JSON.stringify({
      event: `${input.command}.preview_ready`,
      command: input.command,
      userId: interaction.user.id,
      itemId: plan.itemId,
      durationSeconds: plan.durationSeconds,
      subtitlesBurnedIn: rendered.subtitlesBurnedIn,
    }),
  );
}

export async function showClipPreview(params: {
  interaction: PreviewReplyTarget;
  command: ClipPreviewCommand;
  artifact: ClipArtifact;
  previewLines: string[];
  clipParams?: ClipPreviewClipParams;
  quoteParams?: ClipPreviewQuoteParams;
  sessionId?: string;
}): Promise<string> {
  const sessionId = params.sessionId ?? randomUUID();
  const channelId = params.interaction.channelId;
  if (!channelId) {
    await params.interaction.editReply("This command must be used in a channel.");
    return sessionId;
  }

  const existing = clipPreviewStore.get(sessionId);
  if (!existing) {
    clipPreviewStore.create({
      id: sessionId,
      ownerUserId: params.interaction.user.id,
      channelId,
      command: params.command,
      outputPath: params.artifact.outputPath,
      attachmentName: params.artifact.attachmentName,
      label: params.artifact.label,
      previewLines: params.previewLines,
      clipParams: params.clipParams,
      quoteParams: params.quoteParams,
    });
  } else {
    clipPreviewStore.updateArtifact(sessionId, {
      outputPath: params.artifact.outputPath,
      attachmentName: params.artifact.attachmentName,
      label: params.artifact.label,
      previewLines: params.previewLines,
    });
    if (params.clipParams) existing.clipParams = params.clipParams;
    if (params.quoteParams) existing.quoteParams = params.quoteParams;
  }

  const attachment = new AttachmentBuilder(params.artifact.outputPath, {
    name: params.artifact.attachmentName,
  });

  const content = [
    "**Preview** — not posted to the channel yet.",
    ...params.previewLines,
    PREVIEW_FOOTER,
  ].join("\n");

  await params.interaction.editReply({
    content,
    files: [attachment],
    components: buildPreviewActionRows(sessionId),
  });

  return sessionId;
}

export function beginEphemeralClipPreview(interaction: { deferReply: (options: { flags: typeof MessageFlags.Ephemeral }) => Promise<unknown> }): Promise<unknown> {
  return interaction.deferReply({ flags: MessageFlags.Ephemeral });
}

export { formatDiscordUploadLimit };
