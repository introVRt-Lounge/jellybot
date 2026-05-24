import { describe, expect, test } from "bun:test";
import { parseTvMediaQuery } from "../src/tv-query.ts";

describe("parseTvMediaQuery", () => {
  test("parses s03e03 with series text", () => {
    expect(parseTvMediaQuery("spitting image s03e03")).toEqual({
      seriesText: "spitting image",
      seasonNumber: 3,
      episodeNumber: 3,
    });
  });

  test("parses compact season episode tokens", () => {
    expect(parseTvMediaQuery("office s2e5")).toEqual({
      seriesText: "office",
      seasonNumber: 2,
      episodeNumber: 5,
    });
  });

  test("parses 3x03 format", () => {
    expect(parseTvMediaQuery("spitt 3x03")).toEqual({
      seriesText: "spitt",
      seasonNumber: 3,
      episodeNumber: 3,
    });
  });

  test("parses season-only hints", () => {
    expect(parseTvMediaQuery("spitting image s03")).toEqual({
      seriesText: "spitting image",
      seasonNumber: 3,
    });
  });

  test("leaves plain show queries untouched", () => {
    expect(parseTvMediaQuery("spitting image")).toEqual({
      seriesText: "spitting image",
    });
  });
});
