import { describe, expect, test, beforeEach } from "bun:test";
import type { QuoteSearchResult } from "../src/subtitles/index-db.ts";
import {
  clearQuoteMatchSearchCache,
  cueTextMatchesQueryTokens,
  extractDistinctiveTokens,
  extractQueryTokens,
  isLastTokenPrefixExtension,
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

  test("preserves an in-progress short final token while shaping long quotes", () => {
    const long = "that's it baby if you've got it fla";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("that baby fla");
  });

  test("does not drop a short final token that is only a suffix of the last shaped word", () => {
    const long = "alpha bravo charlie delta bathe he";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("alpha bravo charlie delta bathe he");
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

describe("isLastTokenPrefixExtension", () => {
  test("detects when only the final token grew", () => {
    expect(isLastTokenPrefixExtension("flaunt", "flaun")).toBe(false);
    expect(isLastTokenPrefixExtension("fla", "flau")).toBe(true);
    expect(isLastTokenPrefixExtension("flaunt", "flaunt it")).toBe(false);
  });
});

describe("cueTextMatchesQueryTokens", () => {
  test("requires whole-token matches, not substring hits inside other words", () => {
    expect(cueTextMatchesQueryTokens("the cat sat", ["the", "he"])).toBe(false);
    expect(cueTextMatchesQueryTokens("the help desk", ["the", "he"])).toBe(true);
  });

  test("allows prefix match on the final token only", () => {
    expect(cueTextMatchesQueryTokens("If you've got it, flaunt it!", ["flaunt", "baby"])).toBe(false);
    expect(cueTextMatchesQueryTokens("that's it baby, flaunt it!", ["baby", "fla"])).toBe(true);
  });
});

describe("quote match prefix cache", () => {
  const cacheKey = "user:guild:quote:match:the producers";

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
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt", "flaunt", "The Producers")).toBeNull();
  });

  test("filters cached results when the final token is extended", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "fla",
      "fla",
      [sampleResult("If you've got it, flaunt it!"), sampleResult("Something else entirely")],
      "The Producers",
    );

    const filtered = tryQuoteMatchPrefixCache(cacheKey, "flau", "flau", "The Producers");
    expect(filtered?.map((r) => r.text)).toEqual(["If you've got it, flaunt it!"]);
  });

  test("returns null when shaped search terms change", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "alpha bravo charlie delta echo fla",
      "alpha bravo charlie delta echo fla",
      [sampleResult("alpha bravo charlie delta echo flaunt")],
      "The Producers",
    );
    expect(
      tryQuoteMatchPrefixCache(
        cacheKey,
        "alpha bravo charlie delta echo flau",
        "bravo charlie delta echo flau",
        "The Producers",
      ),
    ).toBeNull();
  });

  test("returns null when a new token is added instead of extending the last one", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "flaunt",
      "flaunt",
      [sampleResult("If you've got it, flaunt it!")],
      "The Producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt it", "flaunt it", "The Producers")).toBeNull();
  });

  test("returns null when the series scope changes", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "fla",
      "fla",
      [sampleResult("If you've got it, flaunt it!")],
      "The Producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flau", "flau", "Other Show")).toBeNull();
  });

  test("returns null when extension does not match any cached cue", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "flaunt",
      "flaunt",
      [sampleResult("If you've got it, flaunt it!")],
      "The Producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flauntx", "flauntx", "The Producers")).toBeNull();
  });
});
