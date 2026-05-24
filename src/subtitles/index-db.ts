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

export type IndexedCue = {
  startMs: number;
  endMs: number;
  text: string;
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

const SCHEMA = `
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
  FOREIGN KEY (item_id) REFERENCES media_items(item_id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS subtitle_cues_fts USING fts5(
  text,
  item_id UNINDEXED,
  content='subtitle_cues',
  content_rowid='id',
  tokenize='trigram'
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

CREATE INDEX IF NOT EXISTS idx_subtitle_cues_item_id ON subtitle_cues(item_id);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS subtitle_cues_ai AFTER INSERT ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(rowid, text, item_id) VALUES (new.id, new.text, new.item_id);
END;

CREATE TRIGGER IF NOT EXISTS subtitle_cues_ad AFTER DELETE ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text, item_id)
  VALUES ('delete', old.id, old.text, old.item_id);
END;

CREATE TRIGGER IF NOT EXISTS subtitle_cues_au AFTER UPDATE ON subtitle_cues BEGIN
  INSERT INTO subtitle_cues_fts(subtitle_cues_fts, rowid, text, item_id)
  VALUES ('delete', old.id, old.text, old.item_id);
  INSERT INTO subtitle_cues_fts(rowid, text, item_id) VALUES (new.id, new.text, new.item_id);
END;
`;

export class SubtitleIndex {
  private readonly db: Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.db.exec(FTS_TRIGGERS);
  }

  close(): void {
    this.db.close();
  }

  getStoredDateRefreshed(itemId: string): string | null {
    const row = this.db
      .query("SELECT item_date_refreshed FROM media_items WHERE item_id = ?")
      .get(itemId) as { item_date_refreshed: string | null } | null;
    return row?.item_date_refreshed ?? null;
  }

  replaceItem(item: IndexedMediaItem, cues: IndexedCue[]): number {
    const indexedAt = new Date().toISOString();
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
          cues.length,
        ],
      );

      const insertCue = this.db.query(
        "INSERT INTO subtitle_cues (item_id, start_ms, end_ms, text) VALUES (?, ?, ?, ?)",
      );

      for (const cue of cues) {
        insertCue.run(item.itemId, cue.startMs, cue.endMs, cue.text);
      }
    });

    tx();
    return cues.length;
  }

  searchQuotes(query: string, limit = 25): QuoteSearchResult[] {
    const ftsQuery = prepareFtsQuery(query);
    if (!ftsQuery) return [];

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
        WHERE subtitle_cues_fts MATCH ?
        ORDER BY rank
        LIMIT ?`,
      )
      .all(ftsQuery, limit) as QuoteSearchResult[];
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
    const cueCount = (this.db.query("SELECT COUNT(*) AS count FROM subtitle_cues").get() as { count: number }).count;
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
  return tokens.map((token) => `"${token.replace(/"/g, "")}"`).join(" ");
}

export function openSubtitleIndex(dbPath: string): SubtitleIndex {
  mkdirSync(dirname(dbPath), { recursive: true });
  return new SubtitleIndex(dbPath);
}
