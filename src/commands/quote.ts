import {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
  SlashCommandBuilder,
  type ApplicationCommandOptionChoiceData,
} from "discord.js";
import type { AppConfig } from "../config.ts";
import { runDeferredSyncWithTimeout, waitDebounced, yieldToEventLoop, autocompleteInteractionAgeMs, isAutocompleteInteractionExpired } from "../autocomplete.ts";
import { AutocompleteSessionGuard, isBenignAutocompleteError } from "../autocomplete-guard.ts";
import { beginEphemeralClipPreview, deliverClipPreview } from "../clip-preview/pipeline.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import { planQuoteClip } from "../services/quote-request.ts";
import { parseQuoteMatchToken } from "../subtitles/match-token.ts";
import { openSubtitleIndex } from "../subtitles/index-db.ts";
import {
  rememberQuoteMatchSearchCache,
  shapeQuoteAutocompleteQuery,
  tryQuoteMatchPrefixCache,
} from "../subtitles/quote-query-shaping.ts";
import { quoteSearchChoices } from "../subtitles/quote-autocomplete.ts";
import { getSubtitleSearchIndex } from "../subtitles/search-index.ts";
import { formatTimestamp } from "../time.ts";
import {
  buildMediaTypeSelectMenu,
  QUOTE_REQUEST_AUTOCOMPLETE_LABEL,
  QUOTE_REQUEST_AUTOCOMPLETE_TOKEN,
  QUOTE_REQUEST_MEDIA_TYPE_PROMPT,
} from "../quote-requests/modal.ts";
export { QUOTE_REQUEST_AUTOCOMPLETE_TOKEN } from "../quote-requests/modal.ts";

const quoteAutocompleteInFlight = new Map<string, Promise<void>>();
const quoteMatchAutocompleteGuard = new AutocompleteSessionGuard();
const quoteSeriesAutocompleteGuard = new AutocompleteSessionGuard();
const QUOTE_MATCH_AUTOCOMPLETE_KEY = (interaction: AutocompleteInteraction) =>
  `${interaction.user.id}:${interaction.guildId ?? "dm"}:quote:match`;
const QUOTE_MATCH_AUTOCOMPLETE_CACHE_KEY = (
  interaction: AutocompleteInteraction,
  seriesFilter?: string,
) => `${QUOTE_MATCH_AUTOCOMPLETE_KEY(interaction)}:${seriesFilter?.toLowerCase() ?? ""}`;
const QUOTE_SERIES_AUTOCOMPLETE_KEY = (interaction: AutocompleteInteraction) =>
  `${interaction.user.id}:${interaction.guildId ?? "dm"}:quote:series`;
const QUOTE_AUTOCOMPLETE_TIMEOUT_MS = 2500;
const QUOTE_MATCH_AUTOCOMPLETE_DEBOUNCE_MS = 200;
const QUOTE_MATCH_AUTOCOMPLETE_MAX_TOKEN_AGE_MS = 2500;
const QUOTE_SERIES_AUTOCOMPLETE_LIMIT = 25;

export const quoteCommand = new SlashCommandBuilder()
  .setName("quote")
  .setDescription("Search indexed subtitles for a quote and clip that scene.")
  .addStringOption((option) =>
    option
      .setName("match")
      .setDescription("Search quote text, then pick a match from autocomplete")
      .setRequired(true)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("series")
      .setDescription("Narrow to a TV series (autocomplete). Useful when bare keywords surface other shows.")
      .setRequired(false)
      .setAutocomplete(true),
  )
  .addStringOption((option) =>
    option
      .setName("duration")
      .setDescription("Clip length from the quote (default 15s)")
      .setRequired(false),
  )
  .addStringOption((option) =>
    option
      .setName("padding")
      .setDescription("Seconds before the quote to include (default 2s)")
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("subtitles")
      .setDescription("Burn subtitles into the clip video")
      .setRequired(false),
  );

async function safeAutocompleteRespond(
  interaction: AutocompleteInteraction,
  choices: ApplicationCommandOptionChoiceData[],
  context: { query: string; resultCount: number },
): Promise<void> {
  if (interaction.responded) {
    console.info(
      JSON.stringify({
        event: "quote.autocomplete.respond_skip",
        reason: "already_responded",
        query: context.query,
        resultCount: context.resultCount,
      }),
    );
    return;
  }

  try {
    await interaction.respond(choices);
    console.info(
      JSON.stringify({
        event: "quote.autocomplete.responded",
        query: context.query,
        resultCount: context.resultCount,
        responded: interaction.responded,
      }),
    );
  } catch (error) {
    if (isBenignAutocompleteError(error)) {
      console.warn(
        JSON.stringify({
          event: "quote.autocomplete.respond_skipped",
          query: context.query,
          resultCount: context.resultCount,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return;
    }
    throw error;
  }
}

async function dropStaleQuoteAutocomplete(
  interaction: AutocompleteInteraction,
  isCurrent: () => boolean,
  query: string,
): Promise<boolean> {
  if (interaction.responded) {
    return true;
  }

  if (!isCurrent()) {
    await safeAutocompleteRespond(interaction, [], { query, resultCount: 0 });
    return true;
  }

  if (isAutocompleteInteractionExpired(interaction, QUOTE_MATCH_AUTOCOMPLETE_MAX_TOKEN_AGE_MS)) {
    console.info(
      JSON.stringify({
        event: "quote.autocomplete.respond_skip",
        reason: "token_expired",
        query,
        ageMs: autocompleteInteractionAgeMs(interaction),
      }),
    );
    return true;
  }

  return false;
}

async function finishQuoteAutocomplete(
  interaction: AutocompleteInteraction,
  isCurrent: () => boolean,
  choices: ApplicationCommandOptionChoiceData[],
  query: string,
): Promise<void> {
  if (await dropStaleQuoteAutocomplete(interaction, isCurrent, query)) {
    return;
  }
  if (interaction.responded) {
    return;
  }
  await safeAutocompleteRespond(interaction, choices, { query, resultCount: choices.length });
}

export async function handleQuoteAutocomplete(
  interaction: AutocompleteInteraction,
  _jellyfin: JellyfinClient,
  config: Pick<AppConfig, "subtitleDbPath">,
): Promise<void> {
  const existing = quoteAutocompleteInFlight.get(interaction.id);
  if (existing) {
    return existing;
  }

  // Register before any await: handleQuoteAutocompleteOnce runs synchronously until its
  // first await, so calling it before set() allowed duplicate handlers for one token.
  let release!: () => void;
  let fail!: (error: unknown) => void;
  const gate = new Promise<void>((resolve, reject) => {
    release = resolve;
    fail = reject;
  });
  quoteAutocompleteInFlight.set(interaction.id, gate);

  try {
    await handleQuoteAutocompleteOnce(interaction, config);
    release();
  } catch (error) {
    fail(error);
    throw error;
  } finally {
    quoteAutocompleteInFlight.delete(interaction.id);
  }
}

async function handleQuoteAutocompleteOnce(
  interaction: AutocompleteInteraction,
  config: Pick<AppConfig, "subtitleDbPath">,
): Promise<void> {
  const focused = interaction.options.getFocused(true);

  if (focused.name === "series") {
    await respondSeriesAutocomplete(interaction, config);
    return;
  }

  if (focused.name !== "match") {
    await safeAutocompleteRespond(interaction, [], { query: "", resultCount: 0 });
    return;
  }

  const query = focused.value.trim();

  // Pick up the optional series filter alongside the focused `match` value
  // so cue autocomplete narrows to the chosen show before bm25 ranks it.
  const seriesFilterRaw = interaction.options.getString("series");
  const seriesFilter = seriesFilterRaw && seriesFilterRaw.trim().length > 0 ? seriesFilterRaw.trim() : undefined;

  // Issue #154: with a series filter active, the FTS search space is
  // already narrowed to one show, so a 1-char prefix is tractable and
  // replaces any stale cached list the moment the user types after
  // setting `series:`. Without a filter the 3-char minimum stays (the
  // 17.7M-cue global catalogue is too noisy for shorter prefixes).
  const minQueryLength = seriesFilter ? 1 : 3;
  if (query.length < minQueryLength) {
    // Abort any in-flight debounced handler still waiting on a longer value.
    quoteMatchAutocompleteGuard.beginCancellable(QUOTE_MATCH_AUTOCOMPLETE_KEY(interaction));
    await safeAutocompleteRespond(interaction, [], { query, resultCount: 0 });
    return;
  }

  try {
    const cacheKey = QUOTE_MATCH_AUTOCOMPLETE_CACHE_KEY(interaction, seriesFilter);
    const { isCurrent, signal } = quoteMatchAutocompleteGuard.beginCancellable(
      QUOTE_MATCH_AUTOCOMPLETE_KEY(interaction),
    );

    await yieldToEventLoop();
    if (await dropStaleQuoteAutocomplete(interaction, isCurrent, query)) {
      return;
    }

    try {
      await waitDebounced(QUOTE_MATCH_AUTOCOMPLETE_DEBOUNCE_MS, signal);
    } catch (error) {
      if (isBenignAutocompleteError(error)) {
        return;
      }
      throw error;
    }

    if (await dropStaleQuoteAutocomplete(interaction, isCurrent, query)) {
      return;
    }

    const searchQuery = shapeQuoteAutocompleteQuery(query);
    const index = getSubtitleSearchIndex(config.subtitleDbPath);

    let results = tryQuoteMatchPrefixCache(cacheKey, query, searchQuery, seriesFilter);
    let usedPrefixCache = results !== null;

    if (!results) {
      results = await runDeferredSyncWithTimeout(
        () => index.searchQuotes(searchQuery, 24, seriesFilter),
        QUOTE_AUTOCOMPLETE_TIMEOUT_MS,
        signal,
      );
      rememberQuoteMatchSearchCache(cacheKey, query, searchQuery, results, seriesFilter);
    }

    const choices: ApplicationCommandOptionChoiceData[] = quoteSearchChoices(results);
    choices.push({
      name: QUOTE_REQUEST_AUTOCOMPLETE_LABEL,
      value: QUOTE_REQUEST_AUTOCOMPLETE_TOKEN,
    });

    console.info(
      JSON.stringify({
        event: "quote.autocomplete",
        interactionId: interaction.id,
        query,
        searchQuery,
        usedPrefixCache,
        seriesFilter: seriesFilter ?? null,
        minQueryLength,
        resultCount: choices.length,
      }),
    );

    await finishQuoteAutocomplete(interaction, isCurrent, choices, query);
  } catch (error) {
    if (isBenignAutocompleteError(error)) {
      await safeAutocompleteRespond(interaction, [], { query, resultCount: 0 });
      return;
    }

    console.error(
      JSON.stringify({
        event: "quote.autocomplete_failed",
        query,
        seriesFilter: seriesFilter ?? null,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );

    await safeAutocompleteRespond(interaction, [], { query, resultCount: 0 });
  }
}

async function respondSeriesAutocomplete(
  interaction: AutocompleteInteraction,
  config: Pick<AppConfig, "subtitleDbPath">,
): Promise<void> {
  const focused = interaction.options.getFocused(true);
  const prefix = focused.value.trim();

  try {
    const { isCurrent, signal } = quoteSeriesAutocompleteGuard.beginCancellable(
      QUOTE_SERIES_AUTOCOMPLETE_KEY(interaction),
    );

    await yieldToEventLoop();
    if (await dropStaleQuoteAutocomplete(interaction, isCurrent, prefix)) {
      return;
    }

    const index = getSubtitleSearchIndex(config.subtitleDbPath);
    const names = await runDeferredSyncWithTimeout(
      () => index.listSeriesNames(prefix, QUOTE_SERIES_AUTOCOMPLETE_LIMIT),
      QUOTE_AUTOCOMPLETE_TIMEOUT_MS,
      signal,
    );

    const choices: ApplicationCommandOptionChoiceData[] = names.map((name) => ({
      name: name.slice(0, 100),
      value: name,
    }));

    console.info(
      JSON.stringify({
        event: "quote.series_autocomplete",
        interactionId: interaction.id,
        query: prefix,
        resultCount: choices.length,
      }),
    );

    await finishQuoteAutocomplete(interaction, isCurrent, choices, prefix);
  } catch (error) {
    if (isBenignAutocompleteError(error)) {
      await safeAutocompleteRespond(interaction, [], { query: prefix, resultCount: 0 });
      return;
    }

    console.error(
      JSON.stringify({
        event: "quote.series_autocomplete_failed",
        query: prefix,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );

    await safeAutocompleteRespond(interaction, [], { query: prefix, resultCount: 0 });
  }
}

export async function handleQuoteCommand(
  interaction: ChatInputCommandInteraction,
  jellyfin: JellyfinClient,
  config: Pick<
    AppConfig,
    "clipTempDir" | "subtitleDbPath" | "maxClipMb" | "maxClipSeconds" | "subtitleDefaultClipSeconds" | "subtitleQuotePaddingSeconds" | "audioLanguages" | "subtitleLanguages"
  >,
): Promise<void> {
  // Issue #142: ack first, work later. Discord gives us a 3-second budget
  // from interaction receipt to ack (reply or deferReply) before the token
  // is invalidated server-side. Anything we do before the ack is on a
  // shrinking clock - the post-Watchtower-recreate window saw "Unknown
  // interaction" failures because the rejection branches did
  // `interaction.reply(...)` after a token parse + db open + planning.
  // Defer immediately, then editReply for every outcome.
  await beginEphemeralClipPreview(interaction);

  const matchRaw = interaction.options.getString("match", true);
  const seriesRaw = interaction.options.getString("series");
  const seriesFilter = seriesRaw && seriesRaw.trim().length > 0 ? seriesRaw.trim() : undefined;
  const durationRaw = interaction.options.getString("duration");
  const paddingRaw = interaction.options.getString("padding");
  const burnInSubtitles = interaction.options.getBoolean("subtitles") ?? false;

  if (matchRaw === QUOTE_REQUEST_AUTOCOMPLETE_TOKEN) {
    // The deferred reply is already ephemeral, so editReply with the select
    // menu still gates Movie/TV path selection behind the same private UX.
    await interaction.editReply({
      content: QUOTE_REQUEST_MEDIA_TYPE_PROMPT,
      components: [buildMediaTypeSelectMenu()],
    });
    return;
  }

  const token = parseQuoteMatchToken(matchRaw);
  if (!token) {
    await interaction.editReply(
      "Pick a quote from the autocomplete list, or use the `Can't find it? Submit a request` option to ask the bot to fetch the movie.",
    );
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
    await interaction.editReply(
      "That quote match is no longer in the subtitle index. Run `make index-subtitles` and try again.",
    );
    return;
  }

  // Defence against autocomplete-then-change-series: if the user picked a
  // cue, then narrowed `series:` to a different show before submitting,
  // refuse rather than fetching a clip from the wrong show. Movies (NULL
  // series_name) never satisfy a series filter.
  if (seriesFilter) {
    const matchSeries = match.seriesName ?? null;
    if (!matchSeries || matchSeries.toLowerCase() !== seriesFilter.toLowerCase()) {
      await interaction.editReply(
        `That quote isn't from **${seriesFilter}**. Re-run \`/quote\` with the matching series, or clear the \`series\` option.`,
      );
      return;
    }
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
    await interaction.editReply(planned.message);
    return;
  }

  console.info(
    JSON.stringify({
      event: "quote.requested",
      command: "quote",
      userId: interaction.user.id,
      itemId: planned.plan.itemId,
      cueStartSeconds: planned.plan.cueStartSeconds,
      durationSeconds: planned.plan.durationSeconds,
    }),
  );

  const item = await jellyfin.getItem(planned.plan.itemId);
  const label = item ? jellyfin.formatItemLabel(item, planned.plan.kind) : "Quote clip";

  await deliverClipPreview({
    interaction,
    jellyfin,
    config,
    command: "quote",
    plan: planned.plan,
    previewLines: [
      `> ${planned.plan.quoteText}`,
      `-# **${label}** @ ${formatTimestamp(planned.plan.cueStartSeconds)}`,
    ],
    burnInSubtitles,
    quoteParams: {
      matchRaw,
      durationRaw,
      paddingRaw,
      burnInSubtitles,
    },
  });
}
