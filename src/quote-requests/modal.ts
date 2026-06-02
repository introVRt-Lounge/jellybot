import {
  ActionRowBuilder,
  ModalBuilder,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ModalSubmitInteraction,
} from "discord.js";

// ----- Movie modal (existing) -----

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
  return (
    interaction.customId === QUOTE_REQUEST_MODAL_ID ||
    interaction.customId === QUOTE_REQUEST_TV_MODAL_ID
  );
}

export function isQuoteRequestMovieModal(interaction: ModalSubmitInteraction): boolean {
  return interaction.customId === QUOTE_REQUEST_MODAL_ID;
}

export function isQuoteRequestTvModal(interaction: ModalSubmitInteraction): boolean {
  return interaction.customId === QUOTE_REQUEST_TV_MODAL_ID;
}

export function buildQuoteRequestModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(QUOTE_REQUEST_MODAL_ID)
    .setTitle("Submit a movie quote request")
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

// ----- TV modal (new in V1) -----

export const QUOTE_REQUEST_TV_MODAL_ID = "quote_request_tv_modal";
export const QUOTE_REQUEST_TV_FIELD_SHOW = "show";
export const QUOTE_REQUEST_TV_FIELD_SEASON = "season";
export const QUOTE_REQUEST_TV_FIELD_EPISODE = "episode";
export const QUOTE_REQUEST_TV_FIELD_QUOTE = "quote";

export function buildQuoteRequestTvModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(QUOTE_REQUEST_TV_MODAL_ID)
    .setTitle("Submit a TV quote request")
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_TV_FIELD_SHOW)
          .setLabel("Show name (best guess)")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(200),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_TV_FIELD_SEASON)
          .setLabel("Season number")
          .setPlaceholder("e.g. 3")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_TV_FIELD_EPISODE)
          .setLabel("Episode number")
          .setPlaceholder("e.g. 7")
          .setStyle(TextInputStyle.Short)
          .setRequired(true)
          .setMaxLength(3),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder()
          .setCustomId(QUOTE_REQUEST_TV_FIELD_QUOTE)
          .setLabel("The line you want")
          .setStyle(TextInputStyle.Paragraph)
          .setRequired(true)
          .setMaxLength(500),
      ),
    );
}

export type ParsedTvQuoteRequest = {
  show: string;
  /** Numeric season; undefined when the user supplied something we couldn't parse. */
  season: number | undefined;
  /** Numeric episode; undefined when the user supplied something we couldn't parse. */
  episode: number | undefined;
  quote: string;
  /** Raw values for surfacing back in error messages without ambiguity. */
  rawSeason: string;
  rawEpisode: string;
};

export function parseQuoteRequestTvModal(
  interaction: ModalSubmitInteraction,
): ParsedTvQuoteRequest {
  const show = interaction.fields.getTextInputValue(QUOTE_REQUEST_TV_FIELD_SHOW).trim();
  const rawSeason = interaction.fields.getTextInputValue(QUOTE_REQUEST_TV_FIELD_SEASON).trim();
  const rawEpisode = interaction.fields.getTextInputValue(QUOTE_REQUEST_TV_FIELD_EPISODE).trim();
  const quote = interaction.fields.getTextInputValue(QUOTE_REQUEST_TV_FIELD_QUOTE).trim();
  return {
    show,
    season: parsePositiveInt(rawSeason),
    episode: parsePositiveInt(rawEpisode),
    quote,
    rawSeason,
    rawEpisode,
  };
}

function parsePositiveInt(value: string): number | undefined {
  if (!/^\d+$/.test(value)) return undefined;
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n >= 0 ? n : undefined;
}

// ----- Media-type select menu (Case B) -----

export const QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID = "quote_request_media_type";
export const QUOTE_REQUEST_MEDIA_TYPE_MOVIE = "movie";
export const QUOTE_REQUEST_MEDIA_TYPE_TV = "tv";

export function buildMediaTypeSelectMenu(): ActionRowBuilder<StringSelectMenuBuilder> {
  const select = new StringSelectMenuBuilder()
    .setCustomId(QUOTE_REQUEST_MEDIA_TYPE_SELECT_ID)
    .setPlaceholder("Pick one")
    .addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel("Movie")
        .setDescription("Add the movie via Radarr; clip posts when it lands")
        .setValue(QUOTE_REQUEST_MEDIA_TYPE_MOVIE),
      new StringSelectMenuOptionBuilder()
        .setLabel("TV show")
        .setDescription("Add the show via Sonarr and grab a single episode")
        .setValue(QUOTE_REQUEST_MEDIA_TYPE_TV),
    );
  return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select);
}

export const QUOTE_REQUEST_MEDIA_TYPE_PROMPT =
  "Were you looking for a **movie** or a **TV show**?";
