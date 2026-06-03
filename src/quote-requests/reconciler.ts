import type { Client, Message, TextChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import { displayTitleWithYear } from "../display-title.ts";
import { formatEpisodeLabel, type JellyfinClient } from "../jellyfin.ts";
import { RadarrApiError, RadarrClient } from "../radarr/client.ts";
import {
  acquireEpisode,
  checkSonarrDiskSpace,
  pickBestSeries,
  resolveSonarrDefaults,
  type ExcludedRootMatcher,
} from "../sonarr/acquire.ts";
import { SonarrApiError, SonarrClient } from "../sonarr/client.ts";
import { encodeQuoteMatchToken } from "../subtitles/match-token.ts";
import { openSubtitleIndex, type SubtitleIndex } from "../subtitles/index-db.ts";
import { formatTimestamp } from "../time.ts";
import { findQuoteRequestMatch, type QuoteRequestMatch } from "./matcher.ts";
import {
  renderAndPostFulfillmentClip,
  type RenderAndPostConfig,
} from "./render-and-post.ts";
import { QuoteRequestStore, type QuoteRequestRow } from "./store.ts";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export type QuoteRequestReconcilerDeps = {
  client: Pick<Client, "channels">;
  config: Pick<
    AppConfig,
    | "botStateDbPath"
    | "subtitleDbPath"
    | "radarrUrl"
    | "radarrApiKey"
    | "sonarrUrl"
    | "sonarrApiKey"
    | "sonarrQualityProfileId"
    | "sonarrLanguageProfileId"
    | "sonarrRootFolderPath"
    | "sonarrMinFreeGb"
    | "sonarrExcludedRootKeywords"
  > &
    Partial<RenderAndPostConfig>;
  /**
   * Full Jellyfin client when available - the render-and-post fulfillment path
   * uses it for streaming and metadata. The Radarr poll path only needs a
   * narrower slice (findItemByTmdbId / triggerLibraryRefresh), which the full
   * type also satisfies.
   */
  jellyfin?: JellyfinClient;
};

export function startQuoteRequestReconcileLoop(
  deps: QuoteRequestReconcilerDeps,
  intervalMs: number = DEFAULT_INTERVAL_MS,
): () => void {
  const tick = () => {
    void runQuoteRequestReconcile(deps).catch((error) => {
      console.error(
        JSON.stringify({
          event: "quotewish.reconcile.error",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    });
  };

  const timer = setInterval(tick, intervalMs);
  // First tick deferred to give startup indexing a head start.
  setTimeout(tick, Math.min(intervalMs, 60_000));

  return () => clearInterval(timer);
}

export async function runQuoteRequestReconcile(deps: QuoteRequestReconcilerDeps): Promise<void> {
  const store = new QuoteRequestStore(deps.config.botStateDbPath);
  let index: SubtitleIndex | null = null;

  try {
    await replayDeferredAcquisitions(deps, store);
    await pollRadarrAcquisitions(deps, store);
    await pollSonarrAcquisitions(deps, store);

    const pending = store.listPending();
    if (pending.length === 0) {
      return;
    }

    try {
      index = openSubtitleIndex(deps.config.subtitleDbPath, { readonly: true });
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "quotewish.reconcile.skip",
          reason: "subtitle_index_unavailable",
          pending: pending.length,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
      return;
    }

    let fulfilled = 0;
    for (const request of pending) {
      const match = findQuoteRequestMatch(index, request.movieText, request.quoteText);
      if (!match || match.confidence === "none") {
        continue;
      }

      const fulfillment = await fulfillRequest(deps, request, match);
      const matchToken = encodeQuoteMatchToken({
        itemId: match.candidate.itemId,
        startMs: match.candidate.startMs,
        endMs: match.candidate.endMs,
      });

      store.markFulfilled({
        id: request.id,
        itemId: match.candidate.itemId,
        matchToken,
        notificationMessageId: fulfillment.messageId,
      });
      fulfilled += 1;

      console.info(
        JSON.stringify({
          event: "quote_request.fulfilled",
          requestId: request.id,
          itemId: match.candidate.itemId,
          confidence: match.confidence,
          titleScore: Math.round(match.titleScore * 100) / 100,
          messageId: fulfillment.messageId,
          mode: fulfillment.mode,
        }),
      );
    }

    if (pending.length > 0) {
      console.info(
        JSON.stringify({
          event: "quotewish.reconcile.tick",
          pending: pending.length,
          fulfilled,
        }),
      );
    }
  } finally {
    index?.close();
    store.close();
  }
}

async function fulfillRequest(
  deps: QuoteRequestReconcilerDeps,
  request: QuoteRequestRow,
  match: QuoteRequestMatch,
): Promise<{ messageId: string | null; mode: "clip" | "text" | "skipped" }> {
  const renderConfig = pickRenderConfig(deps.config);
  if (deps.jellyfin && renderConfig) {
    try {
      const result = await renderAndPostFulfillmentClip({
        client: deps.client,
        jellyfin: deps.jellyfin,
        config: renderConfig,
        request,
        match,
      });
      if (result.posted) {
        return { messageId: result.messageId, mode: "clip" };
      }
      console.warn(
        JSON.stringify({
          event: "quote_request.fulfill.render_fallback",
          requestId: request.id,
          reason: result.reason,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "quote_request.fulfill.render_error",
          requestId: request.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }

  const messageId = await postFulfillmentNotification(deps.client, request, match);
  return { messageId, mode: messageId ? "text" : "skipped" };
}

function pickRenderConfig(
  config: QuoteRequestReconcilerDeps["config"],
): RenderAndPostConfig | null {
  const required = [
    config.clipTempDir,
    config.maxClipMb,
    config.maxClipSeconds,
    config.audioLanguages,
    config.subtitleLanguages,
    config.subtitleDefaultClipSeconds,
    config.subtitleQuotePaddingSeconds,
    config.subtitleDbPath,
  ];
  if (required.some((value) => value === undefined || value === null)) return null;
  return {
    clipTempDir: config.clipTempDir as string,
    maxClipMb: config.maxClipMb as number,
    maxClipSeconds: config.maxClipSeconds as number,
    audioLanguages: config.audioLanguages as string,
    subtitleLanguages: config.subtitleLanguages as string,
    subtitleDefaultClipSeconds: config.subtitleDefaultClipSeconds as number,
    subtitleQuotePaddingSeconds: config.subtitleQuotePaddingSeconds as number,
    subtitleDbPath: config.subtitleDbPath as string,
  };
}

async function postFulfillmentNotification(
  client: Pick<Client, "channels">,
  request: QuoteRequestRow,
  match: QuoteRequestMatch,
): Promise<string | null> {
  const channel = await client.channels.fetch(request.channelId).catch(() => null);
  if (!channel || !channel.isTextBased() || channel.isDMBased()) {
    console.warn(
      JSON.stringify({
        event: "quotewish.notify_skip",
        reason: "channel_unavailable",
        channelId: request.channelId,
        requestId: request.id,
      }),
    );
    return null;
  }

  const content = formatFulfillmentMessage(request, match);
  try {
    const message: Message = await (channel as TextChannel).send({
      content: content.slice(0, 2000),
      allowedMentions: { users: [request.requesterDiscordId] },
    });
    return message.id;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "quotewish.notify_error",
        requestId: request.id,
        channelId: request.channelId,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return null;
  }
}

export function formatFulfillmentMessage(
  request: QuoteRequestRow,
  match: QuoteRequestMatch,
): string {
  const { candidate } = match;
  const title = displayMatchTitle(match);
  const timestamp = formatTimestamp(candidate.startMs / 1000);
  const cue = candidate.text.replace(/\s+/g, " ").trim();
  const matchToken = encodeQuoteMatchToken({
    itemId: candidate.itemId,
    startMs: candidate.startMs,
    endMs: candidate.endMs,
  });

  const confidenceNote =
    match.confidence === "high"
      ? "I'm pretty sure this is the one."
      : "Best guess - might not be exactly the line you wanted.";

  return [
    `<@${request.requesterDiscordId}> your wish is granted.`,
    "",
    `**${title}** @ ${timestamp}`,
    `> ${truncate(cue, 240)}`,
    "",
    `${confidenceNote} Clip it with \`/quote match:\` and pick this line, or paste the token below.`,
    "```",
    matchToken,
    "```",
  ].join("\n");
}

function displayMatchTitle(match: QuoteRequestMatch): string {
  const candidate = match.candidate;
  if (candidate.itemType === "Episode" && candidate.seriesName) {
    const episode = formatEpisodeLabel({
      name: candidate.title,
      type: candidate.itemType,
      seasonNumber: candidate.seasonNumber,
      episodeNumber: candidate.episodeNumber,
    });
    return `${candidate.seriesName} - ${episode}`;
  }
  if (candidate.productionYear) {
    return displayTitleWithYear({
      name: candidate.title,
      type: candidate.itemType,
      productionYear: candidate.productionYear,
    });
  }
  return candidate.title;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

async function pollRadarrAcquisitions(
  deps: QuoteRequestReconcilerDeps,
  store: QuoteRequestStore,
): Promise<void> {
  if (!deps.config.radarrUrl || !deps.config.radarrApiKey) {
    return;
  }

  const acquiring = store.listAcquiring();
  if (acquiring.length === 0) {
    return;
  }

  const radarrRows = acquiring.filter(
    (row) => row.acquisitionKind === "radarr" && row.acquisitionExternalId !== null,
  );
  if (radarrRows.length === 0) {
    return;
  }

  const client = new RadarrClient(deps.config.radarrUrl, deps.config.radarrApiKey);
  let needsLibraryRefresh = false;

  for (const row of radarrRows) {
    if (row.acquisitionExternalId === null) continue;
    try {
      const movie = await client.getMovie(row.acquisitionExternalId);
      const previous = row.acquisitionStatus;

      if (movie.hasFile) {
        if (previous !== "imported" && previous !== "indexed") {
          store.setAcquisitionStatus({
            id: row.id,
            status: "imported",
            metadata: JSON.stringify({
              ...safeJson(row.acquisitionMetadata),
              radarrMovieFilePath: movie.movieFile?.path,
              radarrSizeOnDisk: movie.sizeOnDisk,
              importedAt: new Date().toISOString(),
            }),
          });
          needsLibraryRefresh = true;
          console.info(
            JSON.stringify({
              event: "quote_request.radarr.imported",
              requestId: row.id,
              radarrMovieId: movie.id,
              tmdbId: movie.tmdbId,
              path: movie.movieFile?.path,
            }),
          );
        }

        // Try to find the item in Jellyfin by tmdbId; once present, mark indexed
        // so the FTS-match pass picks it up on this or a future tick.
        if (deps.jellyfin && previous !== "indexed") {
          try {
            const jellyfinItem = await deps.jellyfin.findItemByTmdbId(movie.tmdbId, {
              title: movie.title,
            });
            if (jellyfinItem) {
              store.setAcquisitionStatus({ id: row.id, status: "indexed" });
              console.info(
                JSON.stringify({
                  event: "quote_request.radarr.in_jellyfin",
                  requestId: row.id,
                  jellyfinItemId: jellyfinItem.id,
                  tmdbId: movie.tmdbId,
                }),
              );
            }
          } catch (error) {
            console.warn(
              JSON.stringify({
                event: "quote_request.jellyfin_lookup_error",
                requestId: row.id,
                tmdbId: movie.tmdbId,
                error: error instanceof Error ? error.message : "unknown error",
              }),
            );
          }
        }
      } else if (previous === "searching" && movie.monitored) {
        // Radarr has the movie metadata and is searching for releases - no state change yet,
        // just record progress hint in metadata. Skipped for v1 to keep noise down.
      }
    } catch (error) {
      const status = error instanceof RadarrApiError ? error.status : undefined;
      if (status === 404) {
        store.setAcquisitionStatus({
          id: row.id,
          status: "failed",
          metadata: JSON.stringify({
            ...safeJson(row.acquisitionMetadata),
            failureReason: "radarr_404",
            failedAt: new Date().toISOString(),
          }),
        });
        console.warn(
          JSON.stringify({
            event: "quote_request.radarr.gone",
            requestId: row.id,
            radarrMovieId: row.acquisitionExternalId,
          }),
        );
        continue;
      }
      console.error(
        JSON.stringify({
          event: "quote_request.radarr.poll_error",
          requestId: row.id,
          radarrMovieId: row.acquisitionExternalId,
          status,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }

  if (needsLibraryRefresh && deps.jellyfin) {
    try {
      await deps.jellyfin.triggerLibraryRefresh();
      console.info(
        JSON.stringify({ event: "quote_request.jellyfin.refresh_triggered" }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "quote_request.jellyfin.refresh_failed",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
}

function safeJson(raw: string | null): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

async function pollSonarrAcquisitions(
  deps: QuoteRequestReconcilerDeps,
  store: QuoteRequestStore,
): Promise<void> {
  if (!deps.config.sonarrUrl || !deps.config.sonarrApiKey) {
    return;
  }

  const acquiring = store.listAcquiring();
  if (acquiring.length === 0) {
    return;
  }

  const sonarrRows = acquiring.filter(
    (row) => row.acquisitionKind === "sonarr" && row.acquisitionExternalId !== null,
  );
  if (sonarrRows.length === 0) {
    return;
  }

  const client = new SonarrClient(deps.config.sonarrUrl, deps.config.sonarrApiKey);
  let needsLibraryRefresh = false;

  for (const row of sonarrRows) {
    if (row.acquisitionExternalId === null) continue;
    try {
      const episode = await client.getEpisode(row.acquisitionExternalId);
      const previous = row.acquisitionStatus;

      if (episode.hasFile) {
        if (previous !== "imported" && previous !== "indexed") {
          store.setAcquisitionStatus({
            id: row.id,
            status: "imported",
            metadata: JSON.stringify({
              ...safeJson(row.acquisitionMetadata),
              sonarrEpisodeFileId: episode.episodeFileId,
              importedAt: new Date().toISOString(),
            }),
          });
          needsLibraryRefresh = true;
          console.info(
            JSON.stringify({
              event: "quote_request.sonarr.imported",
              requestId: row.id,
              sonarrEpisodeId: episode.id,
              seasonNumber: episode.seasonNumber,
              episodeNumber: episode.episodeNumber,
            }),
          );
        }

        // Once Jellyfin has sucked it up, the next reconciler tick can run an FTS
        // match against the bot's subtitle index and post the clip. We don't have
        // a TMDB-tvdb mapping handy, so just mark `indexed` after a successful
        // import + library refresh; the FTS pass is the actual gate.
        if (previous !== "indexed") {
          store.setAcquisitionStatus({ id: row.id, status: "indexed" });
        }
      }
    } catch (error) {
      const status = error instanceof SonarrApiError ? error.status : undefined;
      if (status === 404) {
        store.setAcquisitionStatus({
          id: row.id,
          status: "failed",
          metadata: JSON.stringify({
            ...safeJson(row.acquisitionMetadata),
            failureReason: "sonarr_episode_404",
            failedAt: new Date().toISOString(),
          }),
        });
        console.warn(
          JSON.stringify({
            event: "quote_request.sonarr.gone",
            requestId: row.id,
            sonarrEpisodeId: row.acquisitionExternalId,
          }),
        );
        continue;
      }
      console.error(
        JSON.stringify({
          event: "quote_request.sonarr.poll_error",
          requestId: row.id,
          sonarrEpisodeId: row.acquisitionExternalId,
          status,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }

  if (needsLibraryRefresh && deps.jellyfin) {
    try {
      await deps.jellyfin.triggerLibraryRefresh();
      console.info(
        JSON.stringify({ event: "quote_request.jellyfin.refresh_triggered_sonarr" }),
      );
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "quote_request.jellyfin.refresh_failed_sonarr",
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
}

/**
 * Replays acquisition rows that were submitted while their integration was
 * offline (`acquisition_kind` set, `acquisition_external_id IS NULL`,
 * `acquisition_status='not_requested'`) once the integration is configured.
 *
 * Currently only Sonarr is replayed; Radarr's no-config path always rejected
 * the modal upfront so it never persists deferred rows.
 */
async function replayDeferredAcquisitions(
  deps: QuoteRequestReconcilerDeps,
  store: QuoteRequestStore,
): Promise<void> {
  if (!deps.config.sonarrUrl || !deps.config.sonarrApiKey) {
    return;
  }

  const deferred = store.listDeferredAcquisitions();
  const sonarrDeferred = deferred.filter((row) => row.acquisitionKind === "sonarr");
  if (sonarrDeferred.length === 0) {
    return;
  }

  const client = new SonarrClient(deps.config.sonarrUrl, deps.config.sonarrApiKey);

  const excludedKeywords = deps.config.sonarrExcludedRootKeywords ?? [];
  const excludedMatcher: ExcludedRootMatcher | undefined =
    excludedKeywords.length > 0
      ? (path) => excludedKeywords.some((kw) => path.toLowerCase().includes(kw.toLowerCase()))
      : undefined;

  let defaults: Awaited<ReturnType<typeof resolveSonarrDefaults>> | null = null;
  try {
    defaults = await resolveSonarrDefaults(
      client,
      {
        qualityProfileId: deps.config.sonarrQualityProfileId,
        rootFolderPath: deps.config.sonarrRootFolderPath,
      },
      { excludedRootMatcher: excludedMatcher },
    );
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "quote_request.sonarr.replay_defaults_failed",
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return;
  }

  if ("kind" in defaults) {
    console.warn(
      JSON.stringify({
        event: "quote_request.sonarr.replay_skipped_no_defaults",
        refusal: defaults.kind,
      }),
    );
    return;
  }
  if (deps.config.sonarrLanguageProfileId !== undefined) {
    defaults.languageProfileId = deps.config.sonarrLanguageProfileId;
  }

  const diskRefusal = checkSonarrDiskSpace(defaults, deps.config.sonarrMinFreeGb);
  if (diskRefusal) {
    console.warn(
      JSON.stringify({
        event: "quote_request.sonarr.replay_skipped_disk",
        refusal: diskRefusal.kind,
      }),
    );
    return;
  }

  for (const row of sonarrDeferred) {
    const meta = safeJson(row.acquisitionMetadata);
    const seasonRaw = (meta as { season?: unknown }).season;
    const episodeRaw = (meta as { episode?: unknown }).episode;
    const season = typeof seasonRaw === "number" ? seasonRaw : Number(seasonRaw);
    const episode = typeof episodeRaw === "number" ? episodeRaw : Number(episodeRaw);
    if (!Number.isInteger(season) || !Number.isInteger(episode) || season <= 0 || episode <= 0) {
      console.warn(
        JSON.stringify({
          event: "quote_request.sonarr.replay_unparseable_meta",
          requestId: row.id,
        }),
      );
      continue;
    }

    try {
      const lookup = await client.lookup(row.movieText);
      const pick = pickBestSeries(lookup, { showText: row.movieText });
      if ("kind" in pick) {
        console.warn(
          JSON.stringify({
            event: "quote_request.sonarr.replay_no_match",
            requestId: row.id,
            show: row.movieText,
          }),
        );
        continue;
      }

      let result;
      try {
        result = await acquireEpisode({
          client,
          candidate: pick.candidate,
          defaults,
          seasonNumber: season,
          episodeNumber: episode,
        });
      } catch (error) {
        if (
          error instanceof SonarrApiError &&
          error.status === 400 &&
          /seriesexistsvalidator|already (been added|exists|added)/i.test(error.message)
        ) {
          const existing = await client.findSeriesByTvdbId(pick.candidate.tvdbId);
          if (!existing) throw error;
          const ep = await client.findEpisode(existing.id, season, episode);
          if (!ep) {
            console.warn(
              JSON.stringify({
                event: "quote_request.sonarr.replay_episode_missing",
                requestId: row.id,
                seriesId: existing.id,
                season,
                episode,
              }),
            );
            continue;
          }
          if (!ep.monitored) await client.setEpisodeMonitored(ep.id, true);
          if (!ep.hasFile) await client.episodeSearch([ep.id]);
          result = { series: existing, episode: ep, alreadyAdded: true };
        } else {
          throw error;
        }
      }

      store.setAcquisitionStatus({
        id: row.id,
        externalId: result.episode.id,
        status: result.episode.hasFile ? "imported" : "searching",
        metadata: JSON.stringify({
          ...(meta as Record<string, unknown>),
          tvdbId: pick.candidate.tvdbId,
          seriesId: result.series.id,
          season,
          episode,
          replayedAt: new Date().toISOString(),
        }),
      });
      console.info(
        JSON.stringify({
          event: "quote_request.sonarr.replayed",
          requestId: row.id,
          show: pick.candidate.title,
          season,
          episode,
          alreadyAdded: result.alreadyAdded,
        }),
      );
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "quote_request.sonarr.replay_error",
          requestId: row.id,
          error: error instanceof Error ? error.message : "unknown error",
        }),
      );
    }
  }
}
