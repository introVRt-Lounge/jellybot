import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS announced_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  announced_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS command_sync_state (
  scope_key TEXT PRIMARY KEY,
  body_hash TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

export class BotStateStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  getLastAnnouncedRelease(): string | null {
    const row = this.db
      .query<{ tag: string }, []>("SELECT tag FROM announced_releases ORDER BY announced_at DESC, id DESC LIMIT 1")
      .get();
    return row?.tag ?? null;
  }

  setLastAnnouncedRelease(tag: string): void {
    this.db
      .query("INSERT INTO announced_releases (tag) VALUES (?)")
      .run(tag);
  }

  getLastBodyHash(scopeKey: string): string | null {
    const row = this.db
      .query<{ body_hash: string }, [string]>(
        `SELECT body_hash FROM command_sync_state WHERE scope_key = ?`,
      )
      .get(scopeKey);
    return row?.body_hash ?? null;
  }

  setLastBodyHash(scopeKey: string, bodyHash: string): void {
    this.db
      .query(
        `INSERT INTO command_sync_state (scope_key, body_hash, updated_at)
         VALUES (?, ?, datetime('now'))
         ON CONFLICT(scope_key) DO UPDATE SET
           body_hash = excluded.body_hash,
           updated_at = excluded.updated_at`,
      )
      .run(scopeKey, bodyHash);
  }

  close(): void {
    this.db.close();
  }
}
