import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FeatureStore, rankPointsForPosition } from "../src/features/feature-store.ts";

describe("FeatureStore", () => {
  const paths: string[] = [];

  afterEach(() => {
    for (const path of paths) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  });

  function makeStore(): FeatureStore {
    const path = join(tmpdir(), `feature-store-${Date.now()}-${Math.random()}.db`);
    paths.push(path);
    return new FeatureStore(path);
  }

  test("aggregates ranked votes with 3/2/1 scoring", () => {
    const store = makeStore();
    const first = store.insertSuggestion({
      githubIssueNumber: 101,
      title: "[feat]: Karaoke subs",
      description: "Burn karaoke subtitles from Jellyfin clips",
      suggesterDiscordId: "1",
      suggesterName: "A",
      guildId: "guild",
      scopeSummary: "ok",
    });
    const second = store.insertSuggestion({
      githubIssueNumber: 102,
      title: "[feat]: Actor search",
      description: "Search Jellyfin quotes by actor metadata",
      suggesterDiscordId: "2",
      suggesterName: "B",
      guildId: "guild",
      scopeSummary: "ok",
    });

    store.setRank("voter-a", 1, first.id);
    store.setRank("voter-a", 2, second.id);
    store.setRank("voter-b", 1, second.id);

    const scores = store.getScoresForGuild("guild");
    expect(scores[0]?.githubIssueNumber).toBe(102);
    expect(scores[0]?.points).toBe(5);
    expect(scores[1]?.githubIssueNumber).toBe(101);
    expect(scores[1]?.points).toBe(3);
    store.close();
  });

  test("rankPointsForPosition uses 3/2/1", () => {
    expect(rankPointsForPosition(1)).toBe(3);
    expect(rankPointsForPosition(2)).toBe(2);
    expect(rankPointsForPosition(3)).toBe(1);
  });

  test("leaderboard message id round trips", () => {
    const store = makeStore();
    expect(store.getLeaderboardMessageId("guild-a")).toBeNull();
    store.setLeaderboardMessageId("guild-a", "msg-123");
    expect(store.getLeaderboardMessageId("guild-a")).toBe("msg-123");
    store.close();
  });
});
