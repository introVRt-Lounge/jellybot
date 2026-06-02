import { describe, expect, test } from "bun:test";
import {
  findQuoteRequestMatch,
  normaliseTitle,
} from "../src/quote-requests/matcher.ts";
import type { QuoteSearchResult } from "../src/subtitles/index-db.ts";

function searchIndex(results: QuoteSearchResult[]): { searchQuotes: (q: string, n?: number) => QuoteSearchResult[] } {
  return {
    searchQuotes: () => results,
  };
}

const happyGilmoreCue: QuoteSearchResult = {
  itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  itemType: "Movie",
  title: "Happy Gilmore",
  productionYear: 1996,
  startMs: 60_000,
  endMs: 65_000,
  text: "I eat pieces of shit like you for breakfast",
  rank: -8.2,
};

const lebowskiCue: QuoteSearchResult = {
  itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  itemType: "Movie",
  title: "The Big Lebowski",
  productionYear: 1998,
  startMs: 30_000,
  endMs: 33_000,
  text: "this aggression will not stand, man",
  rank: -7.1,
};

const seinfeldCue: QuoteSearchResult = {
  itemId: "cccccccccccccccccccccccccccccccc",
  itemType: "Episode",
  title: "The Marine Biologist",
  seriesName: "Seinfeld",
  seasonNumber: 5,
  episodeNumber: 14,
  startMs: 100_000,
  endMs: 104_000,
  text: "the sea was angry that day my friends",
  rank: -6.5,
};

describe("findQuoteRequestMatch", () => {
  test("returns high confidence on exact title and quote match", () => {
    const result = findQuoteRequestMatch(
      searchIndex([happyGilmoreCue]),
      "Happy Gilmore",
      "I eat pieces of shit like you for breakfast",
    );

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("high");
    expect(result?.candidate.itemId).toBe(happyGilmoreCue.itemId);
  });

  test("returns medium confidence when movie text is substring of title", () => {
    const result = findQuoteRequestMatch(
      searchIndex([lebowskiCue]),
      "Lebowski",
      "aggression will not stand",
    );
    expect(result).not.toBeNull();
    expect(["medium", "high"]).toContain(result!.confidence);
  });

  test("uses series name for episode title matching", () => {
    const result = findQuoteRequestMatch(
      searchIndex([seinfeldCue]),
      "Seinfeld",
      "the sea was angry",
    );
    expect(result).not.toBeNull();
    expect(result?.candidate.itemId).toBe(seinfeldCue.itemId);
  });

  test("returns null when title does not match any candidate", () => {
    const result = findQuoteRequestMatch(
      searchIndex([happyGilmoreCue]),
      "Caddyshack",
      "I eat pieces of shit like you for breakfast",
    );
    expect(result).toBeNull();
  });

  test("returns null when no candidates", () => {
    const result = findQuoteRequestMatch(
      searchIndex([]),
      "Whatever",
      "some quote",
    );
    expect(result).toBeNull();
  });

  test("picks the best title score across candidates", () => {
    const partialMatch = { ...lebowskiCue, title: "The Big Lebowski (Director's Cut)" };
    const exactMatch = { ...happyGilmoreCue };

    const result = findQuoteRequestMatch(
      searchIndex([partialMatch, exactMatch]),
      "Happy Gilmore",
      "breakfast",
    );

    expect(result?.candidate.itemId).toBe(exactMatch.itemId);
  });

  test("rejects empty quote", () => {
    const result = findQuoteRequestMatch(
      searchIndex([happyGilmoreCue]),
      "Happy Gilmore",
      "   ",
    );
    expect(result).toBeNull();
  });

  test("rejects empty movie text", () => {
    const result = findQuoteRequestMatch(
      searchIndex([happyGilmoreCue]),
      "  ",
      "breakfast",
    );
    expect(result).toBeNull();
  });
});

describe("normaliseTitle", () => {
  test("lowercases, strips punctuation, drops articles", () => {
    expect(normaliseTitle("The Big Lebowski!")).toBe("big lebowski");
    expect(normaliseTitle("A Clockwork Orange")).toBe("clockwork orange");
    expect(normaliseTitle("WALL-E")).toBe("wall e");
  });

  test("preserves apostrophes and ampersands", () => {
    expect(normaliseTitle("Ferris Bueller's Day Off")).toBe("ferris bueller's day off");
    expect(normaliseTitle("Beavis & Butt-Head")).toBe("beavis & butt head");
  });

  test("strips year and quality suffixes that libraries tag onto folder/item names", () => {
    expect(normaliseTitle("Serenity (2005) 4K")).toBe("serenity");
    expect(normaliseTitle("Serenity (2005)")).toBe("serenity");
    expect(normaliseTitle("Inception (2010) 1080p REMUX")).toBe("inception");
    expect(normaliseTitle("The Matrix (1999) 4K HDR")).toBe("matrix");
    expect(normaliseTitle("Apocalypto (2006) BluRay x265 10bit")).toBe("apocalypto");
    expect(normaliseTitle("1917 (2019) 2160p HDR10Plus")).toBe("1917");
  });

  test("does not obliterate titles that are themselves a year", () => {
    // Year-only fallback: avoid empty strings, return the unfiltered normalised form.
    expect(normaliseTitle("2001")).toBe("2001");
    expect(normaliseTitle("4K")).toBe("4k");
  });
});

describe("findQuoteRequestMatch with quality-suffixed titles", () => {
  test("matches 'Serenity' against indexed 'Serenity (2005) 4K'", () => {
    const serenityCue: QuoteSearchResult = {
      itemId: "ddddddddddddddddddddddddddddddddd",
      itemType: "Movie",
      title: "Serenity (2005) 4K",
      productionYear: 2005,
      startMs: 5_280_000,
      endMs: 5_283_000,
      text: "I am a leaf on the wind.",
      rank: -9.4,
    };

    const result = findQuoteRequestMatch(
      searchIndex([serenityCue]),
      "Serenity",
      "I am a leaf on the wind. Watch me soar!",
    );

    expect(result).not.toBeNull();
    expect(result?.confidence).toBe("high");
    expect(result?.candidate.itemId).toBe(serenityCue.itemId);
  });
});

describe("findQuoteRequestMatch relaxed fallback", () => {
  // Mock that mimics FTS-over-AND: the strict path returns nothing because
  // "me" isn't in the cue text, but a distinctive-tokens-only retry succeeds.
  function strictThenRelaxedIndex(cue: QuoteSearchResult, distinctiveTokens: string[]) {
    return {
      searchQuotes: (query: string): QuoteSearchResult[] => {
        const tokens = query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const matchesEveryToken = tokens.every((t) => cue.text.toLowerCase().includes(t));
        const matchesDistinctiveOnly =
          tokens.length === distinctiveTokens.length &&
          tokens.every((t) => distinctiveTokens.includes(t));
        if (matchesEveryToken || matchesDistinctiveOnly) return [cue];
        return [];
      },
    };
  }

  test("falls back to distinctive tokens when the user misremembers filler words", () => {
    const serenityCue: QuoteSearchResult = {
      itemId: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      itemType: "Movie",
      title: "Serenity",
      productionYear: 2005,
      startMs: 5_154_000,
      endMs: 5_157_000,
      // Real cue has "Watch how I soar" - request says "Watch me soar"
      text: "I am a leaf on the wind. Watch how I soar.",
      rank: -8.4,
    };

    const result = findQuoteRequestMatch(
      strictThenRelaxedIndex(serenityCue, ["leaf", "wind", "watch", "soar"]),
      "Serenity",
      "I am a leaf on the wind. Watch me soar!",
    );

    expect(result).not.toBeNull();
    expect(result?.candidate.itemId).toBe(serenityCue.itemId);
    // Relaxed-search hits are capped at medium confidence even for perfect titles.
    expect(result?.confidence).toBe("medium");
  });

  test("does not fall back when the request has fewer than 2 distinctive tokens", () => {
    const cue: QuoteSearchResult = {
      itemId: "ffffffffffffffffffffffffffffffff",
      itemType: "Movie",
      title: "Whatever",
      productionYear: 2024,
      startMs: 0,
      endMs: 1_000,
      text: "Hello there.",
      rank: -3.0,
    };

    // "yo go" has zero >=4-char tokens; relaxed fallback should bail.
    const result = findQuoteRequestMatch(
      strictThenRelaxedIndex(cue, []),
      "Whatever",
      "yo go",
    );

    expect(result).toBeNull();
  });
});
