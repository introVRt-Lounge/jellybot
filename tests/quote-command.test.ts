import { describe, expect, test } from "bun:test";
import { quoteCommand } from "../src/commands/quote.ts";
import { encodeQuoteMatchToken, parseQuoteMatchToken } from "../src/subtitles/match-token.ts";

describe("quote command contract", () => {
  const json = quoteCommand.toJSON();

  test("uses expected command name", () => {
    expect(json.name).toBe("quote");
  });

  test("declares match, series, duration, padding, subtitles options", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["match", "series", "duration", "padding", "subtitles"]);
  });

  test("uses autocomplete on match", () => {
    const match = json.options?.find((option) => option.name === "match");
    expect(match?.autocomplete).toBe(true);
    expect(match?.required).toBe(true);
  });

  test("series option is optional with autocomplete (issue #152)", () => {
    const series = json.options?.find((option) => option.name === "series");
    expect(series?.autocomplete).toBe(true);
    expect(series?.required).toBe(false);
  });
});

describe("quote match token", () => {
  test("round trips item and cue timestamps", () => {
    const token = encodeQuoteMatchToken({
      itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startMs: 30000,
      endMs: 34576,
    });

    expect(parseQuoteMatchToken(token)).toEqual({
      itemId: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      startMs: 30000,
      endMs: 34576,
    });
  });
});
