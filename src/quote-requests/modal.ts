import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";

export const QUOTE_REQUEST_MODAL_ID = "quote_request_modal";
export const QUOTE_REQUEST_FIELD_MOVIE = "movie";
export const QUOTE_REQUEST_FIELD_QUOTE = "quote";

/** Magic autocomplete value indicating "user wants to request a quote that isn't indexed". */
export const QUOTE_REQUEST_AUTOCOMPLETE_TOKEN = "request:new";

/**
 * Discord autocomplete only fills the option's value; the user still has to
 * press Enter to submit the slash command. The label needs to make that two-step
 * action explicit, otherwise users pick the entry expecting a modal to pop and
 * get nothing. Markdown is NOT rendered in autocomplete, so emphasis is via
 * UPPERCASE and not asterisks.
 */
export const QUOTE_REQUEST_AUTOCOMPLETE_LABEL =
  "Can't find it? Click and SUBMIT this choice - you can request it!";

export function isQuoteRequestModal(interaction: ModalSubmitInteraction): boolean {
  return interaction.customId === QUOTE_REQUEST_MODAL_ID;
}

export function buildQuoteRequestModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(QUOTE_REQUEST_MODAL_ID)
    .setTitle("Submit a quote request")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_FIELD_MOVIE)
          .setLabel("Movie title (best guess)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_FIELD_QUOTE)
          .setLabel("The line you want")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
}

export type ParsedQuoteRequest = {
  movie: string;
  quote: string;
};

export function parseQuoteRequestModal(interaction: ModalSubmitInteraction): ParsedQuoteRequest {
  const movie = interaction.fields.getTextInputValue(QUOTE_REQUEST_FIELD_MOVIE).trim();
  const quote = interaction.fields.getTextInputValue(QUOTE_REQUEST_FIELD_QUOTE).trim();
  return { movie, quote };
}
