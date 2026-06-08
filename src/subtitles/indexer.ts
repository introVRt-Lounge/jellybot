import type { JellyfinClient, JellyfinItemWithMedia, SubtitledMediaPage } from "../jellyfin.ts";
import { displayTitle } from "../display-title.ts";
import { parseSubtitleContent } from "./parse.ts";
import { pickSubtitleStream, parsePreferredLanguages } from "./track-select.ts";
import { openSubtitleIndex, type IndexedCue, type IndexedMediaItem, type SubtitleIndex } from "./index-db.ts";

export type IndexSubtitlesOptions = {
  dbPath: string;
  preferredLanguages: string[];
  concurrency: number;
  incremental: boolean;
  pageSize?: number;
  onProgress?: (event: IndexProgressEvent) => void;
};

export type IndexProgressEvent =
  | { type: "start"; totalItems: number; incremental: boolean }
  | { type: "indexed"; itemId: string; cueCount: number }
  | { type: "skipped"; itemId: string; reason: string }
  | { type: "error"; itemId: string; message: string }
  | { type: "done"; summary: IndexSummary };

export type IndexSummary = {
  itemsScanned: number;
  itemsIndexed: number;
  itemsSkipped: number;
  cuesIndexed: number;
  errors: number;
};

export async function indexSubtitles(
  jellyfin: JellyfinClient,
  options: IndexSubtitlesOptions,
): Promise<IndexSummary> {
  const index = openSubtitleIndex(options.dbPath);
  const pageSize = options.pageSize ?? 50;
  const languages = options.preferredLanguages;
  const runId = index.startRun();

  let itemsScanned = 0;
  let itemsIndexed = 0;
  let itemsSkipped = 0;
  let cuesIndexed = 0;
  let errors = 0;

  try {
    const totalItems = await jellyfin.countSubtitledMedia();
    options.onProgress?.({ type: "start", totalItems, incremental: options.incremental });

    for (let startIndex = 0; startIndex < totalItems; startIndex += pageSize) {
      const page = await jellyfin.listSubtitledMedia({ startIndex, limit: pageSize });
      await mapWithConcurrency(page.items, options.concurrency, async (item) => {
        itemsScanned += 1;

        try {
          if (options.incremental) {
            const stored = index.getStoredDateRefreshed(item.id);
            if (stored && stored === item.dateLastRefreshed) {
              itemsSkipped += 1;
              options.onProgress?.({ type: "skipped", itemId: item.id, reason: "unchanged" });
              return;
            }
          }

          const detailed = await jellyfin.getItemWithMedia(item.id);
          if (!detailed) {
            itemsSkipped += 1;
            options.onProgress?.({ type: "skipped", itemId: item.id, reason: "missing" });
            return;
          }

          const cueCount = await indexOneItem(jellyfin, index, detailed, languages);
          if (cueCount === 0) {
            itemsSkipped += 1;
            options.onProgress?.({ type: "skipped", itemId: item.id, reason: "no_cues" });
            return;
          }

          itemsIndexed += 1;
          cuesIndexed += cueCount;
          options.onProgress?.({ type: "indexed", itemId: item.id, cueCount });
        } catch (error) {
          errors += 1;
          const message = error instanceof Error ? error.message : "unknown error";
          options.onProgress?.({ type: "error", itemId: item.id, message });
        }
      });
    }

    const summary = { itemsScanned, itemsIndexed, itemsSkipped, cuesIndexed, errors };
    index.finishRun(runId, { ...summary, status: "completed" });
    options.onProgress?.({ type: "done", summary });
    return summary;
  } catch (error) {
    index.finishRun(runId, {
      itemsScanned,
      itemsIndexed,
      itemsSkipped,
      cuesIndexed,
      errors: errors + 1,
      status: "failed",
    });
    throw error;
  } finally {
    index.close();
  }
}

export type IndexSingleItemResult =
  | { ok: true; itemId: string; cueCount: number }
  | { ok: false; itemId: string; reason: "missing" | "no_cues" | "error"; message?: string };

/**
 * Index just one Jellyfin item. Used by the webhook indexer-kick path so
 * Radarr/Sonarr/Bazarr Connect events can produce a sub-second targeted
 * refresh instead of waiting for the full incremental scan or the 09:00 cron.
 *
 * Opens its own SubtitleIndex handle so callers don't have to manage db
 * lifecycle; that mirrors the design of `indexSubtitles`. Concurrency-safe
 * w.r.t. the bulk indexer because both go through SQLite.
 */
export async function indexJellyfinItem(
  jellyfin: JellyfinClient,
  options: { dbPath: string; itemId: string; preferredLanguages: string[] },
): Promise<IndexSingleItemResult> {
  const index = openSubtitleIndex(options.dbPath);
  try {
    const detailed = await jellyfin.getItemWithMedia(options.itemId);
    if (!detailed) {
      return { ok: false, itemId: options.itemId, reason: "missing" };
    }

    try {
      const cueCount = await indexOneItem(jellyfin, index, detailed, options.preferredLanguages);
      if (cueCount === 0) {
        return { ok: false, itemId: options.itemId, reason: "no_cues" };
      }
      return { ok: true, itemId: options.itemId, cueCount };
    } catch (error) {
      return {
        ok: false,
        itemId: options.itemId,
        reason: "error",
        message: error instanceof Error ? error.message : "unknown error",
      };
    }
  } finally {
    index.close();
  }
}

async function indexOneItem(
  jellyfin: JellyfinClient,
  index: SubtitleIndex,
  item: JellyfinItemWithMedia,
  preferredLanguages: string[],
): Promise<number> {
  const stream = pickSubtitleStream(item.mediaSource.streams, preferredLanguages);
  if (!stream) return 0;

  const raw = await jellyfin.fetchSubtitleText(item.id, item.mediaSource.id, stream.index, stream.codec);
  const singleCues = parseSubtitleContent(raw.content, raw.format).map(
    (cue): IndexedCue => ({
      startMs: Math.round(cue.startSeconds * 1000),
      endMs: Math.round(cue.endSeconds * 1000),
      text: cue.text,
      kind: "single",
    }),
  );

  if (singleCues.length === 0) return 0;

  // Issue #130: also emit a "merged window" row for each adjacent cue pair so
  // dialogue split across two SRT cues (very common - "Harry," / "It's an
  // inanimate fucking object.") matches the FTS query as one document. Renderer
  // uses startMs of cue_n, endMs of cue_{n+1}, which is the natural span the
  // user wanted clipped. The single-cue rows still exist with their tighter
  // spans, so single-cue matches keep their better bm25 ranking and shorter
  // clip durations.
  const mergedCues = buildMergedWindowCues(singleCues);
  const cues: IndexedCue[] = singleCues.concat(mergedCues);

  const indexedItem: IndexedMediaItem = {
    itemId: item.id,
    itemType: item.type,
    title: displayTitle(item),
    seriesName: item.seriesName,
    seasonNumber: item.seasonNumber,
    episodeNumber: item.episodeNumber,
    productionYear: item.productionYear,
    runtimeTicks: item.runtimeTicks,
    mediaSourceId: item.mediaSource.id,
    subtitleIndex: stream.index,
    subtitleLanguage: stream.language,
    subtitleCodec: stream.codec,
    itemDateRefreshed: item.dateLastRefreshed,
  };

  return index.replaceItem(indexedItem, cues);
}

/**
 * Emit one merged-window cue per adjacent pair (cue_n, cue_{n+1}) so the FTS
 * matcher can find user quotes that span a cue boundary. See issue #130.
 *
 * The merged row's text is the two source texts joined with a single space.
 * Whitespace inside each source text is normalised so the joined document is
 * treated as one continuous sentence by the tokenizer (and so a search like
 * "harry it's an inanimate object" matches without caring about the SRT line
 * break Bazarr inserted).
 *
 * The last cue has no successor and contributes nothing to the merged window.
 */
export function buildMergedWindowCues(singleCues: IndexedCue[]): IndexedCue[] {
  if (singleCues.length < 2) return [];
  const merged: IndexedCue[] = [];
  for (let i = 0; i < singleCues.length - 1; i += 1) {
    const current = singleCues[i];
    const next = singleCues[i + 1];
    if (!current || !next) continue;
    const combinedText = `${current.text} ${next.text}`.replace(/\s+/g, " ").trim();
    if (!combinedText) continue;
    merged.push({
      startMs: current.startMs,
      endMs: next.endMs,
      text: combinedText,
      kind: "merged",
    });
  }
  return merged;
}

async function mapWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  const limit = Math.max(1, concurrency);
  let cursor = 0;

  async function runWorker(): Promise<void> {
    while (cursor < items.length) {
      const current = items[cursor];
      cursor += 1;
      if (current === undefined) return;
      await worker(current);
      // Issue #147: each `worker` call ends with a synchronous SQLite write
      // (FTS5 + media_items insert) that can block the event loop for tens to
      // hundreds of ms on items with thousands of cues. Without this yield,
      // the Discord gateway's INTERACTION_CREATE delivery can be starved long
      // enough to blow the 3-second defer budget, surfacing as
      // "Unknown interaction" on /quote, /clip, etc. while the post-restart
      // incremental pass is hot. The setImmediate callback fires after I/O
      // events, giving the gateway a turn between items.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
}

export type { SubtitledMediaPage };
