import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { openSubtitleIndex, prepareFtsQuery } from "../src/subtitles/index-db.ts";

const dbPath = `/tmp/jellybot-test-${crypto.randomUUID()}.db`;

afterEach(() => {
  try {
    unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

describe("prepareFtsQuery", () => {
  test("ANDs word tokens with prefix on the last token", () => {
    expect(prepareFtsQuery("love finds its way")).toBe('"love" AND "finds" AND "its" AND "way"*');
  });

  test("prefixes a single token query", () => {
    expect(prepareFtsQuery("love")).toBe('"love"*');
  });
});

describe("SubtitleIndex", () => {
  test("indexes and searches cues", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Movie",
          title: "Semantic Error",
          productionYear: 2022,
          mediaSourceId: "source",
          subtitleIndex: 2,
        },
        [{ startMs: 30000, endMs: 34576, text: "love finds its way toward us" }],
      );

      const results = index.searchQuotes("love finds its way", 5);
      expect(results).toHaveLength(1);
      expect(results[0]?.text).toContain("love finds its way");
      expect(results[0]?.startMs).toBe(30000);
    } finally {
      index.close();
    }
  });

  test("migrates legacy trigram fts to unicode61 on open", () => {
    const legacyDb = new Database(dbPath, { create: true });
    try {
      legacyDb.exec(`
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
          tokenize='trigram'
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
        INSERT INTO subtitle_cues (item_id, start_ms, end_ms, text)
        VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, 2000, 'hello world again');
        INSERT INTO media_items (
          item_id, item_type, title, media_source_id, subtitle_index, indexed_at, cue_count
        ) VALUES (
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Movie', 'Test', 'source', 0, '2026-01-01T00:00:00.000Z', 1
        );
        INSERT INTO subtitle_cues_fts(subtitle_cues_fts) VALUES ('rebuild');
      `);
    } finally {
      legacyDb.close();
    }

    const index = openSubtitleIndex(dbPath);
    try {
      const results = index.searchQuotes("hello wor", 5);
      expect(results).toHaveLength(1);
      expect(results[0]?.text).toBe("hello world again");
    } finally {
      index.close();
    }
  });
});
