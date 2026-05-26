import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { mkdir, rm, stat } from "node:fs/promises";

const DEFAULT_MAX_HEIGHT = 480;
const DEFAULT_VIDEO_CODEC = "libx264";
const DEFAULT_VIDEO_PRESET = "veryfast";
const DEFAULT_VIDEO_CRF = "30";
const DEFAULT_AUDIO_CODEC = "aac";
const DEFAULT_AUDIO_CHANNELS = "2";
const DEFAULT_AUDIO_SAMPLE_RATE = "48000";
const DEFAULT_AUDIO_BITRATE = "192k";

export function buildAudioEncodeArgs(): string[] {
  return [
    "-c:a",
    DEFAULT_AUDIO_CODEC,
    "-ac",
    DEFAULT_AUDIO_CHANNELS,
    "-ar",
    DEFAULT_AUDIO_SAMPLE_RATE,
    "-b:a",
    DEFAULT_AUDIO_BITRATE,
  ];
}

export type ProbedStream = {
  index: number;
  codec_type: string;
};

export type ClipOptions = {
  inputUrl: string;
  startSeconds: number;
  durationSeconds: number;
  outputPath: string;
  maxHeight?: number;
  videoCodec?: string;
  /** Jellyfin MediaStream index; used with ffprobe to pick the correct ffmpeg -map. */
  audioStreamIndex?: number;
  /** Resolved ffmpeg stream map (e.g. `0:3?` or `0:a:0?`). Overrides audioStreamIndex when set. */
  audioMapSpec?: string;
  subtitlePath?: string;
};

/** Pick ffmpeg audio map: container index when present, else first audio (remuxed Jellyfin stream). */
export function resolveAudioMapSpec(
  streams: ProbedStream[],
  jellyfinAudioStreamIndex?: number,
): string {
  if (jellyfinAudioStreamIndex !== undefined) {
    const atIndex = streams.find(
      (stream) => stream.index === jellyfinAudioStreamIndex && stream.codec_type === "audio",
    );
    if (atIndex) {
      return `0:${jellyfinAudioStreamIndex}?`;
    }
  }

  return "0:a:0?";
}

function buildVideoFilter(maxHeight: number, subtitlePath?: string): string {
  let filter = `scale=-2:${maxHeight}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
  if (subtitlePath) {
    filter = `${filter},subtitles=${escapeFfmpegFilterPath(subtitlePath)}`;
  }
  return filter;
}

function escapeFfmpegFilterPath(path: string): string {
  const escaped = path.replace(/\\/g, "\\\\").replace(/:/g, "\\:").replace(/'/g, "'\\''");
  return `'${escaped}'`;
}

function buildVideoEncodeArgs(videoCodec: string, maxHeight: number, subtitlePath?: string): string[] {
  const args = [
    "-c:v",
    videoCodec,
    "-preset",
    DEFAULT_VIDEO_PRESET,
    "-crf",
    DEFAULT_VIDEO_CRF,
    "-vf",
    buildVideoFilter(maxHeight, subtitlePath),
    "-pix_fmt",
    "yuv420p",
  ];

  if (videoCodec === "libx264") {
    args.push("-profile:v", "main", "-level", "4.0");
  }

  if (videoCodec === "libx265") {
    args.push("-tag:v", "hvc1");
  }

  return args;
}

export function buildClipFfmpegArgs(options: ClipOptions): string[] {
  const videoCodec = options.videoCodec ?? DEFAULT_VIDEO_CODEC;
  const maxHeight = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
  const audioMapSpec =
    options.audioMapSpec ??
    (options.audioStreamIndex !== undefined ? `0:${options.audioStreamIndex}?` : "0:a:0?");
  const audioMap = ["-map", audioMapSpec];

  return [
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
    ...audioMap,
    ...buildVideoEncodeArgs(videoCodec, maxHeight, options.subtitlePath),
    ...buildAudioEncodeArgs(),
    "-movflags",
    "+faststart",
    "-y",
    options.outputPath,
  ];
}

async function probeInputStreams(inputUrl: string): Promise<ProbedStream[]> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "ffprobe",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-show_entries",
        "stream=index,codec_type",
        "-of",
        "json",
        inputUrl,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `ffprobe exited with code ${code}`));
        return;
      }

      try {
        const parsed = JSON.parse(stdout) as { streams?: ProbedStream[] };
        resolve(parsed.streams ?? []);
      } catch (error) {
        reject(error instanceof Error ? error : new Error("Failed to parse ffprobe output."));
      }
    });
  });
}

export async function createClip(options: ClipOptions): Promise<void> {
  await mkdir(dirname(options.outputPath), { recursive: true });

  let audioMapSpec = options.audioMapSpec;
  if (!audioMapSpec && options.audioStreamIndex !== undefined) {
    try {
      const streams = await probeInputStreams(options.inputUrl);
      audioMapSpec = resolveAudioMapSpec(streams, options.audioStreamIndex);
    } catch {
      // Jellyfin may serve a remuxed stream where only 0:a:0 exists; URL AudioStreamIndex still applies.
      audioMapSpec = "0:a:0?";
    }
  }

  await runFfmpeg(buildClipFfmpegArgs({ ...options, audioMapSpec }));
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
