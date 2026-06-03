import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import {
  openSubtitleIndex,
  type IndexedCue,
  type IndexedMediaItem,
} from "../src/subtitles/index-db.ts";
import { buildMergedWindowCues } from "../src/subtitles/indexer.ts";

// Issue #130: dialogue split across two SRT cues should still match the FTS
// query. Indexer emits a "merged window" row per adjacent cue pair so the
// matcher can find quotes that span a cue boundary.

const ITEM: IndexedMediaItem = {
  itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  itemType: "Movie",
  title: "In Bruges",
  productionYear: 2008,
  mediaSourceId: "source",
  subtitleIndex: 2,
};

function tempDbPath(): string {
  return `/tmp/jellybot-merged-${crypto.randomUUID()}.db`;
}

const cleanup = (dbPath: string) => {
  try {
    unlinkSync(dbPath);
  } catch {
    /* ignore */
  }
};

describe("subtitle index merged-window cues (#130)", () => {
  let dbPath: string;
  afterEach(() => {
    if (dbPath) cleanup(dbPath);
  });

  test("split-cue dialogue matches via merged window and clip uses first-cue start", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      // Two adjacent cues: a name + the rest of the line. The user's quote
      // spans both; neither cue alone contains all the search tokens.
      const cues: IndexedCue[] = [
        { startMs: 30_000, endMs: 31_500, text: "Harry,", kind: "single" },
        {
          startMs: 31_500,
          endMs: 35_000,
          text: "It's an inanimate fucking object.",
          kind: "single",
        },
        // The merged-window row the indexer is supposed to emit. Stored
        // explicitly here so the test verifies the search/render contract,
        // not the specific call site that builds it.
        {
          startMs: 30_000,
          endMs: 35_000,
          text: "Harry, It's an inanimate fucking object.",
          kind: "merged",
        },
      ];

      index.replaceItem(ITEM, cues);

      // The cross-cue query - exactly the In Bruges quote that broke prod.
      const hits = index.searchQuotes("harry it's an inanimate fucking object", 5);

      expect(hits.length).toBeGreaterThan(0);
      // Top hit should be the merged span, since it's the only row containing
      // every search token. Render starts at the FIRST cue's start.
      const top = hits[0]!;
      expect(top.startMs).toBe(30_000);
      expect(top.endMs).toBe(35_000);
      expect(top.text).toContain("Harry,");
      expect(top.text).toContain("inanimate fucking object");
    } finally {
      index.close();
    }
  });

  test("media_items.cue_count counts source cues only, not merged rows", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      const cues: IndexedCue[] = [
        { startMs: 0, endMs: 1000, text: "first", kind: "single" },
        { startMs: 1000, endMs: 2000, text: "second", kind: "single" },
        { startMs: 0, endMs: 2000, text: "first second", kind: "merged" },
      ];
      const inserted = index.replaceItem(ITEM, cues);
      expect(inserted).toBe(2);

      const stats = index.getStats();
      expect(stats.itemCount).toBe(1);
      expect(stats.cueCount).toBe(2);
    } finally {
      index.close();
    }
  });

  test("single-cue match keeps higher rank than merged equivalent", () => {
    dbPath = tempDbPath();
    const index = openSubtitleIndex(dbPath);
    try {
      const cues: IndexedCue[] = [
        {
          startMs: 1000,
          endMs: 4000,
          text: "love finds its way toward us",
          kind: "single",
        },
        {
          startMs: 4000,
          endMs: 7000,
          text: "in this strange dark night",
          kind: "single",
        },
        {
          startMs: 1000,
          endMs: 7000,
          text: "love finds its way toward us in this strange dark night",
          kind: "merged",
        },
      ];
      index.replaceItem(ITEM, cues);

      // Query is fully inside cue 1; cue 1 should win on bm25 (shorter doc).
      const hits = index.searchQuotes("love finds its way", 5);
      expect(hits[0]?.text).toBe("love finds its way toward us");
      expect(hits[0]?.startMs).toBe(1000);
      expect(hits[0]?.endMs).toBe(4000);
    } finally {
      index.close();
    }
  });

  test("buildMergedWindowCues emits one merged row per adjacent pair", () => {
    const singles: IndexedCue[] = [
      { startMs: 0, endMs: 1000, text: "Harry,", kind: "single" },
      {
        startMs: 1000,
        endMs: 4000,
        text: "It's an inanimate fucking object.",
        kind: "single",
      },
      { startMs: 4000, endMs: 6000, text: "Pause.", kind: "single" },
    ];

    const merged = buildMergedWindowCues(singles);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual({
      startMs: 0,
      endMs: 4000,
      text: "Harry, It's an inanimate fucking object.",
      kind: "merged",
    });
    expect(merged[1]).toEqual({
      startMs: 1000,
      endMs: 6000,
      text: "It's an inanimate fucking object. Pause.",
      kind: "merged",
    });
  });

  test("buildMergedWindowCues skips fewer-than-two inputs and collapses whitespace", () => {
    expect(buildMergedWindowCues([])).toEqual([]);
    expect(
      buildMergedWindowCues([{ startMs: 0, endMs: 1, text: "lone", kind: "single" }]),
    ).toEqual([]);

    const merged = buildMergedWindowCues([
      { startMs: 0, endMs: 1000, text: "line  one\n", kind: "single" },
      { startMs: 1000, endMs: 2000, text: " line two ", kind: "single" },
    ]);
    expect(merged[0]?.text).toBe("line one line two");
  });

  test("legacy db without kind column gets the column added on open", () => {
    dbPath = tempDbPath();
    const legacy = new Database(dbPath, { create: true });
    try {
      legacy.exec(`
        CREATE TABLE subtitle_cues (
          id INTEGER PRIMARY KEY,
          item_id TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          text TEXT NOT NULL
        );
        CREATE VIRTUAL TABLE subtitle_cues_fts USING fts5(
          text,
          item_id UNINDEXED,
          content='subtitle_cues',
          content_rowid='id',
          tokenize='unicode61 remove_diacritics 2'
        );
        CREATE TABLE media_items (
          item_id TEXT PRIMARY KEY,
          item_type TEXT NOT NULL,
          title TEXT NOT NULL,
          series_name TEXT,
          season_number INTEGER,
          episode_number INTEGER,
          production_year INTEGER,
          runtime_ticks INTEGER,
          media_source_id TEXT NOT NULL,
          subtitle_index INTEGER NOT NULL,
          subtitle_language TEXT,
          subtitle_codec TEXT,
          item_date_refreshed TEXT,
          indexed_at TEXT NOT NULL,
          cue_count INTEGER NOT NULL
        );
        CREATE TABLE index_runs (
          id INTEGER PRIMARY KEY,
          started_at TEXT NOT NULL,
          finished_at TEXT,
          items_scanned INTEGER NOT NULL DEFAULT 0,
          items_indexed INTEGER NOT NULL DEFAULT 0,
          items_skipped INTEGER NOT NULL DEFAULT 0,
          cues_indexed INTEGER NOT NULL DEFAULT 0,
          errors INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL
        );
        INSERT INTO subtitle_cues (item_id, start_ms, end_ms, text) VALUES
          ('${ITEM.itemId}', 1000, 2000, 'legacy row');
        INSERT INTO media_items (
          item_id, item_type, title, media_source_id, subtitle_index, indexed_at, cue_count
        ) VALUES ('${ITEM.itemId}', 'Movie', 'Legacy', 'source', 0, '2026-01-01T00:00:00.000Z', 1);
        INSERT INTO subtitle_cues_fts(subtitle_cues_fts) VALUES ('rebuild');
      `);
    } finally {
      legacy.close();
    }

    const index = openSubtitleIndex(dbPath);
    try {
      // Existing rows should default to 'single' so stats still report them.
      const stats = index.getStats();
      expect(stats.cueCount).toBe(1);

      // New inserts can specify kind; merged-window flow stays disabled until
      // a re-index, which is the intended migration path.
      index.replaceItem(ITEM, [
        { startMs: 1000, endMs: 2000, text: "fresh row", kind: "single" },
        { startMs: 1000, endMs: 4000, text: "fresh row continues", kind: "merged" },
      ]);
      const after = index.getStats();
      expect(after.cueCount).toBe(1);
    } finally {
      index.close();
    }
  });
});
