import type { Client, Message, TextChannel } from "discord.js";
import type { AppConfig } from "../config.ts";
import { displayTitleWithYear } from "../display-title.ts";
import { formatEpisodeLabel } from "../jellyfin.ts";
import { encodeQuoteMatchToken } from "../subtitles/match-token.ts";
import { openSubtitleIndex, type SubtitleIndex } from "../subtitles/index-db.ts";
import { formatTimestamp } from "../time.ts";
import { findQuoteRequestMatch, type QuoteRequestMatch } from "./matcher.ts";
import { QuoteRequestStore, type QuoteRequestRow } from "./store.ts";

const DEFAULT_INTERVAL_MS = 5 * 60_000;

export type QuoteRequestReconcilerDeps = {
  client: Pick<Client, "channels">;
  config: Pick<AppConfig, "botStateDbPath" | "subtitleDbPath">;
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

      const messageId = await postFulfillmentNotification(deps.client, request, match);
      const matchToken = encodeQuoteMatchToken({
        itemId: match.candidate.itemId,
        startMs: match.candidate.startMs,
        endMs: match.candidate.endMs,
      });

      store.markFulfilled({
        id: request.id,
        itemId: match.candidate.itemId,
        matchToken,
        notificationMessageId: messageId,
      });
      fulfilled += 1;

      console.info(
        JSON.stringify({
          event: "quotewish.fulfilled",
          requestId: request.id,
          itemId: match.candidate.itemId,
          confidence: match.confidence,
          titleScore: Math.round(match.titleScore * 100) / 100,
          messageId,
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
