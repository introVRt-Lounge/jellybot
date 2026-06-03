import type { JellyfinClient, JellyfinItem } from "../jellyfin.ts";
import type { SubtitleIndex } from "../subtitles/index-db.ts";
import { getSubtitleSearchIndex } from "../subtitles/search-index.ts";

/**
 * Open the readonly subtitle search index for resolver use without
 * crashing the clip pipeline if the DB file is missing or locked. Returns
 * null on failure so the caller falls through to the original
 * "no longer exists" path instead of bubbling an unhandled error.
 */
export function openSubtitleIndexForResolver(dbPath: string): SubtitleIndex | null {
  try {
    return getSubtitleSearchIndex(dbPath);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "clip.subtitle_index_open_failed",
        dbPath,
        error: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return null;
  }
}

/**
 * Resolve a Jellyfin item for the clip pipeline, with a recovery hop for
 * stale ids (issue #118).
 *
 * The flow:
 *
 * 1. Try `jellyfin.getItem(itemId)` directly. If it resolves, return it -
 *    that's the happy path and is the same call validateClipItem already
 *    expected.
 * 2. If it returns `null` (item moved/replaced/reindexed and Jellyfin
 *    reissued a new internal id), look the original id up in our subtitle
 *    index for stable metadata (title + year for movies, series + S/E for
 *    episodes - those don't change when the file is replaced).
 * 3. Re-query Jellyfin for the same content via `findMovieByTitle` or
 *    `findEpisodeBySeriesTitleAndNumbers`. If we get a hit, return it; the
 *    caller's `validateClipItem` will re-check kind/runtime against the new
 *    item.
 *
 * If recovery succeeds we log a `clip.item_recovered` event so the operator
 * can see the stale id pattern and decide whether to force a re-index.
 */
export type ResolveOutcome =
  | { ok: true; item: JellyfinItem; recovered: boolean; previousItemId?: string }
  | { ok: false };

export async function resolveClipItem(deps: {
  jellyfin: JellyfinClient;
  subtitleIndex: SubtitleIndex | null;
  itemId: string;
}): Promise<ResolveOutcome> {
  const direct = await safe(() => deps.jellyfin.getItem(deps.itemId));
  if (direct) {
    return { ok: true, item: direct, recovered: false };
  }

  if (!deps.subtitleIndex) {
    return { ok: false };
  }

  const indexed = deps.subtitleIndex.getMediaItem(deps.itemId);
  if (!indexed) {
    return { ok: false };
  }

  let recovered: JellyfinItem | null = null;

  if (indexed.itemType === "Movie" && indexed.title) {
    recovered = await safe(() =>
      deps.jellyfin.findMovieByTitle(indexed.title, indexed.productionYear),
    );
  } else if (
    indexed.itemType === "Episode" &&
    indexed.seriesName &&
    indexed.seasonNumber != null &&
    indexed.episodeNumber != null
  ) {
    recovered = await safe(() =>
      deps.jellyfin.findEpisodeBySeriesTitleAndNumbers(
        indexed.seriesName!,
        indexed.seasonNumber!,
        indexed.episodeNumber!,
      ),
    );
  }

  if (!recovered) {
    return { ok: false };
  }

  console.info(
    JSON.stringify({
      event: "clip.item_recovered",
      issue: "#118",
      previousItemId: deps.itemId,
      recoveredItemId: recovered.id,
      itemType: indexed.itemType,
      title: indexed.title,
      productionYear: indexed.productionYear,
      seriesName: indexed.seriesName,
      seasonNumber: indexed.seasonNumber,
      episodeNumber: indexed.episodeNumber,
    }),
  );

  return { ok: true, item: recovered, recovered: true, previousItemId: deps.itemId };
}

async function safe<T>(call: () => Promise<T | null>): Promise<T | null> {
  try {
    return await call();
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "clip.resolver.error",
        message: error instanceof Error ? error.message : "unknown error",
      }),
    );
    return null;
  }
}
