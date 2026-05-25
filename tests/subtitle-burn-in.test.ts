import { describe, expect, test } from "bun:test";
import { formatSrtTimestamp, renderSrt, shiftCuesForClip } from "../src/subtitles/burn-in.ts";

describe("shiftCuesForClip", () => {
  test("keeps overlapping cues and shifts timestamps to clip start", () => {
    const shifted = shiftCuesForClip(
      [
        { startSeconds: 8, endSeconds: 10, text: "before" },
        { startSeconds: 12, endSeconds: 15, text: "inside" },
        { startSeconds: 20, endSeconds: 22, text: "after" },
      ],
      10,
      18,
    );

    expect(shifted).toEqual([{ startSeconds: 2, endSeconds: 5, text: "inside" }]);
  });
});

describe("renderSrt", () => {
  test("writes valid srt blocks", () => {
    const srt = renderSrt([{ startSeconds: 1.5, endSeconds: 3.25, text: "Hello there" }]);
    expect(srt).toContain("1\n");
    expect(srt).toContain(`${formatSrtTimestamp(1.5)} --> ${formatSrtTimestamp(3.25)}`);
    expect(srt).toContain("Hello there");
  });
});
