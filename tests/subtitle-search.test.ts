import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { Database } from "bun:sqlite";
import { openSubtitleIndex, prepareFtsQuery } from "../src/subtitles/index-db.ts";
import { rankQuoteAutocompleteResults } from "../src/subtitles/quote-query-shaping.ts";

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

  test("phrase mode joins tokens into one contiguous FTS5 phrase with last-token prefix (#228)", () => {
    expect(prepareFtsQuery("are they heavy", { mode: "phrase" })).toBe('"are they heavy"*');
    expect(prepareFtsQuery("are they heav", { mode: "phrase" })).toBe('"are they heav"*');
  });

  test("phrase mode keeps stop words and single-letter tokens for adjacency", () => {
    expect(prepareFtsQuery("love finds its way", { mode: "phrase" })).toBe(
      '"love finds its way"*',
    );
    expect(prepareFtsQuery("Do I know you", { mode: "phrase" })).toBe('"do i know you"*');
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

  test("phrase oversample + JS re-rank recovers exact cue among many longer matches (#228)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      const cues = Array.from({ length: 30 }, (_, i) => ({
        startMs: i * 1000,
        endMs: i * 1000 + 500,
        text: `Are they heavyweights in the championship tournament again today? ${i}`,
        kind: "single" as const,
      }));
      cues.push({ startMs: 40_000, endMs: 41_000, text: "Are they heavy?", kind: "single" });

      index.replaceItem(
        {
          itemId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          itemType: "Movie",
          title: "Heavyweights",
          productionYear: 1995,
          mediaSourceId: "source",
          subtitleIndex: 0,
        },
        cues,
      );

      const tight = index.searchQuotes("are they heavy", 24, undefined, {
        mode: "phrase",
        orderBy: "none",
      });
      expect(tight.some((row) => row.text === "Are they heavy?")).toBe(false);

      const wide = index.searchQuotes("are they heavy", 64, undefined, {
        mode: "phrase",
        orderBy: "none",
      });
      expect(wide.some((row) => row.text === "Are they heavy?")).toBe(true);
      expect(rankQuoteAutocompleteResults("are they heavy", wide)[0]?.text).toBe("Are they heavy?");
    } finally {
      index.close();
    }
  });

  test("phrase mode prefers the contiguous spoken line over bag-of-words hits (#228)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          itemType: "Movie",
          title: "Office Space",
          productionYear: 1999,
          mediaSourceId: "source",
          subtitleIndex: 0,
        },
        [
          { startMs: 1000, endMs: 2000, text: "Are they heavy?", kind: "single" },
          { startMs: 3000, endMs: 4000, text: "They are all heavy-hitters.", kind: "single" },
        ],
      );

      const andHits = index.searchQuotes("are they heavy", 5);
      // Bag-of-words AND matches both cues (tokens appear, not necessarily contiguous).
      expect(andHits.map((row) => row.text).sort()).toEqual([
        "Are they heavy?",
        "They are all heavy-hitters.",
      ]);

      const phraseHits = index.searchQuotes("are they heavy", 5, undefined, {
        mode: "phrase",
        orderBy: "none",
      });
      expect(phraseHits).toHaveLength(1);
      expect(phraseHits[0]?.text).toBe("Are they heavy?");
    } finally {
      index.close();
    }
  });

  test("phrase mode matches cues when stop words sit between content tokens (#228)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "cccccccccccccccccccccccccccccccc",
          itemType: "Movie",
          title: "Semantic Error",
          productionYear: 2022,
          mediaSourceId: "source",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "love finds its way toward us", kind: "single" }],
      );

      // Shaped AND path would search "love finds way" and miss under phrase rules.
      const hits = index.searchQuotes("love finds its way", 5, undefined, {
        mode: "phrase",
        orderBy: "none",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toContain("love finds its way");
    } finally {
      index.close();
    }
  });

  test("phrase mode keeps single-letter tokens like I (#228)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "dddddddddddddddddddddddddddddddd",
          itemType: "Movie",
          title: "Know You",
          productionYear: 2000,
          mediaSourceId: "source",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Do I know you?", kind: "single" }],
      );

      const hits = index.searchQuotes("Do I know you", 5, undefined, {
        mode: "phrase",
        orderBy: "none",
      });
      expect(hits).toHaveLength(1);
      expect(hits[0]?.text).toBe("Do I know you?");
    } finally {
      index.close();
    }
  });

  test("scopes searchQuotes to a series or movie (issues #152 / #202)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      // Two cues with the same word in different titles. Bare query returns
      // both; scoped query returns only the requested one.
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Episode",
          title: "Aunt Irma Visits",
          seriesName: "The IT Crowd",
          seasonNumber: 1,
          episodeNumber: 6,
          mediaSourceId: "src-itc",
          subtitleIndex: 0,
        },
        [{ startMs: 1234000, endMs: 1235500, text: "No! It was heart-warming." }],
      );

      index.replaceItem(
        {
          itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          itemType: "Movie",
          title: "Heartwarming",
          productionYear: 2020,
          mediaSourceId: "src-hw",
          subtitleIndex: 0,
        },
        [{ startMs: 60000, endMs: 62000, text: "Heartwarming." }],
      );

      // No filter: both surface (current global behaviour).
      const unscoped = index.searchQuotes("heartwarming", 10);
      expect(unscoped.length).toBeGreaterThanOrEqual(2);

      // Series filter (case-insensitive) keeps only the IT Crowd cue.
      const scoped = index.searchQuotes("heartwarming", 10, {
        kind: "series",
        seriesName: "the it crowd",
      });
      expect(scoped).toHaveLength(1);
      expect(scoped[0]?.seriesName).toBe("The IT Crowd");
      expect(scoped[0]?.text).toBe("No! It was heart-warming.");

      // Movie item_id filter keeps only that film.
      const movieScoped = index.searchQuotes("heartwarming", 10, {
        kind: "movie",
        itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      });
      expect(movieScoped).toHaveLength(1);
      expect(movieScoped[0]?.itemId).toBe("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(movieScoped[0]?.itemType).toBe("Movie");

      // seriesByItem resolves the full series_name via a sample episode id.
      const byItem = index.searchQuotes("heartwarming", 10, {
        kind: "seriesByItem",
        itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      });
      expect(byItem).toHaveLength(1);
      expect(byItem[0]?.seriesName).toBe("The IT Crowd");

      // Movies (NULL series_name) never satisfy a series filter.
      const moviesOnly = index.searchQuotes("heartwarming", 10, {
        kind: "series",
        seriesName: "Heartwarming",
      });
      expect(moviesOnly).toHaveLength(0);

      // Unknown series returns nothing without throwing.
      expect(
        index.searchQuotes("heartwarming", 10, {
          kind: "series",
          seriesName: "Nonexistent Show",
        }),
      ).toHaveLength(0);
    } finally {
      index.close();
    }
  });

  test("listQuoteFromTitles sticks when Discord re-sends the display label (#222)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "dddddddddddddddddddddddddddddddd",
          itemType: "Movie",
          title: "Jurassic Park",
          productionYear: 1993,
          mediaSourceId: "src-jp",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Are they heavy?" }],
      );
      index.replaceItem(
        {
          itemId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
          itemType: "Episode",
          title: "Pilot",
          seriesName: "The IT Crowd",
          seasonNumber: 1,
          episodeNumber: 1,
          mediaSourceId: "src-it",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );

      const movieHits = index.listQuoteFromTitles("Movie · Jurassic Park (1993)", 5);
      expect(movieHits).toHaveLength(1);
      expect(movieHits[0]?.value).toBe("m:dddddddddddddddddddddddddddddddd");
      expect(movieHits[0]?.label).toContain("Jurassic Park");

      const seriesHits = index.listQuoteFromTitles("TV · The IT Crowd", 5);
      expect(seriesHits).toHaveLength(1);
      expect(seriesHits[0]?.value).toBe("s:The IT Crowd");

      expect(index.resolveQuoteFromOption("Movie · Jurassic Park (1993)")).toEqual({
        kind: "movie",
        itemId: "dddddddddddddddddddddddddddddddd",
      });

      const longTitle = `Jurassic ${"Park ".repeat(40)}Finale`;
      index.replaceItem(
        {
          itemId: "ffffffffffffffffffffffffffffffff",
          itemType: "Movie",
          title: longTitle,
          productionYear: 1993,
          mediaSourceId: "src-long-jp",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Are they heavy?" }],
      );
      const longLabel = index.listQuoteFromTitles(longTitle.slice(0, 12), 5).find((h) =>
        h.label.includes("Jurassic"),
      )?.label;
      expect(longLabel).toBeTruthy();
      expect(longLabel!.endsWith("…") || longLabel!.length <= 100).toBe(true);
      if (longLabel?.endsWith("…")) {
        const stickyLong = index.listQuoteFromTitles(longLabel, 5);
        expect(stickyLong.some((h) => h.value === "m:ffffffffffffffffffffffffffffffff")).toBe(true);
      }
    } finally {
      index.close();
    }
  });

  test("listQuoteFromTitles prefers titles that start with the prefix (issue #214)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      // Contains-only noise that sorts alphabetically BEFORE "Old School"
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Movie",
          title: "Goldfinger",
          productionYear: 1964,
          mediaSourceId: "src-gold",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );
      index.replaceItem(
        {
          itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          itemType: "Movie",
          title: "A Very Harold & Kumar Christmas",
          productionYear: 2011,
          mediaSourceId: "src-harold",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );
      index.replaceItem(
        {
          itemId: "cccccccccccccccccccccccccccccccc",
          itemType: "Movie",
          title: "Old School",
          productionYear: 2003,
          mediaSourceId: "src-old",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "I'm here for the gang bang." }],
      );

      const hits = index.listQuoteFromTitles("old", 2);
      expect(hits.some((h) => h.label.includes("Old School"))).toBe(true);
      expect(hits[0]?.label).toContain("Old School");
      expect(hits.every((h) => !h.label.includes("Goldfinger"))).toBe(true);
    } finally {
      index.close();
    }
  });

  test("listQuoteFromTitles returns series and movies for from autocomplete (issue #202)", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Episode",
          title: "Pilot",
          seriesName: "Archer",
          seasonNumber: 1,
          episodeNumber: 1,
          mediaSourceId: "src-a",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );
      index.replaceItem(
        {
          itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
          itemType: "Movie",
          title: "Archipelago",
          productionYear: 2010,
          mediaSourceId: "src-m",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );

      const hits = index.listQuoteFromTitles("arch", 25);
      expect(hits.map((h) => h.kind).sort()).toEqual(["movie", "series"]);
      expect(hits.find((h) => h.kind === "series")?.value).toBe("s:Archer");
      expect(hits.find((h) => h.kind === "movie")?.value).toBe(
        "m:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      );
      expect(hits.find((h) => h.kind === "movie")?.label).toContain("Movie ·");
      expect(hits.find((h) => h.kind === "series")?.label).toContain("TV ·");

      const longName = `Very Long Series Title ${"Z".repeat(100)}`;
      index.replaceItem(
        {
          itemId: "cccccccccccccccccccccccccccccccc",
          itemType: "Episode",
          title: "Ep1",
          seriesName: longName,
          seasonNumber: 1,
          episodeNumber: 1,
          mediaSourceId: "src-long",
          subtitleIndex: 0,
        },
        [{ startMs: 1000, endMs: 2000, text: "Hello." }],
      );
      const longHits = index.listQuoteFromTitles("Very Long Series", 25);
      const longChoice = longHits.find((h) => h.kind === "series" && h.label.includes("Very Long"));
      expect(longChoice?.value.startsWith("se:")).toBe(true);
      expect(longChoice?.value.length).toBeLessThanOrEqual(100);
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
