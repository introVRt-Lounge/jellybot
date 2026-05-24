import { describe, expect, test } from "bun:test";
import { normalizeCueText, parseSubtitleContent } from "../src/subtitles/parse.ts";

describe("normalizeCueText", () => {
  test("strips html and collapses whitespace", () => {
    expect(normalizeCueText("<i>Hello   world</i>")).toBe("Hello world");
  });
});

describe("parseSubtitleContent", () => {
  test("parses webvtt cues", () => {
    const cues = parseSubtitleContent(
      `WEBVTT

00:00:22.931 --> 00:00:26.711
<i>Does love happen by chance or choice?</i>`,
    );

    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe("Does love happen by chance or choice?");
    expect(cues[0]?.startSeconds).toBeCloseTo(22.931);
  });

  test("parses srt cues", () => {
    const cues = parseSubtitleContent(
      `1
00:00:01,000 --> 00:00:04,000
Hello there`,
      "srt",
    );

    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe("Hello there");
    expect(cues[0]?.endSeconds).toBe(4);
  });
});
