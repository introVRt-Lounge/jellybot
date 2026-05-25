import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanup, createClip, fileSizeMb } from "../src/ffmpeg.ts";

let tmpDir = "";
let sourcePath = "";
let clipPath = "";

function generateTestVideo(outputPath: string, durationSec = 3): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffmpeg",
      [
        "-f",
        "lavfi",
        "-i",
        `testsrc=duration=${durationSec}:size=320x240:rate=24`,
        "-f",
        "lavfi",
        "-i",
        `sine=frequency=440:duration=${durationSec}`,
        "-c:v",
        "libx264",
        "-profile:v",
        "main",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-shortest",
        "-y",
        outputPath,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    child.on("error", reject);
    child.on("close", (code) => {
      code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

describe("createClip (integration)", () => {
  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "jellybot-ffmpeg-clip-"));
    sourcePath = join(tmpDir, "source.mp4");
    clipPath = join(tmpDir, "clip.mp4");
    await generateTestVideo(sourcePath);
  });

  afterAll(async () => {
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  test("clips a segment from a local file", async () => {
    await createClip({
      inputUrl: sourcePath,
      startSeconds: 0.5,
      durationSeconds: 1.5,
      outputPath: clipPath,
    });

    const info = await stat(clipPath);
    expect(info.size).toBeGreaterThan(0);

    const mb = await fileSizeMb(clipPath);
    expect(mb).toBeLessThan(1);
  });

  test("cleanup removes the clip file", async () => {
    await createClip({
      inputUrl: sourcePath,
      startSeconds: 0,
      durationSeconds: 1,
      outputPath: clipPath,
    });

    await cleanup(clipPath);
    await expect(stat(clipPath)).rejects.toThrow();
  });
});
