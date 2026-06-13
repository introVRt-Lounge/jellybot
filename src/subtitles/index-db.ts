import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type IndexedMediaItem = {
  itemId: string;
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  productionYear?: number;
  runtimeTicks?: number;
  mediaSourceId: string;
  subtitleIndex: number;
  subtitleLanguage?: string;
  subtitleCodec?: string;
  itemDateRefreshed?: string;
};

/**
 * Subtitle cue persisted to the FTS index.
 *
 * `kind` distinguishes:
 * - `single`: one row per source SRT cue. Drives clip start/end and the
 *   matcher's confidence calculation.
 * - `merged`: a synthetic row spanning two adjacent source cues
 *   (`text_n + " " + text_{n+1}`). Stored so the FTS matcher can fulfill
 *   user quotes that span a cue boundary, e.g. "Harry, It's an inanimate
 *   fucking object." which the SRT splits into two on-screen lines.
 *
 * `media_items.cue_count` only counts `single` rows so the operator metric
 * stays "what's in the file" rather than "what's in the FTS index". See
 * issue #130.
 */
export type CueKind = "single" | "merged";

export type IndexedCue = {
  startMs: number;
  endMs: number;
  text: string;
  kind?: CueKind;
};

export type QuoteSearchResult = {
  itemId: string;
  itemType: string;
  title: string;
  seriesName?: string;
  seasonNumber?: number;
  episodeNumber?: number;
  productionYear?: number;
  runtimeTicks?: number;
  startMs: number;
  endMs: number;
  text: string;
  rank: number;
};

export type SubtitleIndexStats = {
  itemCount: number;
  cueCount: number;
  lastIndexedAt: string | null;
};

const FTS_TOKENIZER = "unicode61 remove_diacritics 2";

/**
 * SQL expression that produces the text fed to the FTS5 index for a given
 * cue row. For cues that contain a hyphen we append a copy with hyphens
 * stripped so the same cue is searchable under all three of:
 *  - the original tokens (e.g. `heart`, `warming` from `heart-warming`)
 *  - the de-hyphenated compound (e.g. `heartwarming`)
 * This catches the common case where a writer hyphenates a compound word
 * the user types as one word from memory. See issue #150.
 *
 * Cues without a hyphen are passed through unchanged so we don't inflate
 * the FTS document for the 95%+ of rows that don't need it (which would
 * skew bm25 ranking).
 *
 * The expression is used both inside the AFTER INSERT/UPDATE triggers and
 * by the one-shot rebuild path that re-populates FTS from existing rows.
 */
const FTS_TEXT_EXPR = `CASE WHEN INSTR(text, '-') > 0 THEN text || ' ' || REPLACE(text, '-', '') ELSE text END`;
const FTS_NEW_TEXT_EXPR = FTS_TEXT_EXPR.replace(/text/g, "new.text");
const FTS_OLD_TEXT_EXPR = FTS_TEXT_EXPR.replace(/text/g, "old.text");

/**
 * Schema version for the FTS document format. Bump when the contents fed
 * to FTS5 change in a way that requires existing rows to be re-tokenized.
 *  - "0" / unset: legacy, raw `subtitle_cues.text` only.
 *  - "1": #150 hyphen-augmented (`text + ' ' + replace(text, '-', '')`).
 */
const FTS_NORMALIZE_VERSION = "1";

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS media_items (
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

CREATE TABLE IF NOT EXISTS subtitle_cues (
  id INTEGER PRIMARY KEY,
  item_id TEXT NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  text TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'single',
  FOREIGN KEY (item_id) REFERENCES media_items(item_id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS index_runs (
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

CREATE TABLE IF NOT EXISTS index_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_subtitle_cues_item_id ON subtitle_cues(item_id);
`;

const CREATE_FTS_UNICODE61 = `
CREATE VIRTUAL TABLE subtitle_cues_fts USING fts5(
  text,
  item_id UNINDEXED,
  content='subtitle_cues',
  content_rowid='id',
  tokenize='${FTS_TOKENIZER}'
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS subtitle_cues_ai AFTER INSERT ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(rowid, text, item_id) VALUES (new.id, ${FTS_NEW_TEXT_EXPR}, new.item_id);
END;

CREATE TRIGGER IF NOT EXISTS subtitle_cues_ad AFTER DELETE ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text, item_id)
  VALUES ('delete', old.id, ${FTS_OLD_TEXT_EXPR}, old.item_id);
END;

CREATE TRIGGER IF NOT EXISTS subtitle_cues_au AFTER UPDATE ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text, item_id)
  VALUES ('delete', old.id, ${FTS_OLD_TEXT_EXPR}, old.item_id);
  INSERT INTO subtitle_cues_fts(rowid, text, item_id) VALUES (new.id, ${FTS_NEW_TEXT_EXPR}, new.item_id);
END;
`;

export type SubtitleIndexOpenOptions = {
  readonly?: boolean;
};

export class SubtitleIndex {
  private readonly db: Database;

  constructor(dbPath: string, options: SubtitleIndexOpenOptions = {}) {
    this.db = new Database(dbPath, options.readonly ? { readonly: true } : { create: true });
    if (options.readonly) {
      return;
    }

    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(BASE_SCHEMA);
    ensureCueKindColumn(this.db);
    ensureUnicode61Fts(this.db);
    this.db.exec(FTS_TRIGGERS);
    ensureFtsNormalizeVersion(this.db);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Look up the indexed media metadata for an item id. Used by the clip-item
   * resolver to recover from "no longer exists" when Jellyfin reissues an
   * item id after a file replace. Issue #118.
   */
  getMediaItem(itemId: string): IndexedMediaItem | null {
    const row = this.db
      .query(
        `SELECT
          item_id AS itemId,
          item_type AS itemType,
          title,
          series_name AS seriesName,
          season_number AS seasonNumber,
          episode_number AS episodeNumber,
          production_year AS productionYear,
          runtime_ticks AS runtimeTicks,
          media_source_id AS mediaSourceId,
          subtitle_index AS subtitleIndex,
          subtitle_language AS subtitleLanguage,
          subtitle_codec AS subtitleCodec,
          item_date_refreshed AS itemDateRefreshed
         FROM media_items
         WHERE item_id = ?
         LIMIT 1`,
      )
      .get(itemId) as IndexedMediaItem | null;
    return row ?? null;
  }

  getStoredDateRefreshed(itemId: string): string | null {
    const row = this.db
      .query("SELECT item_date_refreshed FROM media_items WHERE item_id = ?")
      .get(itemId) as { item_date_refreshed: string | null } | null;
    return row?.item_date_refreshed ?? null;
  }

  replaceItem(item: IndexedMediaItem, cues: IndexedCue[]): number {
    const indexedAt = new Date().toISOString();
    const singleCount = cues.reduce((acc, cue) => acc + (cue.kind === "merged" ? 0 : 1), 0);
    const tx = this.db.transaction(() => {
      this.db.run("DELETE FROM subtitle_cues WHERE item_id = ?", [item.itemId]);
      this.db.run("DELETE FROM media_items WHERE item_id = ?", [item.itemId]);

      this.db.run(
        `INSERT INTO media_items (
          item_id, item_type, title, series_name, season_number, episode_number,
          production_year, runtime_ticks, media_source_id, subtitle_index,
          subtitle_language, subtitle_codec, item_date_refreshed, indexed_at, cue_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          item.itemId,
          item.itemType,
          item.title,
          item.seriesName ?? null,
          item.seasonNumber ?? null,
          item.episodeNumber ?? null,
          item.productionYear ?? null,
          item.runtimeTicks ?? null,
          item.mediaSourceId,
          item.subtitleIndex,
          item.subtitleLanguage ?? null,
          item.subtitleCodec ?? null,
          item.itemDateRefreshed ?? null,
          indexedAt,
          singleCount,
        ],
      );

      const insertCue = this.db.query(
        "INSERT INTO subtitle_cues (item_id, start_ms, end_ms, text, kind) VALUES (?, ?, ?, ?, ?)",
      );

      for (const cue of cues) {
        insertCue.run(item.itemId, cue.startMs, cue.endMs, cue.text, cue.kind ?? "single");
      }
    });

    tx();
    return singleCount;
  }

  /**
   * Search subtitle cues by FTS5 ranked by bm25.
   *
   * `seriesName` (case-insensitive equals) narrows results to a single TV
   * show. Used by `/quote series:` (#152) so common-noun queries like
   * `heartwarming` aren't drowned out by short-cue movies elsewhere in the
   * catalogue. Movies have a NULL `series_name`; passing a series filter
   * naturally excludes them.
   */
  searchQuotes(query: string, limit = 25, seriesName?: string): QuoteSearchResult[] {
    const ftsQuery = prepareFtsQuery(query);
    if (!ftsQuery) return [];

    const where: string[] = ["subtitle_cues_fts MATCH ?"];
    const params: (string | number)[] = [ftsQuery];

    if (seriesName) {
      where.push("LOWER(m.series_name) = LOWER(?)");
      params.push(seriesName);
    }

    params.push(limit);

    return this.db
      .query(
        `SELECT
          m.item_id AS itemId,
          m.item_type AS itemType,
          m.title AS title,
          m.series_name AS seriesName,
          m.season_number AS seasonNumber,
          m.episode_number AS episodeNumber,
          m.production_year AS productionYear,
          m.runtime_ticks AS runtimeTicks,
          c.start_ms AS startMs,
          c.end_ms AS endMs,
          c.text AS text,
          bm25(subtitle_cues_fts) AS rank
        FROM subtitle_cues_fts
        JOIN subtitle_cues c ON c.id = subtitle_cues_fts.rowid
        JOIN media_items m ON m.item_id = c.item_id
        WHERE ${where.join(" AND ")}
        ORDER BY rank
        LIMIT ?`,
      )
      .all(...params) as QuoteSearchResult[];
  }

  /**
   * Find every `kind='single'` cue matching the FTS query, returned in
   * chronological order (series -> season -> episode -> startMs). Used by
   * the supercut feature (#140) where ordering matters and merged-window
   * rows would produce duplicate clips.
   *
   * `seriesName` filter is case-insensitive equals; pass it to keep results
   * coherent for short common phrases that would otherwise span the whole
   * library. `titleEquals` lets a caller pin to a single movie or episode
   * (case-insensitive).
   */
  searchSupercutCues(opts: {
    query: string;
    seriesName?: string;
    titleEquals?: string;
    limit: number;
  }): QuoteSearchResult[] {
    const ftsQuery = prepareFtsQuery(opts.query);
    if (!ftsQuery) return [];

    const where: string[] = [
      "subtitle_cues_fts MATCH ?",
      "c.kind = 'single'",
    ];
    const params: (string | number)[] = [ftsQuery];

    if (opts.seriesName) {
      where.push("LOWER(m.series_name) = LOWER(?)");
      params.push(opts.seriesName);
    }
    if (opts.titleEquals) {
      where.push("LOWER(m.title) = LOWER(?)");
      params.push(opts.titleEquals);
    }

    params.push(opts.limit);

    return this.db
      .query(
        `SELECT
          m.item_id AS itemId,
          m.item_type AS itemType,
          m.title AS title,
          m.series_name AS seriesName,
          m.season_number AS seasonNumber,
          m.episode_number AS episodeNumber,
          m.production_year AS productionYear,
          m.runtime_ticks AS runtimeTicks,
          c.start_ms AS startMs,
          c.end_ms AS endMs,
          c.text AS text,
          0 AS rank
        FROM subtitle_cues_fts
        JOIN subtitle_cues c ON c.id = subtitle_cues_fts.rowid
        JOIN media_items m ON m.item_id = c.item_id
        WHERE ${where.join(" AND ")}
        ORDER BY
          COALESCE(m.series_name, '') ASC,
          COALESCE(m.season_number, 0) ASC,
          COALESCE(m.episode_number, 0) ASC,
          c.start_ms ASC
        LIMIT ?`,
      )
      .all(...params) as QuoteSearchResult[];
  }

  /**
   * Distinct series names currently in the index. Used by the supercut
   * autocomplete to suggest the `series` argument.
   */
  listSeriesNames(prefix: string, limit: number): string[] {
    const trimmed = prefix.trim();
    const rows = trimmed.length === 0
      ? (this.db
          .query(
            `SELECT DISTINCT series_name AS name
             FROM media_items
             WHERE series_name IS NOT NULL AND series_name <> ''
             ORDER BY series_name COLLATE NOCASE
             LIMIT ?`,
          )
          .all(limit) as { name: string }[])
      : (this.db
          .query(
            `SELECT DISTINCT series_name AS name
             FROM media_items
             WHERE series_name IS NOT NULL AND series_name <> ''
               AND LOWER(series_name) LIKE LOWER(?)
             ORDER BY series_name COLLATE NOCASE
             LIMIT ?`,
          )
          .all(`%${trimmed}%`, limit) as { name: string }[]);

    return rows.map((r) => r.name);
  }

  getCueMatch(itemId: string, startMs: number, endMs: number): QuoteSearchResult | null {
    const row = this.db
      .query(
        `SELECT
          m.item_id AS itemId,
          m.item_type AS itemType,
          m.title AS title,
          m.series_name AS seriesName,
          m.season_number AS seasonNumber,
          m.episode_number AS episodeNumber,
          m.production_year AS productionYear,
          m.runtime_ticks AS runtimeTicks,
          c.start_ms AS startMs,
          c.end_ms AS endMs,
          c.text AS text,
          0 AS rank
        FROM subtitle_cues c
        JOIN media_items m ON m.item_id = c.item_id
        WHERE c.item_id = ? AND c.start_ms = ? AND c.end_ms = ?
        LIMIT 1`,
      )
      .get(itemId, startMs, endMs) as QuoteSearchResult | null;

    return row ?? null;
  }

  getStats(): SubtitleIndexStats {
    const itemCount = (this.db.query("SELECT COUNT(*) AS count FROM media_items").get() as { count: number }).count;
    // Operator metric reports source-cue count only; merged-window rows
    // (issue #130) are an FTS-side artifact, not actual subtitle cues.
    const cueCount = (
      this.db.query("SELECT COUNT(*) AS count FROM subtitle_cues WHERE kind = 'single'").get() as {
        count: number;
      }
    ).count;
    const lastIndexedAt =
      (this.db.query("SELECT MAX(indexed_at) AS value FROM media_items").get() as { value: string | null }).value ??
      null;

    return { itemCount, cueCount, lastIndexedAt };
  }

  startRun(): number {
    const startedAt = new Date().toISOString();
    this.db.run("INSERT INTO index_runs (started_at, status) VALUES (?, 'running')", [startedAt]);
    const row = this.db.query("SELECT last_insert_rowid() AS id").get() as { id: number };
    return row.id;
  }

  finishRun(
    runId: number,
    summary: {
      itemsScanned: number;
      itemsIndexed: number;
      itemsSkipped: number;
      cuesIndexed: number;
      errors: number;
      status: "completed" | "failed";
    },
  ): void {
    this.db.run(
      `UPDATE index_runs
       SET finished_at = ?, items_scanned = ?, items_indexed = ?, items_skipped = ?,
           cues_indexed = ?, errors = ?, status = ?
       WHERE id = ?`,
      [
        new Date().toISOString(),
        summary.itemsScanned,
        summary.itemsIndexed,
        summary.itemsSkipped,
        summary.cuesIndexed,
        summary.errors,
        summary.status,
        runId,
      ],
    );
  }
}

export function prepareFtsQuery(query: string): string {
  const tokens = query
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length >= 2);

  if (tokens.length === 0) return "";

  return tokens
    .map((token, index) => {
      const escaped = token.replace(/"/g, '""');
      const prefix = index === tokens.length - 1 ? "*" : "";
      return `"${escaped}"${prefix}`;
    })
    .join(" AND ");
}

/**
 * Add the `kind` column to subtitle_cues if it's missing (issue #130). The
 * column is required by the merged-window matcher path; existing rows in
 * pre-#130 databases default to 'single' so historical data behaves as before.
 *
 * SQLite's `ALTER TABLE ADD COLUMN` is cheap (schema-only metadata change);
 * no row rewrite. The FTS triggers index `text` only, so the new column does
 * not affect the FTS5 shadow tables.
 */
function ensureCueKindColumn(db: Database): void {
  const columns = db.query("PRAGMA table_info(subtitle_cues)").all() as Array<{ name: string }>;
  if (columns.some((c) => c.name === "kind")) return;
  db.exec("ALTER TABLE subtitle_cues ADD COLUMN kind TEXT NOT NULL DEFAULT 'single'");
  console.info(
    JSON.stringify({
      event: "subtitle_index.schema_migrated",
      change: "added subtitle_cues.kind column",
      issue: "#130",
    }),
  );
}

function ensureUnicode61Fts(db: Database): void {
  const existing = db
    .query("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'subtitle_cues_fts'")
    .get() as { sql: string } | null;

  if (!existing) {
    db.exec(CREATE_FTS_UNICODE61);
    setIndexMeta(db, "fts_tokenizer", FTS_TOKENIZER);
    return;
  }

  if (existing.sql.includes("trigram")) {
    migrateTrigramFtsToUnicode61(db);
    return;
  }

  if (!existing.sql.includes("unicode61")) {
    migrateTrigramFtsToUnicode61(db);
  }
}

function migrateTrigramFtsToUnicode61(db: Database): void {
  db.exec(`
    DROP TRIGGER IF EXISTS subtitle_cues_ai;
    DROP TRIGGER IF EXISTS subtitle_cues_ad;
    DROP TRIGGER IF EXISTS subtitle_cues_au;
    DROP TABLE IF EXISTS subtitle_cues_fts;
  `);
  db.exec(CREATE_FTS_UNICODE61);
  db.exec("INSERT INTO subtitle_cues_fts(subtitle_cues_fts) VALUES ('rebuild')");
  db.exec("VACUUM");
  setIndexMeta(db, "fts_tokenizer", FTS_TOKENIZER);
  console.info(
    JSON.stringify({
      event: "subtitle_index.fts_migrated",
      from: "trigram",
      to: FTS_TOKENIZER,
    }),
  );
}

function setIndexMeta(db: Database, key: string, value: string): void {
  db.run("INSERT INTO index_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", [
    key,
    value,
  ]);
}

function getIndexMeta(db: Database, key: string): string | null {
  const row = db.query("SELECT value FROM index_meta WHERE key = ?").get(key) as { value: string } | null;
  return row?.value ?? null;
}

/**
 * Ensure the FTS5 index uses the current document-augmentation rules.
 * If the on-disk database was written by a pre-#150 build, drop the FTS
 * table + triggers, recreate them with the hyphen-augmented format, and
 * repopulate from `subtitle_cues` in a single bulk insert.
 *
 * Idempotent: a no-op once `index_meta.fts_normalize_version` matches the
 * current `FTS_NORMALIZE_VERSION` constant.
 */
function ensureFtsNormalizeVersion(db: Database): void {
  const current = getIndexMeta(db, "fts_normalize_version");
  if (current === FTS_NORMALIZE_VERSION) return;

  const cueCount = (db.query("SELECT COUNT(*) AS count FROM subtitle_cues").get() as { count: number }).count;

  // Fresh database: triggers and FTS table were just created with the
  // current format and there's no existing data to re-tokenize. Stamp the
  // version and skip the drop/rebuild dance.
  if (current === null && cueCount === 0) {
    setIndexMeta(db, "fts_normalize_version", FTS_NORMALIZE_VERSION);
    return;
  }

  db.exec(`
    DROP TRIGGER IF EXISTS subtitle_cues_ai;
    DROP TRIGGER IF EXISTS subtitle_cues_ad;
    DROP TRIGGER IF EXISTS subtitle_cues_au;
    DROP TABLE IF EXISTS subtitle_cues_fts;
  `);
  db.exec(CREATE_FTS_UNICODE61);
  db.exec(FTS_TRIGGERS);
  db.run(
    `INSERT INTO subtitle_cues_fts(rowid, text, item_id)
     SELECT id, ${FTS_TEXT_EXPR}, item_id FROM subtitle_cues`,
  );
  setIndexMeta(db, "fts_normalize_version", FTS_NORMALIZE_VERSION);
  setIndexMeta(db, "fts_tokenizer", FTS_TOKENIZER);

  console.info(
    JSON.stringify({
      event: "subtitle_index.fts_renormalized",
      issue: "#150",
      version: FTS_NORMALIZE_VERSION,
      cueCount,
      previousVersion: current ?? "unset",
    }),
  );
}

export function openSubtitleIndex(dbPath: string, options: SubtitleIndexOpenOptions = {}): SubtitleIndex {
  if (!options.readonly) {
    mkdirSync(dirname(dbPath), { recursive: true });
  }
  return new SubtitleIndex(dbPath, options);
}
