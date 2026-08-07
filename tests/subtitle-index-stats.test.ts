import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSubtitleIndex, type IndexedCue, type IndexedMediaItem } from "../src/subtitles/index-db.ts";

/**
 * Issue #182: getStats must not full-scan subtitle_cues. cue_count on
 * media_items is the source of truth for single-cue totals.
 */
describe("SubtitleIndex.getStats (#182)", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tempDbPath(): string {
    const dir = mkdtempSync(join(tmpdir(), "jellybot-stats-"));
    tempDirs.push(dir);
    return join(dir, "subtitles.db");
  }

  const itemA: IndexedMediaItem = {
    itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    itemType: "Episode",
    title: "Pilot",
    seriesName: "Show",
    seasonNumber: 1,
    episodeNumber: 1,
    mediaSourceId: "src-a",
    subtitleIndex: 0,
  };

  const itemB: IndexedMediaItem = {
    itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    itemType: "Movie",
    title: "Film",
    mediaSourceId: "src-b",
    subtitleIndex: 0,
  };

  test("cueCount equals SUM(media_items.cue_count) and ignores merged-window rows", () => {
    const index = openSubtitleIndex(tempDbPath());
    try {
      index.replaceItem(itemA, [
        { startMs: 0, endMs: 1000, text: "one", kind: "single" },
        { startMs: 1000, endMs: 2000, text: "two", kind: "single" },
        { startMs: 0, endMs: 2000, text: "one two", kind: "merged" },
      ] satisfies IndexedCue[]);
      index.replaceItem(itemB, [{ startMs: 0, endMs: 500, text: "hello", kind: "single" }]);

      const stats = index.getStats();
      expect(stats.itemCount).toBe(2);
      // 2 singles + 1 single; merged row must not inflate the operator metric
      expect(stats.cueCount).toBe(3);
      expect(stats.lastIndexedAt).toBeTruthy();
    } finally {
      index.close();
    }
  });

  test("merged-only item reports cueCount 0 via media_items.cue_count", () => {
    const index = openSubtitleIndex(tempDbPath());
    try {
      const inserted = index.replaceItem(itemA, [
        { startMs: 0, endMs: 2000, text: "a b", kind: "merged" },
        { startMs: 1000, endMs: 3000, text: "b c", kind: "merged" },
      ]);
      // replaceItem returns single-cue insert count
      expect(inserted).toBe(0);

      const stats = index.getStats();
      expect(stats.itemCount).toBe(1);
      expect(stats.cueCount).toBe(0);
    } finally {
      index.close();
    }
  });
});
