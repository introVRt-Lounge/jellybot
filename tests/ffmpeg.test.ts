import { describe, expect, test } from "bun:test";
import { buildAudioEncodeArgs } from "../src/ffmpeg.ts";

describe("buildAudioEncodeArgs", () => {
  test("downmixes surround to stereo at 48 kHz", () => {
    expect(buildAudioEncodeArgs()).toEqual(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"]);
  });
});
