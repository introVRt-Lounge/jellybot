import { describe, expect, test } from "bun:test";
import { buildAudioEncodeArgs, buildClipFfmpegArgs, resolveAudioMapSpec } from "../src/ffmpeg.ts";

describe("buildAudioEncodeArgs", () => {
  test("downmixes surround to stereo at 48 kHz", () => {
    expect(buildAudioEncodeArgs()).toEqual(["-c:a", "aac", "-ac", "2", "-ar", "48000", "-b:a", "192k"]);
  });
});

describe("resolveAudioMapSpec", () => {
  test("uses container stream index when Jellyfin audio index exists in file", () => {
    const map = resolveAudioMapSpec(
      [
        { index: 0, codec_type: "video" },
        { index: 1, codec_type: "audio" },
        { index: 2, codec_type: "subtitle" },
        { index: 3, codec_type: "audio" },
      ],
      3,
    );
    expect(map).toBe("0:3?");
  });

  test("falls back to first audio when index missing (remuxed Jellyfin stream)", () => {
    const map = resolveAudioMapSpec(
      [
        { index: 0, codec_type: "video" },
        { index: 1, codec_type: "audio" },
      ],
      3,
    );
    expect(map).toBe("0:a:0?");
  });
});

describe("buildClipFfmpegArgs", () => {
  test("maps resolved audio spec when provided", () => {
    const args = buildClipFfmpegArgs({
      inputUrl: "http://jellyfin/stream",
      startSeconds: 10,
      durationSeconds: 15,
      outputPath: "/tmp/out.mp4",
      audioMapSpec: "0:3?",
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

  test("adds watermark overlay filter when watermark PNG is provided", () => {
    const args = buildClipFfmpegArgs({
      inputUrl: "http://jellyfin/stream",
      startSeconds: 0,
      durationSeconds: 5,
      outputPath: "/tmp/out.mp4",
      watermarkPath: "/app/assets/introvrt-lounge-discord-watermark-transparent.png",
    });

    expect(args).toContain("-filter_complex");
    expect(args.join(" ")).toContain("overlay=main_w-overlay_w-10:10");
    expect(args).toContain("[outv]");
    expect(args).toContain("/app/assets/introvrt-lounge-discord-watermark-transparent.png");
  });
});
