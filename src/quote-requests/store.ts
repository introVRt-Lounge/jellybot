import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type QuoteRequestStatus = "pending" | "fulfilled" | "abandoned";

export type AcquisitionKind = "none" | "radarr" | "sonarr";
export type AcquisitionStatus =
  | "not_requested"
  | "searching"
  | "downloading"
  | "imported"
  | "indexed"
  | "failed";

export type QuoteRequestRow = {
  id: number;
  requesterDiscordId: string;
  requesterName: string;
  guildId: string;
  channelId: string;
  movieText: string;
  quoteText: string;
  status: QuoteRequestStatus;
  fulfilledItemId: string | null;
  fulfilledMatchToken: string | null;
  fulfilledNotificationMessageId: string | null;
  fulfilledAt: string | null;
  createdAt: string;
  acquisitionKind: AcquisitionKind;
  acquisitionExternalId: number | null;
  acquisitionStatus: AcquisitionStatus;
  acquisitionMetadata: string | null;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS quote_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  requester_discord_id TEXT NOT NULL,
  requester_name TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  movie_text TEXT NOT NULL,
  quote_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'fulfilled', 'abandoned')),
  fulfilled_item_id TEXT,
  fulfilled_match_token TEXT,
  fulfilled_notification_message_id TEXT,
  fulfilled_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  acquisition_kind TEXT NOT NULL DEFAULT 'none'
    CHECK (acquisition_kind IN ('none', 'radarr', 'sonarr')),
  acquisition_external_id INTEGER,
  acquisition_status TEXT NOT NULL DEFAULT 'not_requested'
    CHECK (acquisition_status IN ('not_requested', 'searching', 'downloading', 'imported', 'indexed', 'failed')),
  acquisition_metadata TEXT
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_status_created
  ON quote_requests (status, created_at);
`;

const MIGRATIONS = [
  `ALTER TABLE quote_requests ADD COLUMN acquisition_kind TEXT NOT NULL DEFAULT 'none'`,
  `ALTER TABLE quote_requests ADD COLUMN acquisition_external_id INTEGER`,
  `ALTER TABLE quote_requests ADD COLUMN acquisition_status TEXT NOT NULL DEFAULT 'not_requested'`,
  `ALTER TABLE quote_requests ADD COLUMN acquisition_metadata TEXT`,
];

type Row = {
  id: number;
  requester_discord_id: string;
  requester_name: string;
  guild_id: string;
  channel_id: string;
  movie_text: string;
  quote_text: string;
  status: string;
  fulfilled_item_id: string | null;
  fulfilled_match_token: string | null;
  fulfilled_notification_message_id: string | null;
  fulfilled_at: string | null;
  created_at: string;
  acquisition_kind: string;
  acquisition_external_id: number | null;
  acquisition_status: string;
  acquisition_metadata: string | null;
};

const SELECT_COLUMNS = `id, requester_discord_id, requester_name, guild_id, channel_id,
        movie_text, quote_text, status,
        fulfilled_item_id, fulfilled_match_token, fulfilled_notification_message_id,
        fulfilled_at, created_at,
        acquisition_kind, acquisition_external_id, acquisition_status, acquisition_metadata`;

export class QuoteRequestStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
    this.runMigrations();
  }

  private runMigrations(): void {
    for (const sql of MIGRATIONS) {
      try {
        this.db.exec(sql);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!/duplicate column name/i.test(message)) {
          throw error;
        }
      }
    }
  }

  insert(input: {
    requesterDiscordId: string;
    requesterName: string;
    guildId: string;
    channelId: string;
    movieText: string;
    quoteText: string;
    acquisitionKind?: AcquisitionKind;
    acquisitionExternalId?: number;
    acquisitionStatus?: AcquisitionStatus;
    acquisitionMetadata?: string;
  }): QuoteRequestRow {
    const acquisitionKind = input.acquisitionKind ?? "none";
    const acquisitionStatus = input.acquisitionStatus ?? "not_requested";
    const acquisitionExternalId = input.acquisitionExternalId ?? null;
    const acquisitionMetadata = input.acquisitionMetadata ?? null;

    const result = this.db
      .query<
        { id: number },
        [string, string, string, string, string, string, string, number | null, string, string | null]
      >(
        `INSERT INTO quote_requests
         (requester_discord_id, requester_name, guild_id, channel_id, movie_text, quote_text,
          acquisition_kind, acquisition_external_id, acquisition_status, acquisition_metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.requesterDiscordId,
        input.requesterName,
        input.guildId,
        input.channelId,
        input.movieText,
        input.quoteText,
        acquisitionKind,
        acquisitionExternalId,
        acquisitionStatus,
        acquisitionMetadata,
      );

    if (!result) {
      throw new Error("Failed to insert quote request");
    }

    const row = this.getById(result.id);
    if (!row) {
      throw new Error("Inserted quote request vanished");
    }
    return row;
  }

  getById(id: number): QuoteRequestRow | null {
    return this.mapRow(
      this.db
        .query<Row, [number]>(`SELECT ${SELECT_COLUMNS} FROM quote_requests WHERE id = ?`)
        .get(id),
    );
  }

  listPending(limit = 200): QuoteRequestRow[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT ${SELECT_COLUMNS}
         FROM quote_requests
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => this.mapRow(row)!);
  }

  listAcquiring(limit = 200): QuoteRequestRow[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT ${SELECT_COLUMNS}
         FROM quote_requests
         WHERE status = 'pending'
           AND acquisition_kind != 'none'
           AND acquisition_status NOT IN ('failed', 'indexed')
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => this.mapRow(row)!);
  }

  /**
   * Rows that signalled an intent to use Sonarr/Radarr but never got the
   * external acquisition kicked off (most commonly: integration was offline at
   * submit time). Reconciler replays these once the integration is wired.
   */
  listDeferredAcquisitions(limit = 200): QuoteRequestRow[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT ${SELECT_COLUMNS}
         FROM quote_requests
         WHERE status = 'pending'
           AND acquisition_kind IN ('sonarr', 'radarr')
           AND acquisition_external_id IS NULL
           AND acquisition_status = 'not_requested'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => this.mapRow(row)!);
  }

  setAcquisitionStatus(input: {
    id: number;
    status: AcquisitionStatus;
    metadata?: string | null;
    externalId?: number;
  }): void {
    const setExternalId = input.externalId !== undefined;
    const setMetadata = input.metadata !== undefined;

    if (!setExternalId && !setMetadata) {
      this.db
        .query(`UPDATE quote_requests SET acquisition_status = ? WHERE id = ?`)
        .run(input.status, input.id);
      return;
    }

    if (setExternalId && setMetadata) {
      this.db
        .query(
          `UPDATE quote_requests
             SET acquisition_status = ?, acquisition_external_id = ?, acquisition_metadata = ?
             WHERE id = ?`,
        )
        .run(input.status, input.externalId!, input.metadata!, input.id);
      return;
    }

    if (setExternalId) {
      this.db
        .query(
          `UPDATE quote_requests SET acquisition_status = ?, acquisition_external_id = ? WHERE id = ?`,
        )
        .run(input.status, input.externalId!, input.id);
      return;
    }

    this.db
      .query(
        `UPDATE quote_requests SET acquisition_status = ?, acquisition_metadata = ? WHERE id = ?`,
      )
      .run(input.status, input.metadata!, input.id);
  }

  countPendingForRequester(requesterDiscordId: string): number {
    const row = this.db
      .query<{ n: number }, [string]>(
        `SELECT COUNT(*) AS n FROM quote_requests
         WHERE requester_discord_id = ? AND status = 'pending'`,
      )
      .get(requesterDiscordId);
    return row?.n ?? 0;
  }

  markFulfilled(input: {
    id: number;
    itemId: string;
    matchToken: string;
    notificationMessageId: string | null;
  }): void {
    this.db
      .query(
        `UPDATE quote_requests
         SET status = 'fulfilled',
             fulfilled_item_id = ?,
             fulfilled_match_token = ?,
             fulfilled_notification_message_id = ?,
             fulfilled_at = datetime('now')
         WHERE id = ? AND status = 'pending'`,
      )
      .run(input.itemId, input.matchToken, input.notificationMessageId, input.id);
  }

  markAbandoned(id: number): void {
    this.db
      .query(`UPDATE quote_requests SET status = 'abandoned' WHERE id = ? AND status = 'pending'`)
      .run(id);
  }

  close(): void {
    this.db.close();
  }

  private mapRow(row: Row | null | undefined): QuoteRequestRow | null {
    if (!row) {
      return null;
    }
    return {
      id: row.id,
      requesterDiscordId: row.requester_discord_id,
      requesterName: row.requester_name,
      guildId: row.guild_id,
      channelId: row.channel_id,
      movieText: row.movie_text,
      quoteText: row.quote_text,
      status: row.status as QuoteRequestStatus,
      fulfilledItemId: row.fulfilled_item_id,
      fulfilledMatchToken: row.fulfilled_match_token,
      fulfilledNotificationMessageId: row.fulfilled_notification_message_id,
      fulfilledAt: row.fulfilled_at,
      createdAt: row.created_at,
      acquisitionKind: row.acquisition_kind as AcquisitionKind,
      acquisitionExternalId: row.acquisition_external_id,
      acquisitionStatus: row.acquisition_status as AcquisitionStatus,
      acquisitionMetadata: row.acquisition_metadata,
    };
  }
}
