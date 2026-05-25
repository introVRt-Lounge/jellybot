import { describe, expect, test } from "bun:test";
import { buildAudioEncodeArgs, buildClipFfmpegArgs } from "../src/ffmpeg.ts";

describe("buildAudioEncodeArgs", () => {
  test("downmixes surround to stereo at 48 kHz", () => {
    expect(buildAudioEncodeArgs()).toEqual(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"]);
  });
});

describe("buildClipFfmpegArgs", () => {
  test("maps explicit Jellyfin audio stream index", () => {
    const args = buildClipFfmpegArgs({
      inputUrl: "http://jellyfin/stream",
      startSeconds: 10,
      durationSeconds: 15,
      outputPath: "/tmp/out.mp4",
      audioStreamIndex: 3,
    });

    expect(args).toContain("-map");
    expect(args).toContain("0:3?");
    expect(args).not.toContain("0:a:0?");
  });

  test("adds subtitles filter when burn-in sidecar is provided", () => {
    const args = buildClipFfmpegArgs({
      inputUrl: "http://jellyfin/stream",
      startSeconds: 0,
      durationSeconds: 5,
      outputPath: "/tmp/out.mp4",
      subtitlePath: "/tmp/clip-subs.srt",
    });

    const vfIndex = args.indexOf("-vf");
    expect(vfIndex).toBeGreaterThan(-1);
    expect(args[vfIndex + 1]).toContain("subtitles=");
    expect(args[vfIndex + 1]).toContain("clip-subs.srt");
  });
});
