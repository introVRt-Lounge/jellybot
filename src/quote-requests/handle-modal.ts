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
import { parseQuoteRequestModal } from "./modal.ts";
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
      .editReply("Something went wrong submitting that request - try again in a minute.")
      .catch(() => undefined);
  } finally {
    store.close();
  }
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
