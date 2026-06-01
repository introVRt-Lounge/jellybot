import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type QuoteRequestStatus = "pending" | "fulfilled" | "abandoned";

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
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_quote_requests_status_created
  ON quote_requests (status, created_at);
`;

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
};

export class QuoteRequestStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  insert(input: {
    requesterDiscordId: string;
    requesterName: string;
    guildId: string;
    channelId: string;
    movieText: string;
    quoteText: string;
  }): QuoteRequestRow {
    const result = this.db
      .query<{ id: number }, [string, string, string, string, string, string]>(
        `INSERT INTO quote_requests
         (requester_discord_id, requester_name, guild_id, channel_id, movie_text, quote_text)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        input.requesterDiscordId,
        input.requesterName,
        input.guildId,
        input.channelId,
        input.movieText,
        input.quoteText,
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
        .query<Row, [number]>(
          `SELECT id, requester_discord_id, requester_name, guild_id, channel_id,
                  movie_text, quote_text, status,
                  fulfilled_item_id, fulfilled_match_token, fulfilled_notification_message_id,
                  fulfilled_at, created_at
           FROM quote_requests WHERE id = ?`,
        )
        .get(id),
    );
  }

  listPending(limit = 200): QuoteRequestRow[] {
    const rows = this.db
      .query<Row, [number]>(
        `SELECT id, requester_discord_id, requester_name, guild_id, channel_id,
                movie_text, quote_text, status,
                fulfilled_item_id, fulfilled_match_token, fulfilled_notification_message_id,
                fulfilled_at, created_at
         FROM quote_requests
         WHERE status = 'pending'
         ORDER BY created_at ASC
         LIMIT ?`,
      )
      .all(limit);

    return rows.map((row) => this.mapRow(row)!);
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
    };
  }
}
