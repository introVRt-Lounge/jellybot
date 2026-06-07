import { spawn } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileSizeBytes } from "../ffmpeg.ts";
import type { JellyfinClient } from "../jellyfin.ts";
import type { SupercutCue } from "./finder.ts";

const CLIP_HEIGHT = 480;
const CLIP_FPS = 30;
const VIDEO_CODEC = "libx264";
const VIDEO_PRESET = "veryfast";
const VIDEO_CRF = "26";
const AUDIO_CODEC = "aac";
const AUDIO_BITRATE = "128k";
const AUDIO_SAMPLE_RATE = "48000";
const AUDIO_CHANNELS = "2";
const LOUDNORM = "loudnorm=I=-16:TP=-1.5:LRA=11";

export type RenderSupercutOptions = {
  cues: SupercutCue[];
  jellyfin: Pick<JellyfinClient, "streamUrl">;
  paddingMs: number;
  workDir: string;
  outputPath: string;
  /** Hard ceiling. Render returns ok=false when the final mp4 exceeds this. */
  maxBytes?: number;
  /** Inject a fake spawn for tests. Defaults to node:child_process spawn. */
  spawnImpl?: typeof spawn;
};

export type RenderSupercutResult =
  | {
      ok: true;
      clipsRendered: number;
      sizeBytes: number;
      outputPath: string;
    }
  | {
      ok: false;
      message: string;
    };

/**
 * Render a list of cues into a single concatenated mp4. Each cue is encoded
 * to a canonical 480p H.264 + AAC clip with loudnorm so per-episode codec
 * drift can't trip the concat demuxer. Intermediates are cleaned up on the
 * way out (success or failure).
 */
export async function renderSupercut(
  opts: RenderSupercutOptions,
): Promise<RenderSupercutResult> {
  const spawnFn = opts.spawnImpl ?? spawn;
  if (opts.cues.length === 0) {
    return { ok: false, message: "No cues to render." };
  }

  await mkdir(opts.workDir, { recursive: true });
  await mkdir(dirname(opts.outputPath), { recursive: true });

  const clipPaths: string[] = [];

  try {
    for (let i = 0; i < opts.cues.length; i++) {
      const cue = opts.cues[i]!;
      const startSec = Math.max(0, (cue.startMs - opts.paddingMs) / 1000);
      const durSec = Math.max(0.1, (cue.endMs - cue.startMs + opts.paddingMs * 2) / 1000);
      const clipPath = join(opts.workDir, `${String(i).padStart(3, "0")}.mp4`);
      const url = opts.jellyfin.streamUrl(cue.itemId);
      await runFfmpeg(spawnFn, buildClipArgs({ inputUrl: url, startSec, durSec, outputPath: clipPath }));
      clipPaths.push(clipPath);
    }

    const concatList = join(opts.workDir, "concat.txt");
    await writeFile(concatList, clipPaths.map((p) => `file '${p.replace(/'/g, "'\\''")}'`).join("\n"));

    await runFfmpeg(
      spawnFn,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        concatList,
        "-c",
        "copy",
        "-movflags",
        "+faststart",
        opts.outputPath,
      ],
    );

    const sizeBytes = await fileSizeBytes(opts.outputPath);
    if (opts.maxBytes !== undefined && sizeBytes > opts.maxBytes) {
      await rm(opts.outputPath, { force: true });
      return {
        ok: false,
        message: `Supercut is ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB, above the upload cap.`,
      };
    }

    return { ok: true, clipsRendered: clipPaths.length, sizeBytes, outputPath: opts.outputPath };
  } catch (error) {
    await rm(opts.outputPath, { force: true });
    return {
      ok: false,
      message: `Supercut render failed: ${error instanceof Error ? error.message : "unknown error"}`,
    };
  } finally {
    await rm(opts.workDir, { recursive: true, force: true });
  }
}

export function buildClipArgs(params: {
  inputUrl: string;
  startSec: number;
  durSec: number;
  outputPath: string;
}): string[] {
  return [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-ss",
    params.startSec.toFixed(3),
    "-t",
    params.durSec.toFixed(3),
    "-i",
    params.inputUrl,
    "-vf",
    `scale=-2:${CLIP_HEIGHT}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2,fps=${CLIP_FPS}`,
    "-af",
    LOUDNORM,
    "-c:v",
    VIDEO_CODEC,
    "-preset",
    VIDEO_PRESET,
    "-crf",
    VIDEO_CRF,
    "-pix_fmt",
    "yuv420p",
    "-profile:v",
    "main",
    "-level",
    "4.0",
    "-c:a",
    AUDIO_CODEC,
    "-b:a",
    AUDIO_BITRATE,
    "-ar",
    AUDIO_SAMPLE_RATE,
    "-ac",
    AUDIO_CHANNELS,
    "-movflags",
    "+faststart",
    params.outputPath,
  ];
}

function runFfmpeg(spawnImpl: typeof spawn, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += typeof chunk === "string" ? chunk : chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
    });
  });
}
