import { describe, expect, test } from "bun:test";
import { quoteCommand } from "../src/commands/quote.ts";
import { encodeQuoteMatchToken, parseQuoteMatchToken } from "../src/subtitles/match-token.ts";

describe("quote command contract", () => {
  const json = quoteCommand.toJSON();

  test("uses expected command name", () => {
    expect(json.name).toBe("quote");
  });

  test("declares match before from (Discord requires required options first)", () => {
    const names = json.options?.map((option) => option.name);
    expect(names).toEqual(["match", "from", "duration", "padding", "subtitles"]);
  });

  test("match is required; from is optional with autocomplete (issue #202)", () => {
    const match = json.options?.find((option) => option.name === "match");
    const from = json.options?.find((option) => option.name === "from");
    expect(match?.autocomplete).toBe(true);
    expect(match?.required).toBe(true);
    expect(from?.autocomplete).toBe(true);
    expect(from?.required).toBe(false);
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
