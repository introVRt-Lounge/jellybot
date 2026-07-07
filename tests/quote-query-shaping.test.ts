import { describe, expect, test, beforeEach } from "bun:test";
import type { QuoteSearchResult } from "../src/subtitles/index-db.ts";
import {
  clearQuoteMatchSearchCache,
  cueTextMatchesQueryTokens,
  extractDistinctiveTokens,
  extractQueryTokens,
  rememberQuoteMatchSearchCache,
  shapeQuoteAutocompleteQuery,
  tryQuoteMatchPrefixCache,
} from "../src/subtitles/quote-query-shaping.ts";

describe("shapeQuoteAutocompleteQuery", () => {
  test("passes through short queries unchanged", () => {
    expect(shapeQuoteAutocompleteQuery("flaunt it")).toBe("flaunt it");
  });

  test("passes through queries with at most five tokens", () => {
    expect(shapeQuoteAutocompleteQuery("that is it baby flaunt")).toBe("that is it baby flaunt");
  });

  test("uses trailing distinctive tokens for long quotes (issue #171 repro)", () => {
    const long =
      "that's it baby, if you've got it, flaunt it!";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("that baby flaunt");
  });

  test("keeps the last five distinctive tokens when many are present", () => {
    const long = "remember remember the fifth of november gunpowder treason and plot";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("fifth november gunpowder treason plot");
  });

  test("falls back to trailing raw tokens when no distinctive tokens exist", () => {
    expect(shapeQuoteAutocompleteQuery("a bb cc dd ee ff gg")).toBe("cc dd ee ff gg");
  });
});

describe("extractDistinctiveTokens", () => {
  test("drops short filler tokens", () => {
    expect(extractDistinctiveTokens("if you've got it flaunt")).toEqual(["flaunt"]);
  });
});

describe("extractQueryTokens", () => {
  test("keeps tokens of length two or more", () => {
    expect(extractQueryTokens("a bb cc")).toEqual(["bb", "cc"]);
  });
});

describe("cueTextMatchesQueryTokens", () => {
  test("requires every token to appear in cue text", () => {
    expect(cueTextMatchesQueryTokens("If you've got it, flaunt it!", ["flaunt", "baby"])).toBe(false);
    expect(cueTextMatchesQueryTokens("that's it baby, flaunt it!", ["baby", "flaunt"])).toBe(true);
  });
});

describe("quote match prefix cache", () => {
  const cacheKey = "user:guild:quote:match";

  const sampleResult = (text: string): QuoteSearchResult => ({
    itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    itemType: "Movie",
    title: "The Producers",
    startMs: 1000,
    endMs: 2000,
    text,
    rank: 1,
  });

  beforeEach(() => {
    clearQuoteMatchSearchCache();
  });

  test("returns null when cache is empty", () => {
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt", "flaunt")).toBeNull();
  });

  test("filters cached results when raw query extends previous prefix", () => {
    rememberQuoteMatchSearchCache(cacheKey, "flaunt", "flaunt", [
      sampleResult("If you've got it, flaunt it!"),
      sampleResult("Something else entirely"),
    ]);

    const filtered = tryQuoteMatchPrefixCache(cacheKey, "flaunt it", "flaunt it");
    expect(filtered?.map((r) => r.text)).toEqual(["If you've got it, flaunt it!"]);
  });

  test("returns null when extension does not match any cached cue", () => {
    rememberQuoteMatchSearchCache(cacheKey, "flaunt", "flaunt", [sampleResult("If you've got it, flaunt it!")]);
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt baby", "flaunt baby")).toBeNull();
  });
});
