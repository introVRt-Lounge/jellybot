import { MessageFlags, type ModalSubmitInteraction } from "discord.js";
import type { AppConfig } from "../config.ts";
import { RadarrApiError, RadarrClient } from "../radarr/client.ts";
import {
  acquireMovie,
  checkDiskSpace,
  pickBestCandidate,
  resolveAcquisitionDefaults,
  type AcquisitionRefusal,
} from "../radarr/acquire.ts";
import { SonarrApiError, SonarrClient } from "../sonarr/client.ts";
import {
  acquireEpisode,
  checkSonarrDiskSpace,
  pickBestSeries,
  resolveSonarrDefaults,
  type SonarrAcquisitionRefusal,
} from "../sonarr/acquire.ts";
import {
  isQuoteRequestMovieModal,
  isQuoteRequestTvModal,
  parseQuoteRequestModal,
  parseQuoteRequestTvModal,
} from "./modal.ts";
import { QuoteRequestStore } from "./store.ts";

const MAX_PENDING_PER_USER = 10;

export type QuoteRequestModalConfig = Pick<
  AppConfig,
  | "botStateDbPath"
  | "radarrUrl"
  | "radarrApiKey"
  | "radarrQualityProfileId"
  | "radarrRootFolderPath"
  | "radarrMinFreeGb"
  | "sonarrUrl"
  | "sonarrApiKey"
  | "sonarrQualityProfileId"
  | "sonarrLanguageProfileId"
  | "sonarrRootFolderPath"
  | "sonarrMinFreeGb"
  | "sonarrExcludedRootKeywords"
>;

export async function handleQuoteRequestModalSubmit(
  interaction: ModalSubmitInteraction,
  config: QuoteRequestModalConfig,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Use the quote request flow inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  if (isQuoteRequestTvModal(interaction)) {
    await handleTvQuoteRequest(interaction, config);
    return;
  }

  if (!isQuoteRequestMovieModal(interaction)) {
    // Defensive: Discord should only route registered modal customIds here.
    return;
  }

  const { movie, quote } = parseQuoteRequestModal(interaction);
  if (!movie || !quote) {
    await interaction.reply({
      content: "Both movie and quote are required.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const store = new QuoteRequestStore(config.botStateDbPath);
  try {
    const pending = store.listPending().filter((r) => r.requesterDiscordId === interaction.user.id);
    if (pending.length >= MAX_PENDING_PER_USER) {
      await interaction.editReply(
        `You already have ${pending.length} pending quote requests (max ${MAX_PENDING_PER_USER}). Wait for a few to land.`,
      );
      return;
    }

    const radarrEnabled = Boolean(config.radarrUrl && config.radarrApiKey);
    if (!radarrEnabled) {
      // Fallback: behave like the original watch-and-notify flow (State B - we already
      // have this movie, just no subs yet). Operator drops a sidecar SRT or runs Bazarr;
      // reconciler will fulfill on next FTS match.
      const row = store.insert({
        requesterDiscordId: interaction.user.id,
        requesterName: interaction.user.displayName || interaction.user.username,
        guildId: interaction.guildId,
        channelId: interaction.channelId,
        movieText: movie,
        quoteText: quote,
      });
      logQuoteRequestEvent("created.no_radarr", row.id, interaction);
      await interaction.editReply(
        `Saved as a watch request. Radarr isn't configured on this bot, so it can't fetch missing movies - I'll only ping you if **${truncate(movie, 80)}** is already in the library and the quote shows up after a re-index.`,
      );
      return;
    }

    const client = new RadarrClient(config.radarrUrl!, config.radarrApiKey!);

    const defaults = await resolveAcquisitionDefaults(client, {
      qualityProfileId: config.radarrQualityProfileId,
      rootFolderPath: config.radarrRootFolderPath,
    });
    if ("kind" in defaults) {
      await interaction.editReply(formatRefusal(defaults));
      return;
    }

    const refusal = checkDiskSpace(defaults, config.radarrMinFreeGb);
    if (refusal) {
      await interaction.editReply(formatRefusal(refusal));
      return;
    }

    const lookupResults = await client.lookup(movie);
    const pick = pickBestCandidate(lookupResults, { movieText: movie });
    if ("kind" in pick) {
      await interaction.editReply(
        `No movie matches **${truncate(movie, 80)}** in Radarr's metadata sources. Try a more specific title (and a year if you know it).`,
      );
      return;
    }

    const altsLine = pick.alternatives.length
      ? `\nOther matches: ${pick.alternatives
          .map((alt) => `${alt.title}${alt.year ? ` (${alt.year})` : ""}`)
          .join(", ")}`
      : "";

    let movieRow;
    try {
      movieRow = await acquireMovie({
        client,
        candidate: pick.candidate,
        defaults,
      });
    } catch (error) {
      if (isMovieAlreadyAddedError(error)) {
        const existing = await client.findMovieByTmdbId(pick.candidate.tmdbId);
        if (!existing) {
          throw error;
        }
        const status = existing.hasFile ? "imported" : "searching";
        const row = store.insert({
          requesterDiscordId: interaction.user.id,
          requesterName: interaction.user.displayName || interaction.user.username,
          guildId: interaction.guildId,
          channelId: interaction.channelId,
          movieText: movie,
          quoteText: quote,
          acquisitionKind: "radarr",
          acquisitionExternalId: existing.id,
          acquisitionStatus: status,
          acquisitionMetadata: JSON.stringify({
            tmdbId: pick.candidate.tmdbId,
            title: pick.candidate.title,
            year: pick.candidate.year,
            alreadyInRadarr: true,
            hasFile: existing.hasFile,
          }),
        });
        logQuoteRequestEvent("created.already_in_radarr", row.id, interaction, {
          radarrMovieId: existing.id,
          tmdbId: pick.candidate.tmdbId,
          hasFile: existing.hasFile,
        });
        const heading = `**${pick.candidate.title}${pick.candidate.year ? ` (${pick.candidate.year})` : ""}** is already in Radarr`;
        const tail = existing.hasFile
          ? "and Radarr has a file already - I'll re-scan Jellyfin and ping you when the quote becomes searchable."
          : "and Radarr is still hunting for a release - I'll ping you when the file lands and the quote becomes searchable.";
        await interaction.editReply(`${heading} ${tail}${altsLine}`);
        return;
      }
      throw error;
    }

    const row = store.insert({
      requesterDiscordId: interaction.user.id,
      requesterName: interaction.user.displayName || interaction.user.username,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      movieText: movie,
      quoteText: quote,
      acquisitionKind: "radarr",
      acquisitionExternalId: movieRow.id,
      acquisitionStatus: "searching",
      acquisitionMetadata: JSON.stringify({
        tmdbId: pick.candidate.tmdbId,
        title: pick.candidate.title,
        year: pick.candidate.year,
        rootFolderPath: defaults.rootFolderPath,
        qualityProfileId: defaults.qualityProfileId,
      }),
    });

    logQuoteRequestEvent("created.radarr_added", row.id, interaction, {
      radarrMovieId: movieRow.id,
      tmdbId: pick.candidate.tmdbId,
    });

    await interaction.editReply(
      `Got it. I asked Radarr to fetch **${pick.candidate.title}${pick.candidate.year ? ` (${pick.candidate.year})` : ""}** - I'll ping you in this channel once it lands and the line "_${truncate(quote, 120)}_" shows up in the index.${altsLine}`,
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "quote_request.modal_error",
        userId: interaction.user.id,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    await interaction
      .editReply(formatModalErrorReply(error))
      .catch(() => undefined);
  } finally {
    store.close();
  }
}

export function formatModalErrorReply(error: unknown): string {
  if (error instanceof RadarrApiError) {
    if ([408, 502, 503, 504].includes(error.status)) {
      const upstream = extractRadarrUpstreamMessage(error.message);
      const suffix = upstream ? ` (${truncate(upstream, 160)})` : "";
      return `Radarr's metadata source is temporarily unavailable${suffix}. Try again in a few minutes.`;
    }
    if (error.status === 401 || error.status === 403) {
      return "Radarr auth is misconfigured. The maintainer needs to look at this.";
    }
    if (error.status === 400) {
      const upstream = extractRadarrUpstreamMessage(error.message);
      return upstream
        ? `Radarr refused this request: ${truncate(upstream, 200)}`
        : "Radarr refused this request - check the title and try again.";
    }
    if (error.status >= 500) {
      return "Radarr returned an error. Try again in a few minutes.";
    }
  }
  return "Something went wrong submitting that request - try again in a minute.";
}

/**
 * Radarr's error body is JSON like
 *   `[{"propertyName":...,"errorMessage":"..."}]` for 400s, or
 *   `{"message":"...","description":"..."}` for SkyHook 5xx pass-through.
 * Pull the human-readable bit out of the raw error.message captured by
 * RadarrApiError so we can show it to the user instead of "5xx".
 */
function extractRadarrUpstreamMessage(raw: string): string | null {
  const colonIndex = raw.indexOf(": ");
  const tail = colonIndex >= 0 ? raw.slice(colonIndex + 2) : raw;
  try {
    const parsed = JSON.parse(tail);
    if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0]?.errorMessage === "string") {
      return parsed[0].errorMessage;
    }
    if (parsed && typeof parsed === "object" && typeof (parsed as { message?: unknown }).message === "string") {
      return (parsed as { message: string }).message;
    }
  } catch {
    // Body wasn't JSON; fall through.
  }
  return null;
}

function formatRefusal(refusal: AcquisitionRefusal): string {
  switch (refusal.kind) {
    case "no_candidates":
      return "Radarr returned no candidates for that title.";
    case "no_quality_profile":
      return `Radarr has no quality profile available. Configure RADARR_QUALITY_PROFILE_ID. Available: ${refusal.available.join(", ") || "none"}.`;
    case "no_root_folder":
      return `Radarr has no root folder matching the configured override "${refusal.tried}".`;
    case "low_disk_space":
      return `Radarr can't take this request right now - only ${refusal.freeGb} GB free at \`${refusal.rootPath}\` (need at least ${refusal.minGb} GB). Free up space or raise RADARR_MIN_FREE_GB.`;
  }
}

function logQuoteRequestEvent(
  event: string,
  requestId: number,
  interaction: ModalSubmitInteraction,
  extra: Record<string, unknown> = {},
): void {
  console.info(
    JSON.stringify({
      event: `quote_request.${event}`,
      requestId,
      userId: interaction.user.id,
      guildId: interaction.guildId,
      channelId: interaction.channelId,
      ...extra,
    }),
  );
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * Radarr returns 400 with errorCode "MovieExistsValidator" when adding a movie
 * that's already in the library. The exact prose can be "already been added" or
 * "already exists" depending on version, so match on the canonical error code
 * with a prose fallback.
 */
function isMovieAlreadyAddedError(error: unknown): boolean {
  if (!(error instanceof RadarrApiError) || error.status !== 400) return false;
  return /MovieExistsValidator|already (been added|exists)/i.test(error.message);
}

// ===== TV / Sonarr path (issue #116 V1) =====

async function handleTvQuoteRequest(
  interaction: ModalSubmitInteraction,
  config: QuoteRequestModalConfig,
): Promise<void> {
  if (!interaction.guildId || !interaction.channelId) {
    await interaction.reply({
      content: "Use the quote request flow inside a server channel.",
      flags: MessageFlags.Ephemeral,
    });
    return;
  }

  const parsed = parseQuoteRequestTvModal(interaction);
  const validationError = validateTvFields(parsed);
  if (validationError) {
    await interaction.reply({ content: validationError, flags: MessageFlags.Ephemeral });
    return;
  }

  await interaction.deferReply({ flags: MessageFlags.Ephemeral });

  const store = new QuoteRequestStore(config.botStateDbPath);
  try {
    const pending = store
      .listPending()
      .filter((r) => r.requesterDiscordId === interaction.user.id);
    if (pending.length >= MAX_PENDING_PER_USER) {
      await interaction.editReply(
        `You already have ${pending.length} pending quote requests (max ${MAX_PENDING_PER_USER}). Wait for a few to land.`,
      );
      return;
    }

    const sonarrEnabled = Boolean(config.sonarrUrl && config.sonarrApiKey);
    if (!sonarrEnabled) {
      const row = store.insert({
        requesterDiscordId: interaction.user.id,
        requesterName: interaction.user.displayName || interaction.user.username,
        guildId: interaction.guildId!,
        channelId: interaction.channelId!,
        movieText: parsed.show,
        quoteText: parsed.quote,
      });
      logQuoteRequestEvent("created.no_sonarr", row.id, interaction, {
        season: parsed.season,
        episode: parsed.episode,
      });
      await interaction.editReply(
        `Saved as a watch request. Sonarr isn't configured on this bot, so it can't fetch missing TV episodes - I'll only ping you if **${truncate(parsed.show, 80)} S${pad2(parsed.season!)}E${pad2(parsed.episode!)}** is already in the library and the quote shows up after a re-index.`,
      );
      return;
    }

    const client = new SonarrClient(config.sonarrUrl!, config.sonarrApiKey!);

    const excludedKeywords = config.sonarrExcludedRootKeywords ?? [];
    const excludedMatcher = excludedKeywords.length > 0
      ? (path: string) => excludedKeywords.some((kw) => path.toLowerCase().includes(kw.toLowerCase()))
      : undefined;

    const defaults = await resolveSonarrDefaults(
      client,
      {
        qualityProfileId: config.sonarrQualityProfileId,
        rootFolderPath: config.sonarrRootFolderPath,
      },
      { excludedRootMatcher: excludedMatcher },
    );
    if ("kind" in defaults) {
      await interaction.editReply(formatSonarrRefusal(defaults));
      return;
    }
    if (config.sonarrLanguageProfileId !== undefined) {
      defaults.languageProfileId = config.sonarrLanguageProfileId;
    }

    const refusal = checkSonarrDiskSpace(defaults, config.sonarrMinFreeGb);
    if (refusal) {
      await interaction.editReply(formatSonarrRefusal(refusal));
      return;
    }

    const lookupResults = await client.lookup(parsed.show);
    const pick = pickBestSeries(lookupResults, { showText: parsed.show });
    if ("kind" in pick) {
      await interaction.editReply(
        `No TV show matches **${truncate(parsed.show, 80)}** in Sonarr's metadata sources. Try a more specific title (and a year if you know it).`,
      );
      return;
    }

    let result;
    try {
      result = await acquireEpisode({
        client,
        candidate: pick.candidate,
        defaults,
        seasonNumber: parsed.season!,
        episodeNumber: parsed.episode!,
      });
    } catch (error) {
      if (
        error instanceof SonarrApiError &&
        error.status === 400 &&
        /seriesexistsvalidator|already (been added|exists|added)/i.test(error.message)
      ) {
        // Race: someone added the series between findSeriesByTvdbId and addSeriesUnmonitored.
        // Re-fetch and try the episode-only path.
        const existing = await client.findSeriesByTvdbId(pick.candidate.tvdbId);
        if (!existing) throw error;
        const episode = await client.findEpisode(
          existing.id,
          parsed.season!,
          parsed.episode!,
        );
        if (!episode) {
          await interaction.editReply(
            `Sonarr already has **${pick.candidate.title}**, but I can't find S${pad2(parsed.season!)}E${pad2(parsed.episode!)} in its episode list. Double-check the season/episode numbers.`,
          );
          return;
        }
        if (!episode.monitored) {
          await client.setEpisodeMonitored(episode.id, true);
        }
        if (!episode.hasFile) {
          await client.episodeSearch([episode.id]);
        }
        result = { series: existing, episode, alreadyAdded: true };
      } else {
        throw error;
      }
    }

    const altsLine = pick.alternatives.length
      ? `\nOther matches: ${pick.alternatives
          .map((alt) => `${alt.title}${alt.year ? ` (${alt.year})` : ""}`)
          .join(", ")}`
      : "";

    const acquisitionStatus = result.episode.hasFile ? "imported" : "searching";
    const row = store.insert({
      requesterDiscordId: interaction.user.id,
      requesterName: interaction.user.displayName || interaction.user.username,
      guildId: interaction.guildId!,
      channelId: interaction.channelId!,
      movieText: parsed.show,
      quoteText: parsed.quote,
      acquisitionKind: "sonarr",
      acquisitionExternalId: result.episode.id,
      acquisitionStatus,
      acquisitionMetadata: JSON.stringify({
        tvdbId: pick.candidate.tvdbId,
        seriesId: result.series.id,
        seriesTitle: result.series.title || pick.candidate.title,
        seasonNumber: parsed.season,
        episodeNumber: parsed.episode,
        alreadyAdded: result.alreadyAdded,
        rootFolderPath: defaults.rootFolderPath,
        qualityProfileId: defaults.qualityProfileId,
      }),
    });

    logQuoteRequestEvent(
      result.alreadyAdded ? "created.sonarr_existing_series" : "created.sonarr_added_series",
      row.id,
      interaction,
      {
        sonarrSeriesId: result.series.id,
        sonarrEpisodeId: result.episode.id,
        season: parsed.season,
        episode: parsed.episode,
        episodeAlreadyOnDisk: result.episode.hasFile,
      },
    );

    const epLabel = `S${pad2(parsed.season!)}E${pad2(parsed.episode!)}`;
    const seriesTitle = pick.candidate.title;
    const heading = result.alreadyAdded
      ? `**${seriesTitle}** is already in Sonarr`
      : `Got it. I added **${seriesTitle}** to Sonarr (unmonitored at the show level)`;
    const tail = result.episode.hasFile
      ? `and Sonarr has ${epLabel} on disk already - I'll re-scan Jellyfin and post the clip when "_${truncate(parsed.quote, 120)}_" shows up in the index.`
      : `and asked Sonarr to grab ${epLabel}. I'll post the clip in this channel once it lands and the line "_${truncate(parsed.quote, 120)}_" shows up in the index.`;
    await interaction.editReply(`${heading} ${tail}${altsLine}`);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "quote_request.modal_error",
        userId: interaction.user.id,
        modal: "tv",
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    await interaction.editReply(formatTvModalErrorReply(error)).catch(() => undefined);
  } finally {
    store.close();
  }
}

function validateTvFields(parsed: ReturnType<typeof parseQuoteRequestTvModal>): string | null {
  if (!parsed.show) return "Show name is required.";
  if (!parsed.quote) return "Quote text is required.";
  if (parsed.season === undefined || parsed.episode === undefined) {
    const offenders: string[] = [];
    if (parsed.season === undefined) {
      offenders.push(`Season \`${parsed.rawSeason || "(empty)"}\``);
    }
    if (parsed.episode === undefined) {
      offenders.push(`Episode \`${parsed.rawEpisode || "(empty)"}\``);
    }
    return `We need both Season and Episode as numbers (${offenders.join(" / ")} didn't parse). The episode-only path is on the roadmap.`;
  }
  return null;
}

export function formatTvModalErrorReply(error: unknown): string {
  if (error instanceof SonarrApiError) {
    if ([408, 502, 503, 504].includes(error.status)) {
      return "Sonarr's metadata source is temporarily unavailable. Try again in a few minutes.";
    }
    if (error.status === 401 || error.status === 403) {
      return "Sonarr auth is misconfigured. The maintainer needs to look at this.";
    }
    if (error.status === 400) {
      const upstream = extractRadarrUpstreamMessage(error.message);
      return upstream
        ? `Sonarr refused this request: ${truncate(upstream, 200)}`
        : "Sonarr refused this request - check the show name, season, and episode and try again.";
    }
    if (error.status >= 500) {
      return "Sonarr returned an error. Try again in a few minutes.";
    }
  }
  return "Something went wrong submitting that TV request - try again in a minute.";
}

function formatSonarrRefusal(refusal: SonarrAcquisitionRefusal): string {
  switch (refusal.kind) {
    case "no_candidates":
      return "Sonarr returned no candidates for that show.";
    case "no_quality_profile":
      return `Sonarr has no quality profile available. Configure SONARR_QUALITY_PROFILE_ID. Available: ${refusal.available.join(", ") || "none"}.`;
    case "no_root_folder":
      return `Sonarr has no root folder matching the configured override "${refusal.tried}".`;
    case "low_disk_space":
      return `Sonarr can't take this request right now - only ${refusal.freeGb} GB free at \`${refusal.rootPath}\` (need at least ${refusal.minGb} GB). Free up space or raise SONARR_MIN_FREE_GB.`;
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
