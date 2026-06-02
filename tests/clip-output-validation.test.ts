import { describe, expect, test } from "bun:test";
import { MIN_CLIP_BYTES, validateRenderedClip } from "../src/ffmpeg.ts";

describe("validateRenderedClip", () => {
  test("rejects empty mp4 (the 860-byte ffmpeg-no-packets case)", () => {
    const result = validateRenderedClip({ sizeBytes: 860, videoFrames: 0 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("tiny_file");
    expect(result.stats.sizeBytes).toBe(860);
  });

  test("rejects anything below the size floor", () => {
    const result = validateRenderedClip({ sizeBytes: MIN_CLIP_BYTES - 1, videoFrames: 30 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("tiny_file");
  });

  test("rejects sized files with zero video frames decoded", () => {
    const result = validateRenderedClip({
      sizeBytes: MIN_CLIP_BYTES * 4,
      videoFrames: 0,
      audioFrames: 100,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("no_video");
  });

  test("accepts a real-looking clip", () => {
    const result = validateRenderedClip({
      sizeBytes: 250_000,
      videoFrames: 360,
      audioFrames: 700,
    });
    expect(result.ok).toBe(true);
  });

  test("size floor is exactly inclusive", () => {
    expect(validateRenderedClip({ sizeBytes: MIN_CLIP_BYTES, videoFrames: 1 }).ok).toBe(true);
  });
});
