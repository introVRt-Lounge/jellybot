import { describe, expect, test } from "bun:test";
import {
  encodeQuoteFromToken,
  encodeQuoteFromSeriesToken,
  formatQuoteFromLabel,
  parseQuoteFromToken,
  quoteFromScopeCacheKey,
  type QuoteSearchScope,
} from "../src/subtitles/quote-scope.ts";

describe("quote from scope tokens", () => {
  test("round-trips series and movie tokens", () => {
    const series: QuoteSearchScope = { kind: "series", seriesName: "The IT Crowd" };
    const movie: QuoteSearchScope = {
      kind: "movie",
      itemId: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    };

    expect(parseQuoteFromToken(encodeQuoteFromToken(series))).toEqual(series);
    expect(parseQuoteFromToken(encodeQuoteFromToken(movie))).toEqual(movie);
  });

  test("uses se:itemId when series name exceeds Discord choice limit", () => {
    const longName = "X".repeat(120);
    const sampleId = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const token = encodeQuoteFromSeriesToken(longName, sampleId);
    expect(token).toBe(`se:${sampleId}`);
    expect(parseQuoteFromToken(token)).toEqual({ kind: "seriesByItem", itemId: sampleId });
    // `se:` must not be parsed as a truncated `s:` name.
    expect(parseQuoteFromToken(token)?.kind).not.toBe("series");
  });

  test("rejects bare names and malformed movie ids", () => {
    expect(parseQuoteFromToken("The IT Crowd")).toBeNull();
    expect(parseQuoteFromToken("s:")).toBeNull();
    expect(parseQuoteFromToken("m:not-an-id")).toBeNull();
    expect(parseQuoteFromToken("m:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbff")).toBeNull();
  });

  test("formats Discord labels under 100 chars", () => {
    expect(formatQuoteFromLabel({ kind: "series", seriesName: "Archer" })).toBe("TV · Archer");
    expect(
      formatQuoteFromLabel({
        kind: "movie",
        title: "Heartwarming",
        productionYear: 2020,
      }),
    ).toBe("Movie · Heartwarming (2020)");
    expect(
      formatQuoteFromLabel({
        kind: "movie",
        title: "Heartwarming",
      }),
    ).toBe("Movie · Heartwarming");

    const long = "X".repeat(200);
    expect(formatQuoteFromLabel({ kind: "series", seriesName: long }).length).toBeLessThanOrEqual(100);
  });

  test("cache key distinguishes movie vs series vs unset", () => {
    expect(quoteFromScopeCacheKey(undefined)).toBe("");
    expect(
      quoteFromScopeCacheKey({ kind: "series", seriesName: "The IT Crowd" }),
    ).toBe("s:the it crowd");
    expect(
      quoteFromScopeCacheKey({
        kind: "movie",
        itemId: "BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
      }),
    ).toBe("m:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
  });
});
