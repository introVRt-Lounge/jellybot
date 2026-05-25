import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS announced_releases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tag TEXT NOT NULL,
  announced_at TEXT NOT NULL DEFAULT (datetime('now'))
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

  close(): void {
    this.db.close();
  }
}
