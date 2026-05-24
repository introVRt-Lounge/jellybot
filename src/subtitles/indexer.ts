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

async function indexOneItem(
  jellyfin: JellyfinClient,
  index: SubtitleIndex,
  item: JellyfinItemWithMedia,
  preferredLanguages: string[],
): Promise<number> {
  const stream = pickSubtitleStream(item.mediaSource.streams, preferredLanguages);
  if (!stream) return 0;

  const raw = await jellyfin.fetchSubtitleText(item.id, item.mediaSource.id, stream.index, stream.codec);
  const cues = parseSubtitleContent(raw.content, raw.format).map(
    (cue): IndexedCue => ({
      startMs: Math.round(cue.startSeconds * 1000),
      endMs: Math.round(cue.endSeconds * 1000),
      text: cue.text,
    }),
  );

  if (cues.length === 0) return 0;

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
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => runWorker()));
}

export type { SubtitledMediaPage };
