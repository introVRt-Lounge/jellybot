import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
} from "discord.js";
import { previewButtonCustomId, previewModalCustomId } from "./custom-id.ts";

export function buildPreviewActionRows(sessionId: string): ActionRowBuilder<ButtonBuilder>[] {
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(previewButtonCustomId("post", sessionId))
      .setLabel("Post")
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(previewButtonCustomId("cancel", sessionId))
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId(previewButtonCustomId("retry", sessionId))
      .setLabel("Try again")
      .setStyle(ButtonStyle.Primary),
  );
  return [row];
}

export function buildClipRetryModal(sessionId: string, startRaw: string, durationRaw: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(previewModalCustomId(sessionId))
    .setTitle("Adjust clip timing")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("start")
          .setLabel("Start time")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(startRaw),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Duration from start")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(durationRaw),
      ),
    );
}

export function buildQuoteRetryModal(
  sessionId: string,
  durationRaw: string,
  paddingRaw: string,
): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(previewModalCustomId(sessionId))
    .setTitle("Adjust quote clip")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("duration")
          .setLabel("Clip duration")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(durationRaw),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId("padding")
          .setLabel("Padding before quote")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setValue(paddingRaw),
      ),
    );
}
