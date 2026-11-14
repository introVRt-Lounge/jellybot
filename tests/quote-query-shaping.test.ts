import { describe, expect, test, beforeEach } from "bun:test";
import type { QuoteSearchResult } from "../src/subtitles/index-db.ts";
import {
  clearQuoteMatchSearchCache,
  cueTextMatchesQueryTokens,
  extractDistinctiveTokens,
  extractQueryTokens,
  isLastTokenPrefixExtension,
  rankQuoteAutocompleteResults,
  rememberQuoteMatchSearchCache,
  shapeQuoteAutocompleteQuery,
  tryQuoteMatchPrefixCache,
} from "../src/subtitles/quote-query-shaping.ts";

describe("shapeQuoteAutocompleteQuery", () => {
  test("drops stop words from short spoken lines (issue #216)", () => {
    expect(shapeQuoteAutocompleteQuery("flaunt it")).toBe("flaunt");
    expect(shapeQuoteAutocompleteQuery("i'm here for the gang bang")).toBe("gang bang");
  });

  test("keeps stop words when they are the only tokens", () => {
    expect(shapeQuoteAutocompleteQuery("for the")).toBe("for the");
  });

  test("drops stop words from queries with at most five tokens", () => {
    expect(shapeQuoteAutocompleteQuery("that is it baby flaunt")).toBe("baby flaunt");
  });

  test("uses trailing distinctive tokens for long quotes (issue #171 repro)", () => {
    const long =
      "that's it baby, if you've got it, flaunt it!";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("baby flaunt");
  });

  test("preserves an in-progress short final token while shaping long quotes", () => {
    const long = "that's it baby if you've got it fla";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("baby fla");
  });

  test("does not drop a short final token that is only a suffix of the last shaped word", () => {
    // "ha" is not a stop word; still preserve in-progress short finals (#171 / #216).
    const long = "alpha bravo charlie delta bathe ha";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("alpha bravo charlie delta bathe ha");
  });

  test("keeps a short final token that only prefixes the last shaped word", () => {
    const long = "alpha bravo charlie delta echo foxtrot heart ha";
    expect(shapeQuoteAutocompleteQuery(long)).toBe("charlie delta echo foxtrot heart ha");
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

  test("matches hyphenated cues via de-hyphenated compound tokens", () => {
    expect(cueTextMatchesQueryTokens("No! It was heart-warming.", ["heartwarm"])).toBe(true);
    expect(cueTextMatchesQueryTokens("No! It was heart-warming.", ["heart", "warm"])).toBe(true);
  });
});

describe("rankQuoteAutocompleteResults", () => {
  const sample = (
    text: string,
    title: string,
    rank: number,
  ): QuoteSearchResult => ({
    itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    itemType: "Movie",
    title,
    startMs: 1000,
    endMs: 2000,
    text,
    rank,
  });

  test("promotes exact Old School line over short TV gang-bang hits (#220)", () => {
    // bm25 order after stop-word strip (#216): short fragments win; exact cue is last.
    const bm25Order = [
      sample("gang bang.", "Fleabag", -23.5),
      sample("It's gang bang this and gang bang that.", "Eurotrash", -22.8),
      sample("biggest gang bang.", "Eurotrash", -22.3),
      sample("Gang bangs. And such.", "Sleeping with Other People", -21.2),
      sample("I'm here for the gang bang.", "Old School", -18.5),
    ];

    const ranked = rankQuoteAutocompleteResults(
      "I'm here for the gang bang",
      bm25Order,
    );

    expect(ranked[0]?.title).toBe("Old School");
    expect(ranked[0]?.text).toBe("I'm here for the gang bang.");
  });

  test("keeps bm25 order when raw-token overlap is tied", () => {
    const tied = [
      sample("gang bang.", "Fleabag", -23.5),
      sample("biggest gang bang.", "Eurotrash", -22.3),
    ];
    const ranked = rankQuoteAutocompleteResults("gang bang", tied);
    expect(ranked.map((r) => r.title)).toEqual(["Fleabag", "Eurotrash"]);
  });
});

describe("quote match prefix cache", () => {
  const cacheKey = "user:guild:quote:match:the producers";

  const sampleResult = (text: string): QuoteSearchResult => ({
    itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    itemType: "Movie",
    title: "s:the producers",
    startMs: 1000,
    endMs: 2000,
    text,
    rank: 1,
  });

  beforeEach(() => {
    clearQuoteMatchSearchCache();
  });

  test("returns null when cache is empty", () => {
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt", "flaunt", "s:the producers")).toBeNull();
  });

  test("filters cached results when the final token is extended", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "fla",
      "fla",
      [sampleResult("If you've got it, flaunt it!"), sampleResult("Something else entirely")],
      "s:the producers",
    );

    const filtered = tryQuoteMatchPrefixCache(cacheKey, "flau", "flau", "s:the producers");
    expect(filtered?.map((r) => r.text)).toEqual(["If you've got it, flaunt it!"]);
  });

  test("returns null when shaped search terms change", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "alpha bravo charlie delta echo fla",
      "alpha bravo charlie delta echo fla",
      [sampleResult("alpha bravo charlie delta echo flaunt")],
      "s:the producers",
    );
    expect(
      tryQuoteMatchPrefixCache(
        cacheKey,
        "alpha bravo charlie delta echo flau",
        "bravo charlie delta echo flau",
        "s:the producers",
      ),
    ).toBeNull();
  });

  test("returns null when a new token is added instead of extending the last one", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "flaunt",
      "flaunt",
      [sampleResult("If you've got it, flaunt it!")],
      "s:the producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flaunt it", "flaunt it", "s:the producers")).toBeNull();
  });

  test("returns null when the from scope changes", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "fla",
      "fla",
      [sampleResult("If you've got it, flaunt it!")],
      "s:the producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flau", "flau", "s:other show")).toBeNull();
  });

  test("returns null when extension does not match any cached cue", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "flaunt",
      "flaunt",
      [sampleResult("If you've got it, flaunt it!")],
      "s:the producers",
    );
    expect(tryQuoteMatchPrefixCache(cacheKey, "flauntx", "flauntx", "s:the producers")).toBeNull();
  });

  test("reuses cached hyphenated cues when the query extends a de-hyphenated prefix", () => {
    rememberQuoteMatchSearchCache(
      cacheKey,
      "heartwarm",
      "heartwarm",
      [sampleResult("No! It was heart-warming.")],
      "s:the producers",
    );

    const filtered = tryQuoteMatchPrefixCache(cacheKey, "heartwarmin", "heartwarmin", "s:the producers");
    expect(filtered?.map((r) => r.text)).toEqual(["No! It was heart-warming."]);
  });
});
