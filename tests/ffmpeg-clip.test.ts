import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { createClip, fileSizeMb, cleanup } from "../src/ffmpeg.ts";

const TMP_DIR = join(import.meta.dir, ".tmp-ffmpeg-clip");
const SOURCE_PATH = join(TMP_DIR, "source.mp4");
const CLIP_PATH = join(TMP_DIR, "clip.mp4");

function generateTestVideo(outputPath: string, durationSec = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", [
      "-f", "lavfi", "-i", `testsrc=duration=${durationSec}:size=320x240:rate=24`,
      "-f", "lavfi", "-i", `sine=frequency=440:duration=${durationSec}`,
      "-c:v", "libx264", "-profile:v", "main", "-pix_fmt", "yuv420p",
      "-c:a", "aac", "-shortest", "-y", outputPath,
    ], { stdio: ["ignore", "pipe", "pipe"] });

    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

describe("createClip (integration)", () => {
  beforeAll(async () => {
    await mkdir(TMP_DIR, { recursive: true });
    await generateTestVideo(SOURCE_PATH);
  });

  afterAll(async () => {
    await rm(TMP_DIR, { recursive: true, force: true });
  });

  test("clips a segment from a local file", async () => {
    await createClip({
      inputUrl: SOURCE_PATH,
      startSeconds: 0.5,
      durationSeconds: 1.5,
      outputPath: CLIP_PATH,
    });

    const info = await stat(CLIP_PATH);
    expect(info.size).toBeGreaterThan(0);

    const mb = await fileSizeMb(CLIP_PATH);
    expect(mb).toBeLessThan(1);
  });

  test("cleanup removes the clip file", async () => {
    await createClip({
      inputUrl: SOURCE_PATH,
      startSeconds: 0,
      durationSeconds: 1,
      outputPath: CLIP_PATH,
    });

    await cleanup(CLIP_PATH);
    await expect(stat(CLIP_PATH)).rejects.toThrow();
  });
});
