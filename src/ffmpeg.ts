import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";

export type ClipOptions = {
  inputUrl: string;
  startSeconds: number;
  durationSeconds: number;
  outputPath: string;
  maxHeight?: number;
};

export async function createClip(options: ClipOptions): Promise<void> {
  await mkdir(dirname(options.outputPath), { recursive: true });

  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-ss",
    String(options.startSeconds),
    "-i",
    options.inputUrl,
    "-t",
    String(options.durationSeconds),
    "-map",
    "0:v:0?",
    "-map",
    "0:a:0?",
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-crf",
    "28",
    "-vf",
    `scale=-2:${options.maxHeight ?? 720}:force_original_aspect_ratio=decrease`,
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    "-movflags",
    "+faststart",
    "-y",
    options.outputPath,
  ];

  await runFfmpeg(args);
}

async function runFfmpeg(args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}

export async function fileSizeMb(path: string): Promise<number> {
  const info = await stat(path);
  return info.size / (1024 * 1024);
}

export async function cleanup(path: string): Promise<void> {
  await rm(path, { force: true });
}
