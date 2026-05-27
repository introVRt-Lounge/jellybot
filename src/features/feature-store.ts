import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { Database } from "bun:sqlite";

export type FeatureSuggestionRow = {
  id: number;
  githubIssueNumber: number;
  title: string;
  description: string;
  suggesterDiscordId: string;
  suggesterName: string;
  guildId: string;
  channelMessageId: string | null;
  status: "open" | "building" | "shipped" | "rejected";
  scopeSummary: string | null;
  createdAt: string;
};

export type FeatureScoreRow = {
  suggestionId: number;
  githubIssueNumber: number;
  title: string;
  points: number;
  voterCount: number;
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS feature_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  github_issue_number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  suggester_discord_id TEXT NOT NULL,
  suggester_name TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  channel_message_id TEXT,
  status TEXT NOT NULL DEFAULT 'open',
  scope_summary TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS feature_ranks (
  suggestion_id INTEGER NOT NULL,
  voter_discord_id TEXT NOT NULL,
  rank_position INTEGER NOT NULL CHECK (rank_position BETWEEN 1 AND 3),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (voter_discord_id, rank_position),
  FOREIGN KEY (suggestion_id) REFERENCES feature_suggestions(id)
);

CREATE TABLE IF NOT EXISTS feature_meta (
  guild_id TEXT NOT NULL,
  meta_key TEXT NOT NULL,
  meta_value TEXT NOT NULL,
  PRIMARY KEY (guild_id, meta_key)
);
`;

export class FeatureStore {
  private readonly db: Database;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec(SCHEMA);
  }

  insertSuggestion(input: {
    githubIssueNumber: number;
    title: string;
    description: string;
    suggesterDiscordId: string;
    suggesterName: string;
    guildId: string;
    scopeSummary: string | null;
  }): FeatureSuggestionRow {
    this.db
      .query(
        `INSERT INTO feature_suggestions
         (github_issue_number, title, description, suggester_discord_id, suggester_name, guild_id, scope_summary)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.githubIssueNumber,
        input.title,
        input.description,
        input.suggesterDiscordId,
        input.suggesterName,
        input.guildId,
        input.scopeSummary,
      );

    const row = this.getByGithubIssueNumber(input.githubIssueNumber);
    if (!row) {
      throw new Error("Failed to load inserted suggestion");
    }
    return row;
  }

  getById(id: number): FeatureSuggestionRow | null {
    return this.mapSuggestion(
      this.db
        .query<
          {
            id: number;
            github_issue_number: number;
            title: string;
            description: string;
            suggester_discord_id: string;
            suggester_name: string;
            guild_id: string;
            channel_message_id: string | null;
            status: string;
            scope_summary: string | null;
            created_at: string;
          },
          [number]
        >(
          `SELECT id, github_issue_number, title, description, suggester_discord_id, suggester_name,
                  guild_id, channel_message_id, status, scope_summary, created_at
           FROM feature_suggestions WHERE id = ?`,
        )
        .get(id),
    );
  }

  getByGithubIssueNumber(githubIssueNumber: number): FeatureSuggestionRow | null {
    return this.mapSuggestion(
      this.db
        .query<
          {
            id: number;
            github_issue_number: number;
            title: string;
            description: string;
            suggester_discord_id: string;
            suggester_name: string;
            guild_id: string;
            channel_message_id: string | null;
            status: string;
            scope_summary: string | null;
            created_at: string;
          },
          [number]
        >(
          `SELECT id, github_issue_number, title, description, suggester_discord_id, suggester_name,
                  guild_id, channel_message_id, status, scope_summary, created_at
           FROM feature_suggestions WHERE github_issue_number = ?`,
        )
        .get(githubIssueNumber),
    );
  }

  listOpenForGuild(guildId: string, limit = 25): FeatureSuggestionRow[] {
    const rows = this.db
      .query<
        {
          id: number;
          github_issue_number: number;
          title: string;
          description: string;
          suggester_discord_id: string;
          suggester_name: string;
          guild_id: string;
          channel_message_id: string | null;
          status: string;
          scope_summary: string | null;
          created_at: string;
        },
        [string, number]
      >(
        `SELECT id, github_issue_number, title, description, suggester_discord_id, suggester_name,
                guild_id, channel_message_id, status, scope_summary, created_at
         FROM feature_suggestions
         WHERE guild_id = ? AND status = 'open'
         ORDER BY created_at DESC
         LIMIT ?`,
      )
      .all(guildId, limit);

    return rows.map((row) => this.mapSuggestion(row)!);
  }

  setChannelMessageId(id: number, channelMessageId: string): void {
    this.db
      .query(`UPDATE feature_suggestions SET channel_message_id = ? WHERE id = ?`)
      .run(channelMessageId, id);
  }

  setStatus(id: number, status: FeatureSuggestionRow["status"]): void {
    this.db.query(`UPDATE feature_suggestions SET status = ? WHERE id = ?`).run(status, id);
  }

  setRank(voterDiscordId: string, rankPosition: number, suggestionId: number): void {
    this.db
      .query(
        `INSERT INTO feature_ranks (suggestion_id, voter_discord_id, rank_position, updated_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(voter_discord_id, rank_position)
         DO UPDATE SET suggestion_id = excluded.suggestion_id, updated_at = datetime('now')`,
      )
      .run(suggestionId, voterDiscordId, rankPosition);
  }

  clearRanksForVoter(voterDiscordId: string): void {
    this.db.query(`DELETE FROM feature_ranks WHERE voter_discord_id = ?`).run(voterDiscordId);
  }

  getScoresForGuild(guildId: string): FeatureScoreRow[] {
    const rows = this.db
      .query<
        {
          suggestion_id: number;
          github_issue_number: number;
          title: string;
          points: number;
          voter_count: number;
        },
        [string]
      >(
        `SELECT s.id AS suggestion_id, s.github_issue_number, s.title,
                COALESCE(SUM(CASE fr.rank_position WHEN 1 THEN 3 WHEN 2 THEN 2 WHEN 3 THEN 1 ELSE 0 END), 0) AS points,
                COUNT(DISTINCT fr.voter_discord_id) AS voter_count
         FROM feature_suggestions s
         LEFT JOIN feature_ranks fr ON fr.suggestion_id = s.id
         WHERE s.guild_id = ? AND s.status = 'open'
         GROUP BY s.id
         ORDER BY points DESC, s.created_at ASC`,
      )
      .all(guildId);

    return rows.map((row) => ({
      suggestionId: row.suggestion_id,
      githubIssueNumber: row.github_issue_number,
      title: row.title,
      points: row.points,
      voterCount: row.voter_count,
    }));
  }

  getLeaderboardMessageId(guildId: string): string | null {
    const row = this.db
      .query<{ meta_value: string }, [string, string]>(
        `SELECT meta_value FROM feature_meta WHERE guild_id = ? AND meta_key = 'leaderboard_message_id'`,
      )
      .get(guildId, "leaderboard_message_id");
    return row?.meta_value ?? null;
  }

  setLeaderboardMessageId(guildId: string, messageId: string): void {
    this.db
      .query(
        `INSERT INTO feature_meta (guild_id, meta_key, meta_value) VALUES (?, 'leaderboard_message_id', ?)
         ON CONFLICT(guild_id, meta_key) DO UPDATE SET meta_value = excluded.meta_value`,
      )
      .run(guildId, messageId);
  }

  close(): void {
    this.db.close();
  }

  private mapSuggestion(
    row:
      | {
          id: number;
          github_issue_number: number;
          title: string;
          description: string;
          suggester_discord_id: string;
          suggester_name: string;
          guild_id: string;
          channel_message_id: string | null;
          status: string;
          scope_summary: string | null;
          created_at: string;
        }
      | null
      | undefined,
  ): FeatureSuggestionRow | null {
    if (!row) {
      return null;
    }
    const status = row.status as FeatureSuggestionRow["status"];
    return {
      id: row.id,
      githubIssueNumber: row.github_issue_number,
      title: row.title,
      description: row.description,
      suggesterDiscordId: row.suggester_discord_id,
      suggesterName: row.suggester_name,
      guildId: row.guild_id,
      channelMessageId: row.channel_message_id,
      status,
      scopeSummary: row.scope_summary,
      createdAt: row.created_at,
    };
  }
}

export function rankPointsForPosition(rankPosition: number): number {
  if (rankPosition === 1) return 3;
  if (rankPosition === 2) return 2;
  if (rankPosition === 3) return 1;
  return 0;
}
