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

// #136: short user input vs long indexed series name should match.
// The matcher previously rejected "Buffy" against series_name="Buffy the
// Vampire Slayer" because the character ratio (5/20 = 0.25) sits below the
// 0.55 threshold even though the user input is a strict subset of the
// series tokens.
describe("findQuoteRequestMatch substring containment (#136)", () => {
  const buffyCue: QuoteSearchResult = {
    itemId: "11111111111111111111111111111111",
    itemType: "Episode",
    title: "The Harsh Light of Day",
    seriesName: "Buffy the Vampire Slayer",
    seasonNumber: 4,
    episodeNumber: 3,
    startMs: 1_166_041,
    endMs: 1_167_835,
    text: "you're funny, and you're nicely shaped",
    rank: -7.2,
  };

  test("Buffy (5 chars) matches series_name Buffy the Vampire Slayer (24)", () => {
    const result = findQuoteRequestMatch(
      searchIndex([buffyCue]),
      "Buffy",
      "you're funny, and you're nicely shaped",
    );
    expect(result).not.toBeNull();
    expect(["medium", "high"]).toContain(result!.confidence);
    expect(result!.candidate.itemId).toBe(buffyCue.itemId);
  });

  test("does not lift unrelated single-word matches", () => {
    // "you" is in the cue and shows up in lots of titles, but it's only 3
    // chars (no distinctive anchor) so the substring floor must NOT fire.
    const cue: QuoteSearchResult = {
      itemId: "22222222222222222222222222222222",
      itemType: "Movie",
      title: "You've Got Mail",
      productionYear: 1998,
      startMs: 0,
      endMs: 1_000,
      text: "you've got mail",
      rank: -5,
    };
    const result = findQuoteRequestMatch(searchIndex([cue]), "you", "got mail");
    // "you" has no >=4-char distinctive token; substring floor must not
    // engage. Without the floor the score is 3/14 = 0.21, below threshold.
    expect(result).toBeNull();
  });

  test("a different show name still gets rejected", () => {
    // "Angel" (the spinoff) shouldn't claim Buffy episodes via tokens.
    const result = findQuoteRequestMatch(
      searchIndex([buffyCue]),
      "Angel",
      "you're funny, and you're nicely shaped",
    );
    expect(result).toBeNull();
  });
});

// #137: long monologues split across 3+ SRT cues. The merged-window from
// #130 only joins adjacent pairs, so a 5-cue Spike monologue can't match
// via either strict or relaxed FTS. Anchor fallback uses the first 4
// distinctive tokens to find where the dialogue starts.
describe("findQuoteRequestMatch anchor fallback (#137)", () => {
  function tieredIndex(
    cue: QuoteSearchResult,
    distinctiveSubset: string[],
    anchorSubset: string[],
  ) {
    return {
      searchQuotes: (query: string): QuoteSearchResult[] => {
        const tokens = query
          .toLowerCase()
          .split(/[^a-z0-9]+/)
          .filter(Boolean);
        const cueText = cue.text.toLowerCase();
        const matchesEveryToken = tokens.every((t) => cueText.includes(t));
        const matchesDistinctive =
          tokens.length === distinctiveSubset.length &&
          tokens.every((t) => distinctiveSubset.includes(t));
        const matchesAnchor =
          tokens.length === anchorSubset.length &&
          tokens.every((t) => anchorSubset.includes(t));
        if (matchesEveryToken || matchesDistinctive || matchesAnchor) {
          return [cue];
        }
        return [];
      },
    };
  }

  test("matches the Buffy monologue when only the first 4 distinctive tokens hit a cue", () => {
    // The cue holds the 2-cue merged window for "I like you. You're funny,
    // and you're nicely shaped," but the user's full quote spans 5 cues
    // including "Please remove your clothing now." that no merged row has.
    // Strict and relaxed both empty; anchor on the first 4 distinctive
    // tokens of the user's quote ("like", "your", "funny", "nicely") hits.
    const monologueCue: QuoteSearchResult = {
      itemId: "33333333333333333333333333333333",
      itemType: "Episode",
      title: "The Harsh Light of Day",
      seriesName: "Buffy the Vampire Slayer",
      seasonNumber: 4,
      episodeNumber: 3,
      startMs: 1_164_414,
      endMs: 1_167_835,
      text: "I like you. You're funny, and you're nicely shaped,",
      rank: -6.0,
    };

    const result = findQuoteRequestMatch(
      tieredIndex(
        monologueCue,
        // distinctive >=4-char tokens of the quote (relaxed tier)
        [
          "like",
          "your",
          "funny",
          "nicely",
          "shaped",
          "frankly",
          "ludicrous",
          "have",
          "these",
          "interlocking",
          "bodies",
          "interlock",
          "please",
          "remove",
          "clothing",
        ],
        // first 4 distinctive tokens (anchor tier)
        ["like", "your", "funny", "nicely"],
      ),
      "Buffy",
      "I like you. You're funny, and you're nicely shaped, and frankly, it's ludicrous to have these interlocking bodies and not... interlock... Please remove your clothing now.",
    );

    expect(result).not.toBeNull();
    expect(result!.candidate.itemId).toBe(monologueCue.itemId);
    // Anchor fallback must never claim "high" confidence.
    expect(result!.confidence).toBe("medium");
  });

  test("does not return anything when even the anchor doesn't match", () => {
    const cue: QuoteSearchResult = {
      itemId: "44444444444444444444444444444444",
      itemType: "Movie",
      title: "Some Movie",
      productionYear: 2020,
      startMs: 0,
      endMs: 1_000,
      text: "completely unrelated dialogue",
      rank: -3,
    };
    // None of the search tiers hit. Anchor must still bail to null.
    const result = findQuoteRequestMatch(
      {
        searchQuotes: () => [],
      },
      "Some Movie",
      "interlocking bodies clothing remove",
    );
    expect(result).toBeNull();
    void cue;
  });

  test("anchor does not fire when distinctive token count is at or below the anchor count", () => {
    // distinctive.length must be STRICTLY GREATER THAN ANCHOR_TOKEN_COUNT
    // (4) for the anchor tier to run. With exactly 4 distinctive tokens,
    // anchor would just duplicate the relaxed query so it skips.
    const calls: string[] = [];
    const cue: QuoteSearchResult = {
      itemId: "55555555555555555555555555555555",
      itemType: "Movie",
      title: "Some Movie",
      productionYear: 2020,
      startMs: 0,
      endMs: 1_000,
      text: "no overlap text",
      rank: -3,
    };
    const result = findQuoteRequestMatch(
      {
        searchQuotes: (q: string) => {
          calls.push(q);
          return [];
        },
      },
      "Some Movie",
      "alpha beta gamma delta", // exactly 4 distinctive tokens
    );
    expect(result).toBeNull();
    // Strict (the full quote) + relaxed (the 4 distinctive tokens). NOT 3.
    expect(calls).toHaveLength(2);
    void cue;
  });
});
