import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
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
  test("tokenizes multi-word queries", () => {
    expect(prepareFtsQuery("love finds its way")).toBe('"love" "finds" "its" "way"');
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
});
