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

  test("indexes hyphenated compounds so all forms match (issue #150)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Episode",
          title: "Aunt Irma Visits",
          seriesName: "The IT Crowd",
          seasonNumber: 1,
          episodeNumber: 6,
          mediaSourceId: "source",
          subtitleIndex: 0,
        },
        [{ startMs: 1234000, endMs: 1235500, text: "No! It was heart-warming." }],
      );

      // The reported failure mode: user types the unhyphenated compound.
      const compound = index.searchQuotes("heartwarming", 5);
      expect(compound).toHaveLength(1);
      expect(compound[0]?.text).toBe("No! It was heart-warming.");

      // Each half of the hyphenated word still matches (no regression).
      expect(index.searchQuotes("heart", 5)).toHaveLength(1);
      expect(index.searchQuotes("warming", 5)).toHaveLength(1);

      // Hyphenated query also matches (prepareFtsQuery splits on punctuation).
      expect(index.searchQuotes("heart-warming", 5)).toHaveLength(1);

      // Cue text is preserved as-written for display.
      expect(compound[0]?.text).toContain("heart-warming");
    } finally {
      index.close();
    }
  });

  test("rebuilds hyphen-augmented FTS on open from legacy un-augmented data (issue #150)", () => {
    // Simulate a database written by a pre-#150 build: triggers and FTS
    // rows exist, but cues with hyphens were indexed without the augmented
    // copy. Open via the current code and verify the migration runs.
    const legacyDb = new Database(dbPath, { create: true });
    try {
      legacyDb.exec(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE subtitle_cues (
          id INTEGER PRIMARY KEY,
          item_id TEXT NOT NULL,
          start_ms INTEGER NOT NULL,
          end_ms INTEGER NOT NULL,
          text TEXT NOT NULL,
          kind TEXT NOT NULL DEFAULT 'single'
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
        CREATE TABLE index_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        INSERT INTO subtitle_cues (item_id, start_ms, end_ms, text, kind)
        VALUES ('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 1000, 2000, 'No! It was heart-warming.', 'single');
        INSERT INTO media_items (
          item_id, item_type, title, media_source_id, subtitle_index, indexed_at, cue_count
        ) VALUES (
          'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'Episode', 'Aunt Irma Visits', 'source', 0, '2026-01-01T00:00:00.000Z', 1
        );
        INSERT INTO subtitle_cues_fts(subtitle_cues_fts) VALUES ('rebuild');
      `);

      // Sanity: legacy FTS does NOT find the unhyphenated form.
      const legacyHits = legacyDb
        .query("SELECT COUNT(*) AS n FROM subtitle_cues_fts WHERE subtitle_cues_fts MATCH 'heartwarming*'")
        .get() as { n: number };
      expect(legacyHits.n).toBe(0);
    } finally {
      legacyDb.close();
    }

    const index = openSubtitleIndex(dbPath);
    try {
      const results = index.searchQuotes("heartwarming", 5);
      expect(results).toHaveLength(1);
      expect(results[0]?.text).toBe("No! It was heart-warming.");
    } finally {
      index.close();
    }

    // Re-opening is a no-op (idempotent).
    const reopened = openSubtitleIndex(dbPath);
    try {
      expect(reopened.searchQuotes("heartwarming", 5)).toHaveLength(1);
    } finally {
      reopened.close();
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
