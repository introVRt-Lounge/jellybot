import { MessageFlags, type StringSelectMenuInteraction } from "discord.js";
import {
  QUOTE_REQUEST_MEDIA_TYPE_MOVIE,
  QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID,
  QUOTE_REQUEST_MEDIA_TYPE_TV,
  buildQuoteRequestModal,
  buildQuoteRequestTvModal,
} from "./modal.ts";

export function isQuoteRequestMediaTypeSelect(
  interaction: StringSelectMenuInteraction,
): boolean {
  return interaction.customId === QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID;
}

/**
 * Handle the "Movie / TV show" disambiguator. The select menu lives on an
 * ephemeral message that follows /quote's "Can't find it?" autocomplete.
 *
 * On selection we open the appropriate modal. `showModal` consumes the
 * interaction; the originating ephemeral message stays around with the
 * select menu visible (Discord doesn't auto-clear it). That's acceptable -
 * the modal is the focal point, and the user can safely ignore the leftover.
 */
export async function handleQuoteRequestMediaTypeSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const choice = interaction.values[0];

  if (choice === QUOTE_REQUEST_MEDIA_TYPE_MOVIE) {
    await interaction.showModal(buildQuoteRequestModal());
    return;
  }

  if (choice === QUOTE_REQUEST_MEDIA_TYPE_TV) {
    await interaction.showModal(buildQuoteRequestTvModal());
    return;
  }

  await interaction.reply({
    content:
      "Pick either Movie or TV show. If neither fits, run `/quote` again with a more specific search.",
    flags: MessageFlags.Ephemeral,
  });
}
