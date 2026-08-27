import { afterEach, describe, expect, test } from "bun:test";
import { unlinkSync } from "node:fs";
import { openSubtitleIndex } from "../src/subtitles/index-db.ts";
import { resetSubtitleSearchIndexForTests } from "../src/subtitles/search-index.ts";
import {
  buildQuoteSuggestions,
  minQuoteQueryLength,
  searchQuoteSuggestions,
} from "../src/services/quote-search-service.ts";

const dbPath = `/tmp/jellybot-quote-search-${crypto.randomUUID()}.db`;

afterEach(() => {
  resetSubtitleSearchIndexForTests();
  try {
    unlinkSync(dbPath);
  } catch {
    // ignore
  }
});

describe("quote search service", () => {
  test("builds stable suggestion tokens", () => {
    const suggestions = buildQuoteSuggestions([
      {
        itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        itemType: "Movie",
        title: "Demo",
        startMs: 1000,
        endMs: 2000,
        text: "hello there",
      },
    ]);

    expect(suggestions[0]?.token).toBe("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:1000:2000");
    expect(suggestions[0]?.label).toContain("Demo");
  });

  test("searches indexed quotes", () => {
    const index = openSubtitleIndex(dbPath);
    try {
      index.replaceItem(
        {
          itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          itemType: "Movie",
          title: "Indexed",
          productionYear: 2021,
          mediaSourceId: "src",
          subtitleIndex: 0,
        },
        [{ startMs: 5000, endMs: 6000, text: "general kenobi" }],
      );
    } finally {
      index.close();
    }

    const suggestions = searchQuoteSuggestions(dbPath, "general");
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0]?.text).toContain("general kenobi");
  });

  test("uses shorter minimum query length with a series filter", () => {
    expect(minQuoteQueryLength()).toBe(3);
    expect(minQuoteQueryLength("The IT Crowd")).toBe(1);
  });
});
